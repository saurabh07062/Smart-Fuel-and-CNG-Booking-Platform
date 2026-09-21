/**
 * GET /api/stations/nearby validates in the app's order: the location first
 * ("Use my location"), then the fuel. Every rejection here happens before
 * any database access.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const { getNearbyStations } = require("../src/controllers/stationController");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

const call = async (query) => {
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await getNearbyStations({ query }, res);
  return res;
};

test("no location: asks for the location first, even without a fuel", async () => {
  for (const q of [{}, { fuelType: "PETROL" }, { latitude: "18.57", fuelType: "PETROL" }, { latitude: " ", longitude: "", fuelType: "CNG" }]) {
    const res = await call(q);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.reason, "LOCATION_REQUIRED", JSON.stringify(q));
    assert.match(res.body.msg, /Use my location/);
  }
});

test("an invalid location is refused", async () => {
  for (const q of [
    { latitude: "18abc", longitude: "73.98", fuelType: "PETROL" },
    { latitude: "95", longitude: "73.98", fuelType: "PETROL" },
    { latitude: "18.57", longitude: "200", fuelType: "PETROL" },
  ]) {
    const res = await call(q);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.reason, "LOCATION_INVALID", JSON.stringify(q));
  }
});

test("(0, 0), the no-fix value, is refused", async () => {
  const res = await call({ latitude: "0", longitude: "0", fuelType: "PETROL" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.reason, "LOCATION_INVALID");
});

test("with a location, the fuel comes next", async () => {
  const at = { latitude: "18.5718", longitude: "73.9841" };
  let res = await call(at);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.reason, "FUEL_REQUIRED");
  res = await call({ ...at, fuelType: "KEROSENE" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.reason, "FUEL_INVALID");
});
