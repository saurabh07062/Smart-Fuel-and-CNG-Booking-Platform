/**
 * Phase 2: nearest-station search.
 *
 * services/station/discovery.js geoCandidates / findStationsForFuel and the customer
 * finder GET /api/stations/nearby (stationController.getNearbyStations).
 *
 * DEVELOPMENT TEST DATA: fixtures are tagged and placed in the South Atlantic
 * (-45, -30), where no real station exists, then removed. One fixture is
 * written at the (0, 0) placeholder with the native driver, because the model
 * itself refuses to store that position.
 *
 *   node --test test/geoDiscovery.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const geo = require("../src/services/algorithms/geo");

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

test("priceFor: a fuel search uses only that fuel's price; missing or 0 is unknown", () => {
  assert.equal(geo.priceFor({ prices: { petrol: 101 } }, "petrol"), 101);
  assert.ok(Number.isNaN(geo.priceFor({ prices: { petrol: 101, diesel: 90 } }, "cng")), "no borrowing another fuel's price");
  assert.ok(Number.isNaN(geo.priceFor({ prices: { cng: 0 } }, "cng")), "0 is not a price");
});

test("rankStations: an unpriced station never ranks as the cheapest", () => {
  const ranked = geo.rankStations(
    [
      { name: "unpriced", distanceKm: 2, waitMinutes: 5, prices: { petrol: null } },
      { name: "priced", distanceKm: 2, waitMinutes: 5, prices: { petrol: 100 } },
    ],
    undefined,
    { fuelType: "petrol" },
  );
  assert.equal(ranked[0].name, "priced");
});

/** A point `km` north of `origin`. */
const north = (origin, km) => ({ lat: origin.lat + km / 111.195, lng: origin.lng });

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

