/**
 * The refueling flow, end to end, per fuel (Petrol, Diesel, CNG):
 *
 *   booking stamped with its fuel's duration (Petrol/Diesel 40 s, CNG 300 s)
 *   -> the attendant enters the customer's 4-digit code (POST /api/bookings/verify)
 *   -> fueling starts: status serving, fuelingStartTime stamped by the server
 *   -> a restart re-arms the timer from the STORED start (it does not restart)
 *   -> the server completes the booking at start + duration, with no further call
 *   -> completed once: stock deducted once, customer notified
 *
 * The configured durations (40 s, 5 min) are asserted on real bookings made
 * through the API; to observe completion without waiting 5 minutes the check-in
 * bookings are written with the SAME stored field set to 1-2 seconds, which is
 * exactly what the timer reads.
 *
 * DEVELOPMENT TEST DATA, test database only: tagged users, a station and its
 * bookings, removed at the end.
 *
 *   node --test test/refuelingFlow.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const testDb = require("./helpers/testDb");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.after(async () => {
  require("../src/services/queue/serviceTimer").clearAllTimers();
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("configured durations: Petrol/Diesel 40 s, CNG 5 minutes", () => {
  const { getServiceDurationSeconds } = require("../src/config/fuelDurations");
  for (const fuel of ["Petrol", "Diesel"]) {
    for (const qty of [undefined, 1, 2, 5, 8, 10, 20, 60]) {
      assert.equal(getServiceDurationSeconds(fuel, qty), 40, `${fuel} ${qty} L`);
    }
  }
  assert.equal(getServiceDurationSeconds("CNG"), 300);
  for (const qty of [1, 5, 20, 60]) assert.equal(getServiceDurationSeconds("CNG", qty), 300);
});

test("refueling flow against MongoDB", async (t) => {
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
  const Notification = require("../src/models/Notification");
  const serviceTimer = require("../src/services/queue/serviceTimer");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");
  const { dateKey } = require("../src/config/businessTime");
  await Booking.init();

  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const TODAY = dateKey();
  const tag = `refuel-${Date.now()}`;
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
  const customers = await User.insertMany(
    Array.from({ length: 8 }, (_, i) => ({ name: `${tag}-c${i}`, email: `${tag}-c${i}@example.com`, password: "unused", role: "customer", isVerified: true })),
  );
  const station = await Station.create({
    name: `${tag}-station`, address: "Refuel Road", owner: vendor._id, status: "Active",
    fuelTypes: ["Petrol", "Diesel", "CNG"],
    prices: { petrol: 100, diesel: 90, cng: 80 },
    inventory: { petrol: 1000, diesel: 1000, cng: 1000 },
  });

  const reload = (id) => Booking.findById(id).lean();
  const waitFor = async (fn, ms, label) => {
    const until = Date.now() + ms;
    for (;;) {
      if (await fn()) return;
      if (Date.now() > until) throw new Error(`timed out waiting for: ${label}`);
      await sleep(50);
    }
  };

  const LABELS = ["8:00 PM", "8:30 PM", "9:00 PM"];
  let n = 0;
  /** A booking for today at the station, with a unique 4-digit code and a short stored duration. */
  const todayBooking = (fuelType, code, serviceDurationSeconds) => {
    const i = n++;
    const start = nozzleScheduler.parseStartDateTime(TODAY, LABELS[i % LABELS.length]);
    const w = nozzleScheduler.computeWindow(fuelType, start);
    return Booking.create({
      user: customers[i]._id, station: station._id, fuelType, quantity: 5, price: 100, amount: 505,
      bookingDate: TODAY, timeSlot: LABELS[i % LABELS.length], bookingStartTime: w.start, bookingEndTime: w.end,
      payMethod: "station", paymentStatus: "due_at_station", status: "upcoming",
      verificationCode: code, serviceDurationSeconds,
    });
  };

  try {
    await t.test("bookings made through the API carry their fuel's duration", async () => {
      const cases = [["Petrol", 5, 40], ["Petrol", 20, 40], ["Diesel", 8, 40], ["CNG", 10, 300]];
      let i = 4;
      for (const [fuelType, quantity, expected] of cases) {
        const r = await call("POST", "/api/bookings", tokenFor(customers[i++]._id), {
          stationId: String(station._id), fuelType, quantity, bookingDate: "2099-12-01", timeSlot: `${i + 1}:00 PM`, payMethod: "station",
        });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.booking.serviceDurationSeconds, expected, `${fuelType} ${quantity}`);
      }
    });

    for (const [fuelType, code, seconds] of [["Petrol", "4101", 2], ["Diesel", "4102", 2], ["CNG", "4103", 2]]) {
      await t.test(`${fuelType}: the 4-digit code starts fueling, and the server completes it automatically`, async () => {
        const booking = await todayBooking(fuelType, code, seconds);
        const beforeSales = await InventoryMovement.countDocuments({ station: station._id, type: "sale", fuel: fuelType.toLowerCase() });

        // A wrong code does nothing.
        const wrong = await call("POST", "/api/bookings/verify", tokenFor(vendor._id), { verificationCode: "9999" });
        assert.equal(wrong.status, 404);
        assert.equal((await reload(booking._id)).status, "upcoming");

        const r = await call("POST", "/api/bookings/verify", tokenFor(vendor._id), { verificationCode: code });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.started, true);

        const started = await reload(booking._id);
        assert.equal(started.status, "serving");
        assert.ok(started.fuelingStartTime, "start time stamped by the server");
        const releaseAt = new Date(started.fuelingStartTime).getTime() + seconds * 1000;
        assert.ok(Math.abs(new Date(r.body.completesAt).getTime() - releaseAt) < 5, "completesAt = stored start + stored duration");

        // "Refresh / restart": timers dropped and recovered -- from the stored start, not from now.
        serviceTimer.clearAllTimers();
        const rec = await serviceTimer.recoverServiceTimers({ stationIds: [station._id] });
        assert.ok(rec.scheduled >= 1);
        assert.equal((await reload(booking._id)).fuelingStartTime.getTime(), started.fuelingStartTime.getTime(), "the start time never moves");

        // Not before its time...
        if (Date.now() < releaseAt - 300) assert.equal((await reload(booking._id)).status, "serving");

        // ...then completed by the server, with no further request.
        await waitFor(async () => (await reload(booking._id)).status === "completed", seconds * 1000 + 3000, `${fuelType} auto-completion`);
        const done = await reload(booking._id);
        const heldMs = new Date(done.completionTime) - new Date(done.fuelingStartTime);
        assert.ok(heldMs >= seconds * 1000 && heldMs < seconds * 1000 + 2000, `${fuelType} held ${heldMs} ms for ${seconds} s`);

        // The status flips first; the stock movement is the next write
        // (bookingCompletion.js), so give it a moment before counting.
        const sales = () => InventoryMovement.countDocuments({ station: station._id, type: "sale", fuel: fuelType.toLowerCase() });
        await waitFor(async () => (await sales()) > beforeSales, 2000, `${fuelType} stock movement`).catch(() => {});
        assert.equal(
          await sales(),
          beforeSales + 1,
          "stock deducted once",
        );
        const notes = () => Notification.countDocuments({ booking: booking._id, type: "booking_completed" });
        await waitFor(async () => (await notes()) > 0, 2000, `${fuelType} completion notice`).catch(() => {});
        assert.equal(await notes(), 1, "customer notified once");

        // The vendor's booking list shows it completed.
        const list = await call("GET", `/api/vendor-panel/stations/${station._id}/bookings`, tokenFor(vendor._id));
        assert.equal(list.status, 200);
        const row = (Array.isArray(list.body) ? list.body : list.body.bookings || []).find((b) => String(b._id) === String(booking._id));
        assert.equal(row?.status, "completed");

        // The code cannot start it again.
        const again = await call("POST", "/api/bookings/verify", tokenFor(vendor._id), { verificationCode: code });
        assert.notEqual(again.status, 200);
      });
    }
  } finally {
    serviceTimer.clearAllTimers();
    await new Promise((resolve) => server.close(resolve));
    const ids = (await Booking.find({ station: station._id }).select("_id").lean()).map((b) => b._id);
    await Notification.deleteMany({ booking: { $in: ids } });
    await InventoryMovement.deleteMany({ station: station._id });
    await require("../src/models/BookingAttempt").deleteMany({ station: station._id });
    await Booking.deleteMany({ station: station._id });
    await Station.deleteOne({ _id: station._id });
    await User.deleteMany({ _id: { $in: [vendor._id, ...customers.map((c) => c._id)] } });
    await mongoose.disconnect();
  }
});
