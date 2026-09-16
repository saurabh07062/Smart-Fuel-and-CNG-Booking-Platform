/**
 * Security hardening: security headers on every response (helmet) and
 * literal, length-capped search regexes (src/utils/regex.js) wherever typed
 * text becomes a RegExp.
 *
 * DEVELOPMENT TEST DATA, test database only: one tagged station, removed at
 * the end.
 *
 *   node --test test/securityHardening.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { escapeRegex, literalSearchRegex, MAX_SEARCH_LENGTH } = require("../src/utils/regex");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

const fakeRes = () => ({
  statusCode: 200,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
  send(b) { this.body = b; return this; },
});

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

test("literalSearchRegex: typed text is matched literally, case-insensitive, as a substring", () => {
  const evil = literalSearchRegex("(a+)+$");
  assert.ok(evil.test("xx(a+)+$yy"), "the literal characters match");
  assert.equal(evil.test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!"), false, "never interpreted as a pattern");

  assert.equal(literalSearchRegex("a.b").test("axb"), false, "a dot is a dot");
  assert.ok(literalSearchRegex("a.b").test("A.B Road"));
  assert.ok(literalSearchRegex("hindu").test("Hindustan Petroleum"), "partial matches still work");
  assert.equal(escapeRegex("[.*]"), "\\[\\.\\*\\]");
});

test("literalSearchRegex: nothing to search is null, and the length is capped", () => {
  assert.equal(literalSearchRegex(["a", "b"]), null, "?q=a&q=b arrives as an array");
  assert.equal(literalSearchRegex("   "), null);
  assert.equal(literalSearchRegex(undefined), null);
  assert.equal(literalSearchRegex({ $gt: "" }), null);
  assert.equal(literalSearchRegex("x".repeat(MAX_SEARCH_LENGTH + 50)).source.length, MAX_SEARCH_LENGTH);
});

// ---------------------------------------------------------------------------
// Headers (in-process app, no database needed)
// ---------------------------------------------------------------------------

test("every response carries security headers; uploads stay loadable cross-origin", async () => {
  const app = require("../src/app");
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;

    const root = await fetch(`${base}/`);
    assert.equal(root.headers.get("x-content-type-options"), "nosniff");
    assert.ok(root.headers.get("x-frame-options"), "frame protection");
    assert.ok(root.headers.get("strict-transport-security"), "HSTS");
    assert.ok(root.headers.get("content-security-policy"), "a CSP");
    assert.equal(root.headers.get("x-powered-by"), null, "no framework banner");

    const upload = await fetch(`${base}/uploads/does-not-exist.png`);
    assert.equal(upload.status, 404);
    assert.equal(
      upload.headers.get("cross-origin-resource-policy"),
      "cross-origin",
      "uploaded images must still load on the frontend's origin",
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// Search endpoints against MongoDB
// ---------------------------------------------------------------------------

test("search endpoints never build a regex from raw input", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const Station = require("../src/models/Station");
  const stationController = require("../src/controllers/stationController");
  const vendorController = require("../src/controllers/vendorController");
  const call = async (fn, query) => {
    const res = fakeRes();
    await fn({ query, user: { id: "000000000000000000000000", role: "admin" } }, res);
    return res;
  };

  const tag = `sechard-${Date.now()}`;
  const station = await Station.create({
    name: `${tag} Hindustan Petroleum`,
    address: "Security (Test) Road",
    status: "Active",
    fuelTypes: ["Petrol"],
    prices: { petrol: 100 },
    inventory: { petrol: 10 },
  });

  try {
    await t.test("a regex metacharacter is searched for, not a 500", async () => {
      const bad = await call(stationController.searchStations, { q: "(" });
      assert.equal(bad.statusCode, 200);
      assert.ok(Array.isArray(bad.body));

      const literal = await call(stationController.searchStations, { q: "(Test)" });
      assert.ok(
        literal.body.some((s) => String(s._id) === String(station._id)),
        "the literal parentheses in the address match",
      );
    });

    await t.test("partial names still match", async () => {
      const r = await call(stationController.searchStations, { q: `${tag} hindu` });
      assert.deepEqual(r.body.map((s) => String(s._id)), [String(station._id)]);
    });

    await t.test("repeated parameters and pattern-like filters do not crash", async () => {
      const repeated = await call(stationController.searchStations, { q: ["a", "b"] });
      assert.equal(repeated.statusCode, 200);
      assert.deepEqual(repeated.body, []);

      const list = await call(stationController.getAllStations, { fuelType: "(" });
      assert.equal(list.statusCode, 200);
      assert.deepEqual(list.body, [], "no station sells a fuel literally named '('");

      const vendors = await call(vendorController.getAllVendors, { search: "(a+)+$" });
      assert.equal(vendors.statusCode, 200);
    });
  } finally {
    await Station.deleteMany({ _id: station._id });
    await mongoose.disconnect();
  }
});