test("geo search against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const Station = require("../src/models/Station");
  const discovery = require("../src/services/station/discovery");
  const stationController = require("../src/controllers/stationController");
  await Station.init(); // 2dsphere index

  const tag = `geo-${Date.now()}`;
  const origin = { lat: -45, lng: -30 };
  const ids = [];
  const make = async (name, at, fields = {}) => {
    const s = await Station.create({
      name: `${tag}-${name}`,
      address: "Geo Test",
      status: "Active",
      fuelTypes: ["Petrol"],
      prices: { petrol: 100 },
      inventory: { petrol: 1000 },
      ...(at ? { coordinates: at } : {}),
      ...fields,
    });
    ids.push(s._id);
    return s;
  };

  const near1 = await make("petrol-1km", north(origin, 1));
  const unpriced3 = await make("petrol-3km-unpriced", north(origin, 3), { prices: { petrol: null } });
  await make("petrol-2km-inactive", north(origin, 2), { status: "Inactive" });
  await make("petrol-no-position", null);
  await make("cng-8km", north(origin, 8), { fuelTypes: ["CNG"], prices: { cng: 80 }, inventory: { cng: 500 } });
  const far30 = await make("petrol-30km", north(origin, 30));
  const placeholder = await Station.collection.insertOne({
    name: `${tag}-placeholder-zero`,
    address: "Geo Test",
    status: "Active",
    fuelTypes: ["Petrol"],
    coordinates: { lat: 0, lng: 0 },
    location: { type: "Point", coordinates: [0, 0] },
  });
  ids.push(placeholder.insertedId);

  const names = (list) => list.map((s) => s.name.replace(`${tag}-`, ""));

  const call = async (query) => {
    const res = {
      statusCode: 200,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
      send(b) { this.body = b; return this; },
    };
    await stationController.getNearbyStations({ query }, res);
    return res;
  };

  try {
    await t.test("default search: first 5 km ring, nearest first, only active stations that sell the fuel and have a position", async () => {
      const r = await discovery.findStationsForFuel(origin, { fuelType: "PETROL" });
      assert.equal(r.radiusKm, 5);
      assert.equal(r.expanded, false);
      assert.deepEqual(names(r.stations), ["petrol-1km", "petrol-3km-unpriced"]);
    });

    await t.test("distance is Haversine from the stored position", async () => {
      const r = await discovery.findStationsForFuel(origin, { fuelType: "petrol" });
      const expected = geo.haversineKm(origin, near1.latLng());
      assert.ok(Math.abs(r.stations[0].distanceKm - expected) < 1e-9);
      assert.ok(Math.abs(r.stations[0].distanceKm - 1) < 0.01);
    });

    await t.test("widens to the first ring with a station when nothing is closer", async () => {
      const r = await discovery.findStationsForFuel(origin, { fuelType: "cng" });
      assert.equal(r.radiusKm, 10);
      assert.equal(r.expanded, true);
      assert.deepEqual(names(r.stations), ["cng-8km"]);
    });

    await t.test("an explicit radius is exact and capped at 50 km", async () => {
      assert.deepEqual(names((await discovery.findStationsForFuel(origin, { fuelType: "petrol", radiusKm: 2 })).stations), ["petrol-1km"]);
      const wide = await discovery.findStationsForFuel(origin, { fuelType: "petrol", radiusKm: 100000 });
      assert.equal(wide.radiusKm, 50);
      assert.ok(names(wide.stations).includes("petrol-30km"));
      assert.equal(names(wide.stations).length, 3);
    });

    await t.test("limit trims the list but total reports everything in the radius", async () => {
      const r = await discovery.findStationsForFuel(origin, { fuelType: "petrol", radiusKm: 50, limit: 1 });
      assert.equal(r.stations.length, 1);
      assert.equal(r.total, 3);
    });

    await t.test("the (0,0) placeholder is never a result, even searching right next to it", async () => {
      const r = await discovery.findStationsForFuel({ lat: 0.001, lng: 0.001 }, { fuelType: "petrol", radiusKm: 50 });
      assert.ok(!names(r.stations).includes("placeholder-zero"));
      assert.equal(Station.hydrate({ coordinates: { lat: 0, lng: 0 } }).latLng(), null);
    });

    await t.test("bad input is rejected, not searched from a wrong place", async () => {
      await assert.rejects(discovery.findStationsForFuel({ lat: 91, lng: 0 }, { fuelType: "petrol" }), { status: 400 });
      await assert.rejects(discovery.findStationsForFuel(origin, { fuelType: "hydrogen" }), { status: 400 });
      await assert.rejects(discovery.findStationsForFuel(origin, { fuelType: "petrol", radiusKm: "abc" }), { status: 400 });
      await assert.rejects(discovery.findStationsForFuel(origin, { fuelType: "petrol", radiusKm: -5 }), { status: 400 });
    });

    await t.test("GET /api/stations/nearby: validation", async () => {
      for (const query of [
        { longitude: "-30", fuelType: "PETROL" },
        { latitude: "abc", longitude: "-30", fuelType: "PETROL" },
        { latitude: "-45", longitude: "-30abc", fuelType: "PETROL" },
        { latitude: "-45", longitude: "-30", fuelType: "HYDROGEN" },
        { latitude: "-45", longitude: "-30" },
        { latitude: "-45", longitude: "-30", fuelType: "PETROL", radius: "0" },
      ]) {
        const r = await call(query);
        assert.equal(r.statusCode, 400, JSON.stringify(query));
        assert.equal(r.body.success, false);
      }
    });

    await t.test("GET /api/stations/nearby: real distances, null for an unpublished price, which cannot be booked", async () => {
      const r = await call({ latitude: "-45", longitude: "-30", fuelType: "petrol" });
      assert.equal(r.statusCode, 200, JSON.stringify(r.body));
      assert.equal(r.body.radiusKm, 5);
      assert.equal(r.body.fuelType, "PETROL");
      const byName = Object.fromEntries(r.body.stations.map((s) => [s.stationName.replace(`${tag}-`, ""), s]));
      assert.deepEqual(Object.keys(byName).sort(), ["petrol-1km", "petrol-3km-unpriced"]);

      const priced = byName["petrol-1km"];
      assert.equal(priced._fuelPriceForDisplay, 100);
      assert.ok(Math.abs(priced.distance - 1) < 0.01);
      assert.equal(priced.latitude, near1.latLng().lat);
      assert.equal(priced.cngPrice, null, "a fuel the station doesn't sell has no price");

      const unpriced = byName["petrol-3km-unpriced"];
      assert.equal(unpriced._fuelPriceForDisplay, null);
      assert.equal(unpriced.canBook, false);
      assert.equal(String(unpriced.stationId), String(unpriced3._id));
    });

    await t.test("GET /api/stations/nearest uses the same search", async () => {
      const res = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await stationController.getNearestStations({ query: { latitude: "-45", longitude: "-30" } }, res);
      assert.equal(res.body.petrol.stationName, near1.name);
      assert.equal(res.body.cng.stationName, `${tag}-cng-8km`);
      assert.notEqual(res.body.petrol.stationId, String(far30._id));
    });
  } finally {
    await Station.deleteMany({ _id: { $in: ids } });
    await mongoose.disconnect();
  }
});
