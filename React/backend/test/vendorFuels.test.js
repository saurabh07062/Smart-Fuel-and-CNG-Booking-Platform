/**
 * The fuels a vendor sells, end to end through the real app: chosen at
 * registration (required, stored), returned on login, enforced when the
 * vendor adds a station, and editable from the profile.
 *
 * DEVELOPMENT TEST DATA, test database only: tagged vendors and stations,
 * removed at the end.
 *
 *   node --test test/vendorFuels.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const testDb = require("./helpers/testDb");
const { parseVendorFuels, vendorFuelsOf } = require("../src/services/vendor/vendorFuels");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("parseVendorFuels / vendorFuelsOf", () => {
  assert.deepEqual(parseVendorFuels("diesel,petrol").fuels, ["petrol", "diesel"]);
  assert.deepEqual(parseVendorFuels(["CNG", "Petrol", "petrol"]).fuels, ["petrol", "cng"]);
  assert.deepEqual(parseVendorFuels('["diesel"]').fuels, ["diesel"]);
  assert.ok(parseVendorFuels("ev_charging").error, "EV charging alone is not a bookable fuel");
  assert.ok(parseVendorFuels("").error);
  assert.ok(parseVendorFuels(undefined).error);
  assert.deepEqual(vendorFuelsOf({ vendorFuelTypes: ["cng"] }), ["cng"]);
  assert.deepEqual(vendorFuelsOf({}), ["petrol", "diesel", "cng"], "older vendors keep every fuel");
});

test("vendor fuels against MongoDB", async (t) => {
  const MONGO = testDb.uri();
  testDb.isolateRedis();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const jwt = require("jsonwebtoken");
  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const InventoryMovement = require("../src/models/InventoryMovement");
  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const tag = `vfuels-${Date.now()}`;
  const tokenFor = (id) =>
    jwt.sign({ user: { id: String(id) } }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "30m" });
  const call = async (method, route, { token, body } = {}) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { "x-auth-token": token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const register = (suffix, products) =>
    call("POST", "/api/vendors/register", {
      body: {
        name: `${tag}-${suffix}`,
        email: `${tag}-${suffix}@example.com`,
        password: "Vendor@12345",
        businessName: `${tag} ${suffix}`,
        phone: "9000000000",
        vendorAddress: "Fuel Road, Pune",
        ...(products === undefined ? {} : { products }),
      },
    });
  const approve = (suffix) =>
    User.findOneAndUpdate(
      { email: `${tag}-${suffix}@example.com` },
      { $set: { vendorStatus: "active", activated: true } },
      { returnDocument: "after" },
    );

  try {
    await t.test("registration without a supported fuel is refused and nothing is created", async () => {
      for (const [suffix, products] of [["none", undefined], ["empty", ""], ["evonly", "ev_charging"]]) {
        const r = await register(suffix, products);
        assert.equal(r.status, 400, `${suffix}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.field, "products");
        assert.match(r.body.msg, /Select at least one fuel/);
        assert.equal(await User.countDocuments({ email: `${tag}-${suffix}@example.com` }), 0);
      }
    });

    await t.test("registration stores exactly the fuels chosen (EV charging is not stored)", async () => {
      const r = await register("pd", "petrol,diesel,ev_charging");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.user.vendorFuelTypes, ["petrol", "diesel"]);
      const saved = await User.findOne({ email: `${tag}-pd@example.com` }).lean();
      assert.deepEqual(saved.vendorFuelTypes, ["petrol", "diesel"]);
    });

    await t.test("a petrol + diesel vendor's station sells only petrol and diesel", async () => {
      const vendor = await approve("pd");
      const r = await call("POST", "/api/vendor-panel/stations", {
        token: tokenFor(vendor._id),
        body: { name: `${tag}-pd-station`, address: "Fuel Road", prices: { petrol: 101, diesel: 92, cng: 80 } },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const doc = await Station.findById(r.body._id).lean();
      assert.deepEqual(doc.fuelTypes, ["Petrol", "Diesel"]);
      assert.equal(doc.prices.petrol, 101);
      assert.equal(doc.prices.diesel, 92);
      assert.equal(doc.prices.cng, null, "no price stored for a fuel the station does not sell");
    });

    await t.test("asking for a fuel the vendor did not register for is refused", async () => {
      const vendor = await User.findOne({ email: `${tag}-pd@example.com` });
      const before = await Station.countDocuments({ owner: vendor._id });
      const r = await call("POST", "/api/vendor-panel/stations", {
        token: tokenFor(vendor._id),
        body: { name: `${tag}-pd-cng`, address: "Fuel Road", fuelTypes: ["Petrol", "CNG"], prices: { petrol: 100, cng: 80 } },
      });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.msg, /CNG cannot be added/);
      assert.equal(await Station.countDocuments({ owner: vendor._id }), before);
    });

    await t.test("the profile and the session carry the fuels", async () => {
      const vendor = await User.findOne({ email: `${tag}-pd@example.com` });
      const profile = await call("GET", "/api/vendor-panel/profile", { token: tokenFor(vendor._id) });
      assert.deepEqual(profile.body.vendorFuelTypes, ["petrol", "diesel"]);
      const me = await call("GET", "/api/auth/me", { token: tokenFor(vendor._id) });
      assert.deepEqual(me.body.user.vendorFuelTypes, ["petrol", "diesel"]);
    });

    await t.test("the vendor can change the fuels sold, but not to none", async () => {
      const vendor = await User.findOne({ email: `${tag}-pd@example.com` });
      const none = await call("PUT", "/api/vendor-panel/profile", { token: tokenFor(vendor._id), body: { vendorFuelTypes: [] } });
      assert.equal(none.status, 400);
      assert.deepEqual((await User.findById(vendor._id).lean()).vendorFuelTypes, ["petrol", "diesel"]);

      const cng = await call("PUT", "/api/vendor-panel/profile", { token: tokenFor(vendor._id), body: { vendorFuelTypes: ["cng"] } });
      assert.equal(cng.status, 200, JSON.stringify(cng.body));
      assert.deepEqual((await User.findById(vendor._id).lean()).vendorFuelTypes, ["cng"]);
    });

    await t.test("a vendor registered before fuels were recorded can still add every fuel", async () => {
      const legacy = await User.create({
        name: `${tag}-legacy`,
        email: `${tag}-legacy@example.com`,
        password: "unused",
        role: "vendor",
        vendorStatus: "active",
        activated: true,
        isVerified: true,
      });
      const r = await call("POST", "/api/vendor-panel/stations", {
        token: tokenFor(legacy._id),
        body: { name: `${tag}-legacy-station`, address: "Old Road", prices: { petrol: 100, diesel: 90, cng: 80 } },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual((await Station.findById(r.body._id).lean()).fuelTypes, ["Petrol", "Diesel", "CNG"]);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const users = await User.find({ email: { $regex: `^${tag}-` } }).select("_id").lean();
    const owners = users.map((u) => u._id);
    const stations = await Station.find({ owner: { $in: owners } }).select("_id").lean();
    await InventoryMovement.deleteMany({ station: { $in: stations.map((s) => s._id) } });
    await Station.deleteMany({ owner: { $in: owners } });
    await User.deleteMany({ _id: { $in: owners } });
    await mongoose.disconnect();
  }
});
