/**
 * The public station view (src/services/station/publicStation.js):
 * GET /api/stations, /api/stations/search and /api/stations/:id never return
 * who owns a station, where its payments settle or its stock; the owner's own
 * vendor-panel list still does; station-room socket payloads use the same
 * whitelist.
 *
 * DEVELOPMENT TEST DATA, test database only: one tagged vendor and station,
 * removed at the end.
 *
 *   node --test test/publicStation.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { publicStation, PUBLIC_STATION_FIELDS, PUBLIC_STATION_SELECT } = require("../src/services/station/publicStation");

const PRIVATE_FIELDS = [
  "owner",
  "upiId",
  "upiName",
  "acceptsUpi",
  "inventory",
  "inventoryCommitted",
  "tankCapacity",
  "reviews",
  "pumpCounts",
  "waitingCounts",
  "activeFuelingCounts",
  "nozzles",
  "arrivalRatePerHour",
  "observedAvgQueueLength",
  "source",
  "osmId",
  "sourceUpdatedAt",
  "__v",
];

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

test("publicStation keeps the whitelist and drops everything else", () => {
  const view = publicStation({
    _id: "s1",
    name: "Station",
    status: "Active",
    prices: { petrol: 100 },
    owner: "u1",
    upiId: "station@okicici",
    upiName: "Payee",
    acceptsUpi: true,
    inventory: { petrol: 900 },
    inventoryCommitted: { petrol: 10 },
    tankCapacity: { petrol: 5000 },
    reviews: [{ rating: 5 }],
    pumpCounts: { petrol: 2 },
    source: "osm",
    osmId: "node/1",
    __v: 3,
    someFutureField: "private until whitelisted",
  });
  assert.deepEqual(Object.keys(view).sort(), ["_id", "id", "name", "prices", "status"]);
  assert.equal(view.id, "s1");
});

test("no private field is whitelisted or selected", () => {
  for (const field of PRIVATE_FIELDS) {
    assert.equal(PUBLIC_STATION_FIELDS.includes(field), false, `${field} must not be public`);
    assert.equal(PUBLIC_STATION_SELECT.split(" ").includes(field), false, `${field} must not be loaded`);
  }
});

test("socket payloads use the same whitelist as the REST endpoints", () => {
  const realtime = require("../src/services/notification/realtime");
  const station = { _id: "s2", name: "Same", upiId: "x@okicici", owner: "u9", prices: { cng: 80 } };
  assert.deepEqual(realtime.publicStation(station), publicStation(station));
});

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

test("public station endpoints against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const stationController = require("../src/controllers/stationController");
  const vendorPanel = require("../src/controllers/vendorPanelController");

  const tag = `publicstation-${Date.now()}`;
  const UPI = "fuelmarttest@okicici";
  let vendor = null;
  let station = null;

  /** No private key, and none of the private values anywhere in the JSON. */
  const assertPublic = (row, label) => {
    for (const field of PRIVATE_FIELDS) assert.equal(row[field], undefined, `${label}: ${field} leaked`);
    const text = JSON.stringify(row);
    for (const secret of [UPI, String(vendor._id), `${tag} Payee`, "4321", "9000"]) {
      assert.equal(text.includes(secret), false, `${label}: "${secret}" appears in the response`);
    }
  };

  // Fixtures are created inside the try, so a failed setup still disconnects
  // (an open connection would keep this test process alive).
  try {
    vendor = await User.create({
      name: `${tag}-vendor`,
      email: `${tag}-vendor@example.com`,
      password: "not-a-real-hash",
      role: "vendor",
      vendorStatus: "active",
      activated: true,
    });
    station = await Station.create({
      name: `${tag} Station`,
      address: "Public View Test Road",
      city: "Pune",
      owner: vendor._id,
      status: "Active",
      fuelTypes: ["Petrol"],
      prices: { petrol: 101.25 },
      inventory: { petrol: 4321 },
      inventoryCommitted: { petrol: 12 },
      tankCapacity: { petrol: 9000 },
      upiId: UPI,
      upiName: `${tag} Payee`,
      reviews: [{ user: vendor._id, rating: 4, comment: "fine" }],
    });

    await t.test("GET /api/stations: public fields and the live queue, nothing private", async () => {
      const res = fakeRes();
      await stationController.getAllStations({ query: {} }, res);
      assert.equal(res.statusCode, 200);
      const row = res.body.find((s) => s.name === station.name);
      assert.ok(row, "the station is listed");
      assertPublic(row, "list");
      assert.equal(row.prices.petrol, 101.25);
      assert.equal(row.city, "Pune");
      assert.equal(typeof row.queue, "number");
      assert.ok(row.fuelQueues.petrol, "per-fuel queue still present");
    });

    await t.test("GET /api/stations/search: public view only", async () => {
      const res = fakeRes();
      await stationController.searchStations({ query: { q: tag } }, res);
      assert.equal(res.body.length, 1);
      assertPublic(res.body[0], "search");
      assert.equal(String(res.body[0].id), String(station._id));
    });

    await t.test("GET /api/stations/:id: public view; a bad or unknown id is 404", async () => {
      const res = fakeRes();
      await stationController.getStationById({ params: { id: String(station._id) } }, res);
      assert.equal(res.statusCode, 200);
      assertPublic(res.body, "detail");
      assert.equal(res.body.address, "Public View Test Road");

      const bad = fakeRes();
      await stationController.getStationById({ params: { id: "not-an-id" } }, bad);
      assert.equal(bad.statusCode, 404);
      const unknown = fakeRes();
      await stationController.getStationById({ params: { id: String(new mongoose.Types.ObjectId()) } }, unknown);
      assert.equal(unknown.statusCode, 404);
    });

    await t.test("the owner's vendor-panel list still carries the private fields", async () => {
      const res = fakeRes();
      await vendorPanel.getMyStations({ user: { id: String(vendor._id), role: "vendor" }, query: {} }, res);
      assert.equal(res.statusCode, 200);
      const own = res.body.find((s) => String(s._id) === String(station._id));
      assert.equal(own.upiId, UPI);
      assert.equal(own.inventory.petrol, 4321);
      assert.equal(String(own.owner), String(vendor._id));
    });
  } finally {
    if (station) await Station.deleteMany({ _id: station._id });
    if (vendor) await User.deleteMany({ _id: vendor._id });
    await mongoose.disconnect();
  }
});
