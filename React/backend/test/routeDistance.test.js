/**
 * GET /api/stations/:id/route -- distance from a point to one station (the
 * booking confirmation page). With a router: the road distance; without one
 * (tests run with ROUTING_URL=off): the straight line, labelled as such.
 *
 * Test database only; the tagged station is removed at the end.
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

test("route distance to one station", { timeout: 30_000 }, async (t) => {
  testDb.isolateRedis();
  try {
    await mongoose.connect(testDb.uri(), { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }
  const Station = require("../src/models/Station");
  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const station = await Station.create({ name: `route-${Date.now()}`, address: "Road", status: "Active", coordinates: { lat: 18.5722918, lng: 73.9871974 } });
  const noPin = await Station.create({ name: `route-nopin-${Date.now()}`, address: "Road", status: "Active" });
  const get = async (id, q) => {
    const r = await fetch(`${base}/api/stations/${id}/route?${q}`);
    return { status: r.status, body: await r.json() };
  };

  try {
    const r = await get(station._id, "lat=18.5721&lng=73.9842");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.distanceType, "straight", "routing is off in tests");
    assert.ok(r.body.distanceKm > 0.3 && r.body.distanceKm < 0.35, `straight line ${r.body.distanceKm} km`);
    assert.equal(r.body.straightLineKm, r.body.distanceKm);

    assert.equal((await get(station._id, "lat=abc&lng=1")).status, 400);
    assert.equal((await get(station._id, "lat=95&lng=73")).status, 400);
    assert.equal((await get("not-an-id", "lat=18.5&lng=73.9")).status, 404);
    assert.equal((await get(noPin._id, "lat=18.5&lng=73.9")).status, 404, "a station without a location");
  } finally {
    server.close();
    await Station.deleteMany({ _id: { $in: [station._id, noPin._id] } });
    await mongoose.disconnect();
  }
});
