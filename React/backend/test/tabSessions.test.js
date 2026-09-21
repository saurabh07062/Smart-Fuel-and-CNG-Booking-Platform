/**
 * One browser, several tabs, different accounts (services/security/session.js).
 *
 *   tab A signs in as the vendor, tab B as a customer: each keeps its own
 *   account; a new tab C starts as the latest sign-in and keeps its copy;
 *   signing out in B does not sign A out; no tab header = the shared session,
 *   as before.
 *
 * Test database only; tagged users removed at the end.
 *   node --test test/tabSessions.test.js
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

/** A minimal browser cookie jar: name -> {value, path}. */
function jar() {
  const cookies = new Map();
  return {
    header(url) {
      return [...cookies.entries()]
        .filter(([, c]) => url.startsWith(c.path))
        .map(([n, c]) => `${n}=${c.value}`)
        .join("; ");
    },
    store(res) {
      for (const line of res.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(";").map((p) => p.trim());
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        const p = (attrs.find((a) => /^path=/i.test(a)) || "Path=/").split("=")[1];
        const expired = attrs.some((a) => /^expires=/i.test(a) && new Date(a.slice(8)) < new Date()) || value === "";
        if (expired) cookies.delete(name);
        else cookies.set(name, { value, path: p });
      }
    },
    names: () => [...cookies.keys()],
  };
}

test("tabs of one browser keep their own accounts", { timeout: 60_000 }, async (t) => {
  testDb.isolateRedis();
  try {
    await mongoose.connect(testDb.uri(), { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }
  const bcrypt = require("bcryptjs");
  const User = require("../src/models/User");
  const RefreshToken = require("../src/models/RefreshToken");
  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = jar();

  const call = async (method, route, { tab, body } = {}) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: base,
        Cookie: browser.header(route),
        ...(tab ? { "X-FM-Tab": tab } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    browser.store(res);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const whoAmI = async (tab) => (await call("GET", "/api/auth/me", { tab })).body.user?.email ?? null;

  const tag = `tabs-${Date.now()}`;
  const password = "Passw0rd!tabs";
  const hash = await bcrypt.hash(password, 4);
  const vendor = await User.create({ name: "V", email: `${tag}-v@fuelmart.test`, password: hash, role: "vendor", vendorStatus: "active", activated: true, isVerified: true });
  const customer = await User.create({ name: "C", email: `${tag}-c@fuelmart.test`, password: hash, role: "customer", isVerified: true });

  try {
    const A = "tabaaaaaaaa1";
    const B = "tabbbbbbbbb2";
    const C = "tabccccccccc3";

    await t.test("a new tab asking while nobody is signed in gets an answer, not an error", async () => {
      const quiet = await fetch(`${base}/api/auth/refresh`, { method: "POST", headers: { Origin: base, "X-FM-Tab": "tabnobody0001", "X-FM-Adopt": "1" } });
      assert.equal(quiet.status, 200);
      assert.deepEqual(await quiet.json(), { user: null });
      // Without the header, a missing session is still a 401 (the API client's refresh relies on it).
      const plain = await fetch(`${base}/api/auth/refresh`, { method: "POST", headers: { Origin: base } });
      assert.equal(plain.status, 401);
    });

    await t.test("tab A signs in as the vendor, tab B as the customer: both keep their own", async () => {
      assert.equal((await call("POST", "/api/auth/login", { tab: A, body: { email: vendor.email, password } })).status, 200);
      assert.equal((await call("POST", "/api/auth/login", { tab: B, body: { email: customer.email, password } })).status, 200);
      assert.equal(await whoAmI(A), vendor.email, "tab A is still the vendor");
      assert.equal(await whoAmI(B), customer.email);
      // A vendor-only endpoint works from tab A even though the latest sign-in is the customer.
      assert.equal((await call("GET", "/api/vendor-panel/profile", { tab: A })).status, 200);
      assert.equal((await call("GET", "/api/vendor-panel/profile", { tab: B })).status, 403);
    });

    await t.test("a request without a tab id uses the browser's latest sign-in, as before", async () => {
      assert.equal(await whoAmI(null), customer.email);
    });

    await t.test("a new tab starts as the latest sign-in and keeps its own copy", async () => {
      const r = await call("POST", "/api/auth/refresh", { tab: C });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.user.email, customer.email);
      // The vendor signs in again elsewhere: tab C does not change.
      await call("POST", "/api/auth/login", { tab: A, body: { email: vendor.email, password } });
      assert.equal(await whoAmI(C), customer.email);
    });

    await t.test("each tab refreshes its own session", async () => {
      assert.equal((await call("POST", "/api/auth/refresh", { tab: A })).body.user.email, vendor.email);
      assert.equal((await call("POST", "/api/auth/refresh", { tab: B })).body.user.email, customer.email);
      assert.equal(await whoAmI(A), vendor.email);
    });

    await t.test("signing out in tab B leaves tab A signed in", async () => {
      assert.equal((await call("POST", "/api/auth/logout", { tab: B })).status, 200);
      assert.equal((await call("GET", "/api/auth/me", { tab: B })).status === 200 && (await whoAmI(B)) === customer.email, false);
      assert.equal(await whoAmI(A), vendor.email);
    });

    await t.test("only this tab's session is revoked on sign-out", async () => {
      const live = await RefreshToken.countDocuments({ user: vendor._id, revokedAt: null });
      assert.ok(live >= 1, "the vendor still has live sessions");
    });
  } finally {
    server.close();
    await RefreshToken.deleteMany({ user: { $in: [vendor._id, customer._id] } });
    await User.deleteMany({ _id: { $in: [vendor._id, customer._id] } });
    await mongoose.disconnect();
  }
});
