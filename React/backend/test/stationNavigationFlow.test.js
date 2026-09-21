/**
 * Vendor coordinates -> MongoDB -> every customer API -> navigation, end to end
 * through the real app on the test database.
 *
 *   1. the vendor adds a station with a map position (vendor panel API)
 *   2. MongoDB holds exactly that position, legacy {lat,lng} and GeoJSON in step
 *   3. the vendor corrects it (Edit Station) -- the old point is gone everywhere
 *   4. every customer-facing API returns the corrected point: station detail,
 *      station list, nearby finder (nearest-pump cards), discovery, and a
 *      customer's booking
 *   5. nearest-station search finds the station at the corrected point and
 *      measures distance from it
 *
 * The Directions link is built on the frontend from these same values
 * (utils/navigation.ts, covered by stationNavigation.test.ts there).
 *
 * DEVELOPMENT TEST DATA, test database only: tagged users, a station and a
 * booking, removed at the end.
 *
 *   node --test test/stationNavigationFlow.test.js
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

test("station coordinates: vendor -> MongoDB -> customer APIs", async (t) => {
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
  const Booking = require("../src/models/Booking");
  const InventoryMovement = require("../src/models/InventoryMovement");
  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const tag = `navflow-${Date.now()}`;
  const tokenFor = (id) => jwt.sign({ user: { id: String(id) } }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "30m" });
  const call = async (method, route, token, body) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { "x-auth-token": token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const vendor = await User.create({
    name: `${tag}-vendor`, email: `${tag}-vendor@example.com`, password: "unused",
    role: "vendor", vendorStatus: "active", activated: true, isVerified: true,
  });
  const customer = await User.create({ name: `${tag}-cust`, email: `${tag}-cust@example.com`, password: "unused", role: "customer", isVerified: true });

  // The wrong pin from the IndianOil incident, then the pump's real position.
  const WRONG = { lat: 18.582535014511407, lng: 73.975371 };
  const PUMP = { lat: 18.5805621, lng: 73.9753407 };
  const CUSTOMER_AT = { lat: 18.5717712, lng: 73.9843486 }; // ~1.3 km away
  let stationId;

  const samePoint = (got, want, label) => {
    assert.ok(got, `${label}: no coordinates`);
    assert.equal(Number(got.lat), want.lat, `${label}: latitude`);
    assert.equal(Number(got.lng), want.lng, `${label}: longitude`);
  };

  try {
    await t.test("1-2. the vendor's position is stored exactly in MongoDB", async () => {
      const r = await call("POST", "/api/vendor-panel/stations", tokenFor(vendor._id), {
        name: `${tag}-IndianOil`, address: "Pune Nagar Road, Wagholi",
        prices: { petrol: 104, diesel: 91 }, coordinates: WRONG,
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      stationId = r.body._id;
      // Stock, so the finder and bookings treat the station as open for business.
      await Station.updateOne({ _id: stationId }, { $set: { inventory: { petrol: 5000, diesel: 5000, cng: 0 } } });

      const raw = await mongoose.connection.db.collection("stations").findOne({ _id: new mongoose.Types.ObjectId(stationId) });
      assert.deepEqual(raw.coordinates, WRONG);
      assert.deepEqual(raw.location, { type: "Point", coordinates: [WRONG.lng, WRONG.lat] });
    });

    await t.test("3. correcting the location replaces it everywhere in MongoDB", async () => {
      const before = await Station.findById(stationId).lean();
      const r = await call("PUT", `/api/vendor-panel/stations/${stationId}`, tokenFor(vendor._id), {
        coordinates: PUMP, expectedUpdatedAt: before.updatedAt,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const raw = await mongoose.connection.db.collection("stations").findOne({ _id: new mongoose.Types.ObjectId(stationId) });
      assert.deepEqual(raw.coordinates, PUMP);
      assert.deepEqual(raw.location.coordinates, [PUMP.lng, PUMP.lat], "GeoJSON location moved with it");
    });

    await t.test("4a. station detail and station list return the corrected point", async () => {
      const detail = await call("GET", `/api/stations/${stationId}`);
      assert.equal(detail.status, 200);
      const d = detail.body.station ?? detail.body;
      samePoint(d.coordinates, PUMP, "GET /api/stations/:id coordinates");
      assert.deepEqual(d.location.coordinates, [PUMP.lng, PUMP.lat], "GET /api/stations/:id location");

      const list = await call("GET", "/api/stations");
      const rows = Array.isArray(list.body) ? list.body : list.body.stations;
      const row = rows.find((s) => String(s._id) === String(stationId));
      samePoint(row?.coordinates, PUMP, "GET /api/stations");
    });

    await t.test("4b. nearest-pump finder returns the corrected point and measures from it", async () => {
      const r = await call(
        "GET",
        `/api/stations/nearby?latitude=${CUSTOMER_AT.lat}&longitude=${CUSTOMER_AT.lng}&fuelType=PETROL`,
      );
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const row = r.body.stations.find((s) => String(s.stationId ?? s._id ?? s.id) === String(stationId));
      assert.ok(row, "station found by the finder");
      assert.equal(row.latitude, PUMP.lat);
      assert.equal(row.longitude, PUMP.lng);
      const km = Number(row.distance ?? row.distanceKm);
      assert.ok(km > 1.0 && km < 1.6, `distance from the corrected pump, got ${km} km`);
    });

    await t.test("4c. discovery returns the corrected point, even for a station stored with only GeoJSON", async () => {
      const r = await call("GET", `/api/v1/discovery/nearby?lat=${CUSTOMER_AT.lat}&lng=${CUSTOMER_AT.lng}&radiusKm=5`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const row = (r.body.stations ?? r.body.results ?? []).find((s) => String(s.id) === String(stationId));
      assert.ok(row, "station found by discovery");
      samePoint(row.coordinates, PUMP, "discovery");

      // A station whose legacy field is missing (imported / updated outside the model).
      await mongoose.connection.db
        .collection("stations")
        .updateOne({ _id: new mongoose.Types.ObjectId(stationId) }, { $unset: { coordinates: "" } });
      const r2 = await call("GET", `/api/v1/discovery/nearby?lat=${CUSTOMER_AT.lat}&lng=${CUSTOMER_AT.lng}&radiusKm=5`);
      const row2 = (r2.body.stations ?? r2.body.results ?? []).find((s) => String(s.id) === String(stationId));
      samePoint(row2?.coordinates, PUMP, "discovery from GeoJSON only");
      await Station.updateOne({ _id: stationId }, { $set: { coordinates: PUMP } });
    });

    await t.test("4d. a customer's booking carries the station's corrected point", async () => {
      const r = await call("POST", "/api/bookings", tokenFor(customer._id), {
        stationId, fuelType: "Petrol", quantity: 5, bookingDate: "2099-12-01", timeSlot: "10:00 AM", payMethod: "station",
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const mine = await call("GET", "/api/customer/bookings", tokenFor(customer._id));
      assert.equal(mine.status, 200, JSON.stringify(mine.body));
      const b = (Array.isArray(mine.body) ? mine.body : mine.body.bookings).find((x) => String(x._id) === String(r.body.booking._id));
      samePoint(b.station.coordinates, PUMP, "booking.station");
    });

    await t.test("5. nearest-station search finds it at the corrected point, not the old one", async () => {
      // $near sorts, so it is not allowed in countDocuments: find and count.
      const near = async (p, m) =>
        (await Station.find({ _id: stationId, location: { $near: { $geometry: { type: "Point", coordinates: [p.lng, p.lat] }, $maxDistance: m } } }).select("_id").lean()).length;
      assert.equal(await near(PUMP, 10), 1, "within 10 m of the pump");
      assert.equal(await near(WRONG, 150), 0, "not at the old wrong pin");
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await Booking.deleteMany({ station: stationId });
    await require("../src/models/BookingAttempt").deleteMany({ user: customer._id });
    await require("../src/models/Notification").deleteMany({ user: customer._id });
    await InventoryMovement.deleteMany({ station: stationId });
    await Station.deleteMany({ _id: stationId });
    await User.deleteMany({ _id: { $in: [vendor._id, customer._id] } });
    await mongoose.disconnect();
  }
});
