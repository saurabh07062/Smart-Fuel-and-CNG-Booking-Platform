/**
 * Concurrent check-ins through the real API (POST /api/bookings/verify) on
 * the running test server: one car at a nozzle, the rest waiting, a double
 * tap counted once, and the line draining by itself -- each fill completed at
 * its release time by the server's own timers, the nozzle handed to the next
 * car without any further request.
 *
 * DEVELOPMENT TEST DATA, test database only: a tagged activated vendor, their
 * station and customers; bookings dated today with SHORT stored service
 * durations (2 s) so the automatic drain can be watched. Removed at the end.
 *
 *   npm run test:server        (in another terminal)
 *   node --test test/checkInRace.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const API = require("./helpers/testDb").apiUrl();
const MONGO = require("./helpers/testDb").uri();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("concurrent PIN check-ins through the API", async (t) => {
  const reachable = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    t.skip(`API not reachable at ${API} -- start it with npm run test:server`);
    return;
  }

  const mongoose = require("mongoose");
  const jwt = require("jsonwebtoken");
  await mongoose.connect(MONGO);
  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");
  const { dateKey } = require("../src/config/businessTime");

  const TODAY = dateKey();
  const tag = `race-${Date.now()}`;
  const vendor = await User.create({
    name: `${tag}-vendor`,
    email: `${tag}-vendor@example.com`,
    password: "not-a-real-hash",
    role: "vendor",
    vendorStatus: "active",
    activated: true,
    isVerified: true,
  });
  const customers = await User.insertMany(
    Array.from({ length: 6 }, (_, i) => ({
      name: `${tag}-c${i}`,
      email: `${tag}-c${i}@example.com`,
      password: "not-a-real-hash",
      role: "customer",
      isVerified: true,
    })),
  );
  const station = await Station.create({
    name: `${tag}-station`,
    address: "Check-in Race Test",
    owner: vendor._id,
    status: "Active",
    fuelTypes: ["Petrol"],
    prices: { petrol: 100 },
    inventory: { petrol: 1000 },
  });
  const LABELS = ["8:00 PM", "8:30 PM", "9:00 PM", "9:30 PM", "7:30 PM", "7:00 PM"];
  const token = jwt.sign({ user: { id: String(vendor._id) } }, process.env.JWT_SECRET, { expiresIn: "10m" });
  const scan = (bookingId) =>
    fetch(`${API}/api/bookings/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-auth-token": token },
      body: JSON.stringify({ bookingId: String(bookingId) }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const book = (i) => {
    const w = nozzleScheduler.computeWindow("Petrol", nozzleScheduler.parseStartDateTime(TODAY, LABELS[i]));
    return Booking.create({
      user: customers[i]._id,
      station: station._id,
      fuelType: "Petrol",
      quantity: 5,
      price: 100,
      amount: 505,
      bookingDate: TODAY,
      timeSlot: LABELS[i],
      bookingStartTime: w.start,
      bookingEndTime: w.end,
      serviceDurationSeconds: 2,
      payMethod: "station",
      paymentStatus: "due_at_station",
      status: "upcoming",
    });
  };
  const count = (status) => Booking.countDocuments({ station: station._id, status });

  try {
    await t.test("5 cars scanned at the same instant: one fueling, four waiting, never two on the nozzle", async () => {
      const bookings = await Promise.all([0, 1, 2, 3, 4].map(book));
      const results = await Promise.all(bookings.map((b) => scan(b._id)));
      assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => [r.status, r.body.msg])));
      assert.equal(results.filter((r) => r.body.started).length, 1, "exactly one car started");
      assert.equal(results.filter((r) => r.body.queued).length, 4, "the other four wait");
      assert.equal(await count("serving"), 1);

      // Watch the whole drain: sample often, and fail if two cars ever serve at once.
      let maxServing = 0;
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        const serving = await count("serving");
        maxServing = Math.max(maxServing, serving);
        if ((await count("completed")) === 5) break;
        await sleep(100);
      }
      assert.equal(maxServing, 1, "the nozzle was never shared");
      assert.equal(await count("completed"), 5, "each fill completed and the next car started automatically");
      assert.equal(await count("serving"), 0, "nozzle released at the end");

      const done = await Booking.find({ station: station._id, status: "completed" }).sort({ fuelingStartTime: 1 }).lean();
      for (let i = 0; i < done.length; i++) {
        const held = new Date(done[i].completionTime) - new Date(done[i].fuelingStartTime);
        assert.ok(held >= 2000, `fill ${i + 1} held the nozzle ${held} ms of its 2 s`);
        if (i > 0) {
          assert.ok(new Date(done[i].fuelingStartTime) >= new Date(done[i - 1].completionTime), `car ${i + 1} started only after car ${i} finished`);
        }
      }
    });

    await t.test("a double tap: 5 simultaneous scans of one PIN check it in once", async () => {
      const b = await book(5);
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => scan(b._id)));
      const started = results.filter((r) => r.body.started).length;
      assert.equal(started, 1, JSON.stringify(results.map((r) => [r.status, r.body.msg])));
      assert.ok(
        results.filter((r) => !r.body.started).every((r) => r.status === 409),
        "the repeats are refused as already checked in",
      );
      assert.equal(await count("serving"), 1);
    });
  } finally {
    // Let a fill still running finish so the server's timer finds nothing left to hand over.
    await sleep(2500);
    await Booking.deleteMany({ station: station._id });
    await require("../src/models/InventoryMovement").deleteMany({ station: station._id });
    await require("../src/models/Notification").deleteMany({ user: { $in: [vendor._id, ...customers.map((c) => c._id)] } });
    await require("../src/models/BookingAttempt").deleteMany({ user: { $in: customers.map((c) => c._id) } });
    await require("../src/models/SecurityEvent").deleteMany({ user: vendor._id });
    await Station.deleteOne({ _id: station._id });
    await User.deleteMany({ _id: { $in: [vendor._id, ...customers.map((c) => c._id)] } });
    await mongoose.disconnect();
    await require("../src/services/core/lock").close();
    await require("../src/services/security/rateLimiter").close();
  }
});
