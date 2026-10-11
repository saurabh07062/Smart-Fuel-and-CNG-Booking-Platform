/**
 * The vendor API's own validation, through the real app.
 *
 * The point of these is that the FORM is not the guarantee: every request
 * here goes straight to the endpoint, the way curl or a script would, and
 * must be refused with a message naming the field.
 *
 * DEVELOPMENT TEST DATA, test database only: tagged vendors, removed at the end.
 *
 *   node --test test/vendorValidation.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const testDb = require("./helpers/testDb");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("vendor registration refuses invalid input at the API", async (t) => {
  try {
    await mongoose.connect(testDb.uri(), { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }
  testDb.isolateRedis();

  const User = require("../src/models/User");
  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const tag = `vval-${Date.now()}`;

  const good = {
    name: "Asha Kale",
    email: `${tag}@example.com`,
    password: "Vendor@12345",
    confirmPassword: "Vendor@12345",
    businessName: "Kale Fuels",
    phone: "9876543210",
    vendorAddress: "Nagar Road, Wagholi, Pune 412207",
    products: "petrol",
  };
  const register = async (patch) => {
    const res = await fetch(`${base}/api/vendors/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...good, ...patch }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  try {
    await t.test("each field is checked, and the reply says which", async () => {
      const cases = [
        [{ phone: "12345" }, "phone", /exactly 10 digits/],
        [{ phone: "1234567890" }, "phone", /6, 7, 8 or 9/],
        [{ phone: "" }, "phone", /required/i],
        [{ password: "short" }, "password", /at least 8/],
        [{ password: "Vendor@12345", confirmPassword: "Vendor@1234" }, "confirmPassword", /do not match/],
        [{ name: "   " }, "name", /required/i],
        [{ name: "aaaa" }, "name", /real/i],
        [{ businessName: "<script>x</script>" }, "businessName", /may only contain/i],
        [{ gstNumber: "NOTAGST" }, "gstNumber", /15 characters|not a valid GST/],
        [{ vendorAddress: "Pune" }, "vendorAddress", /too short/],
        [{ email: "not-an-email" }, "email", /valid email/i],
      ];
      for (const [patch, field, msg] of cases) {
        const r = await register(patch);
        assert.equal(r.status, 400, `${field}: ${JSON.stringify(patch)} -> ${JSON.stringify(r.body)}`);
        assert.equal(r.body.field, field, JSON.stringify(r.body));
        assert.match(r.body.msg, msg);
      }
      assert.equal(await User.countDocuments({ email: good.email }), 0, "nothing invalid was written");
    });

    await t.test("a valid application is accepted, and normalised on the way in", async () => {
      const r = await register({ phone: "+91 98765 43210", name: "  Asha   Kale ", gstNumber: "27abcde1234f1z5" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const saved = await User.findOne({ email: good.email }).lean();
      assert.equal(saved.phone, "9876543210", "stored as ten bare digits");
      assert.equal(saved.name, "Asha Kale", "collapsed whitespace");
      assert.equal(saved.gstNumber, "27ABCDE1234F1Z5", "upper-cased");
      assert.equal(saved.vendorStatus, "pending");
    });

    await t.test("the same phone number cannot register twice", async () => {
      const r = await register({ email: `${tag}-2@example.com`, phone: "9876543210" });
      assert.equal(r.status, 400);
      assert.equal(r.body.field, "phone");
      assert.match(r.body.msg, /already registered/i);
    });
  } finally {
    await User.deleteMany({ email: { $regex: `^${tag}` } });
    server.close();
    await mongoose.disconnect();
  }
});
