/**
 * Nozzle setup (config/nozzleModes.js): the vendor enters each fuel's total
 * nozzles and how many take app bookings (online); the rest serve walk-ins.
 *
 *   total 3, online 1: walk-ins fuel on their own 2 nozzles, in parallel, and
 *                      never hold up a booked customer on the app nozzle
 *   total 2, online 0: walk-in only; the fuel cannot be booked in the app
 *   not set          : one nozzle shared by bookings and walk-ins (as before)
 *
 * Test database only; tagged users, station, bookings and walk-ins removed.
 *   node --test test/nozzleModes.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const mongoose = require("mongoose");
const testDb = require("./helpers/testDb");

test.after(async () => {
  require("../src/services/queue/serviceTimer").clearAllTimers();
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("vendor splits each fuel's nozzles between online and walk-ins", { timeout: 60_000 }, async (t) => {
  testDb.isolateRedis();
  try {
    await mongoose.connect(testDb.uri(), { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }
  const jwt = require("jsonwebtoken");
  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const WalkIn = require("../src/models/WalkIn");
  const nozzleService = require("../src/services/queue/nozzleService");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");
  const { dateKey } = require("../src/config/businessTime");
  await Promise.all([Booking.init(), WalkIn.init()]);
  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokenFor = (id) => jwt.sign({ user: { id: String(id) } }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "30m" });
  const call = async (method, route, token, body) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { "x-auth-token": token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const tag = `nozzle-${Date.now()}`;
  const vendor = await User.create({ name: `${tag}-v`, email: `${tag}-v@fuelmart.test`, password: "x", role: "vendor", vendorStatus: "active", activated: true, isVerified: true });
  const other = await User.create({ name: `${tag}-o`, email: `${tag}-o@fuelmart.test`, password: "x", role: "vendor", vendorStatus: "active", activated: true, isVerified: true });
  const customers = await User.insertMany(
    [1, 2, 3].map((i) => ({ name: `${tag}-c${i}`, email: `${tag}-c${i}@fuelmart.test`, password: "x", role: "customer", isVerified: true })),
  );
  const station = await Station.create({
    name: `${tag}-station`, address: "Nozzle Road", owner: vendor._id, status: "Active",
    fuelTypes: ["Petrol", "CNG"], prices: { petrol: 100, cng: 80 }, inventory: { petrol: 1000, cng: 1000 },
    coordinates: { lat: 18.62, lng: 73.72 },
  });
  const id = String(station._id);
  const V = tokenFor(vendor._id);
  const setup = (body, token = V) => call("PATCH", `/api/vendor-panel/stations/${id}/nozzles`, token, body);
  const book = (customer, fuelType, hour) =>
    call("POST", "/api/bookings", tokenFor(customer._id), { stationId: id, fuelType, quantity: 5, bookingDate: "2099-12-01", timeSlot: `${hour}:00 PM`, payMethod: "station" });
  const walkIn = (fuelType) => call("POST", `/api/vendor-panel/stations/${id}/walk-ins`, V, { fuelType, quantity: 5 });
  const petrolWalkIns = () => WalkIn.find({ station: station._id, fuelType: "Petrol" }).sort({ arrivalTime: 1 }).lean();

  try {
    await t.test("not set up: bookings and walk-ins share one nozzle, as before", async () => {
      assert.equal((await book(customers[0], "Petrol", 6)).status, 200);
      assert.equal((await walkIn("CNG")).status, 201);
      assert.equal((await walkIn("CNG")).status, 201);
      const cng = await WalkIn.find({ station: station._id, fuelType: "CNG" }).lean();
      assert.deepEqual(cng.map((w) => w.status).sort(), ["serving", "waiting"], "one at a time on the shared nozzle");
    });

    await t.test("Petrol 3 nozzles, 1 online: walk-ins fuel on the other 2 at once", async () => {
      const r = await setup({ petrol: { total: 3, online: 1 } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual({ ...r.body.nozzleConfig.petrol }, { total: 3, online: 1 });
      assert.equal((await Station.findById(id).lean()).pumpCounts.petrol, 3, "the wait model's nozzle count follows");

      for (let i = 0; i < 3; i++) assert.equal((await walkIn("Petrol")).status, 201);
      const rows = await petrolWalkIns();
      assert.deepEqual(rows.map((w) => [w.status, w.lane]), [["serving", 1], ["serving", 2], ["waiting", null]]);
    });

    await t.test("walk-ins on their own nozzles do not block app booking slots", async () => {
      const windows = (await nozzleScheduler.liveServiceWindows([station._id])).get(id) || [];
      const walkInIds = new Set((await petrolWalkIns()).map((w) => String(w._id)));
      assert.equal(windows.filter((w) => walkInIds.has(w.bookingId)).length, 0);
    });

    await t.test("a booked customer checks in and starts at once: walk-ins are not on the app nozzle", async () => {
      const start = nozzleScheduler.parseStartDateTime(dateKey(), "11:30 PM");
      const w = nozzleScheduler.computeWindow("Petrol", start);
      const booking = await Booking.create({
        user: customers[1]._id, station: station._id, fuelType: "Petrol", quantity: 5, price: 100, amount: 505,
        bookingDate: dateKey(), timeSlot: "11:30 PM", bookingStartTime: w.start, bookingEndTime: w.end,
        payMethod: "station", paymentStatus: "due_at_station", status: "upcoming", verificationCode: "5501",
      });
      const r = await nozzleService.checkIn({ bookingId: booking._id });
      assert.equal(r.outcome, "started");
    });

    await t.test("a walk-in nozzle frees up: the waiting walk-in takes it", async () => {
      const [first] = await petrolWalkIns();
      const r = await call("PATCH", `/api/vendor-panel/stations/${id}/walk-ins/${first._id}`, V, { action: "complete" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const rows = await petrolWalkIns();
      assert.deepEqual(rows.map((x) => [x.status, x.lane]), [["completed", 1], ["serving", 2], ["serving", 1]]);
    });

    await t.test("CNG 2 nozzles, 0 online: walk-in only, no app booking", async () => {
      assert.equal((await setup({ cng: { total: 2, online: 0 } })).status, 200);
      const b = await book(customers[2], "CNG", 7);
      assert.equal(b.status, 409, JSON.stringify(b.body));
      assert.equal(b.body.reason, "NOZZLE_OFFLINE_ONLY");
      assert.match(b.body.msg, /walk-in only/);
      const r = await call("GET", "/api/stations/nearby?latitude=18.62&longitude=73.72&fuelType=CNG&radius=5", tokenFor(customers[2]._id));
      const row = r.body.stations.find((s) => String(s.stationId) === id);
      assert.equal(row.canBook, false);
      assert.equal(row.unavailableCode, "WALK_IN_ONLY");
      assert.equal((await walkIn("CNG")).status, 201, "walk-ins still welcome");
    });

    await t.test("bad setups are refused and change nothing", async () => {
      for (const body of [
        { petrol: { total: 2, online: 3 } },
        { petrol: { total: 0, online: 0 } },
        { petrol: { total: 1.5, online: 1 } },
        { petrol: { total: 21, online: 1 } },
        { diesel: { total: 2, online: 1 } },
        {},
      ]) {
        assert.equal((await setup(body)).status, 400, JSON.stringify(body));
      }
      assert.equal((await setup({ petrol: { total: 2, online: 1 } }, tokenFor(other._id))).status, 404, "another vendor's station");
      const doc = await Station.findById(id).lean();
      assert.deepEqual({ ...doc.nozzleConfig.petrol }, { total: 3, online: 1 });
    });
  } finally {
    server.close();
    await Booking.deleteMany({ station: station._id });
    await WalkIn.deleteMany({ station: station._id });
    await Station.deleteMany({ _id: station._id });
    await User.deleteMany({ _id: { $in: [vendor._id, other._id, ...customers.map((c) => c._id)] } });
    await mongoose.disconnect();
  }
});
