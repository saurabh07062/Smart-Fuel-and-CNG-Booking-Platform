/**
 * The nozzle as a locked resource at the pump (services/queue/nozzleService.js):
 * one car serving per station under concurrent check-ins, the database guard,
 * waiting at the pump, hand-over order, and the check-in routes.
 *
 * DEVELOPMENT TEST DATA, test database only: tagged users and a tagged station
 * with no map position; bookings dated today (check-in is only for today's
 * bookings) at slots no other test uses; all removed at the end.
 *
 *   node --test test/serviceLock.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { simulateNozzleLine } = require("../src/services/queue/stationQueue");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

test("queue: cars checked in at the pump come right after the car being served, in arrival order", () => {
  const now = new Date("2099-01-01T05:00:00Z");
  const at = (s) => new Date(now.getTime() + s * 1000);
  const line = simulateNozzleLine(
    [
      { _id: "serving", status: "serving", fuelType: "Petrol", fuelingStartTime: at(-10), serviceDurationSeconds: 40 },
      { _id: "late-arrival", status: "upcoming", fuelType: "Petrol", arrivalTime: at(-2), serviceDurationSeconds: 40, bookingStartTime: at(-3600) },
      { _id: "first-arrival", status: "upcoming", fuelType: "CNG", arrivalTime: at(-5), serviceDurationSeconds: 300, bookingStartTime: at(3600) },
    ],
    now,
  );
  assert.deepEqual(line.etas.map((e) => [e.bookingId, e.position]), [["serving", 1], ["first-arrival", 2], ["late-arrival", 3]]);
  assert.equal(line.queueLength, 3, "an arrived car is in line even if its slot has not started or has passed");
  assert.equal(line.etas[1].turnAt, at(30).getTime(), "starts when the serving car's 40 s run out");
  assert.equal(line.etas[2].turnAt, at(330).getTime(), "then after the CNG fill");
});

// ---------------------------------------------------------------------------
// MongoDB (test database)
// ---------------------------------------------------------------------------

test("nozzle lock against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const nozzleService = require("../src/services/queue/nozzleService");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");
  const { completeBooking } = require("../src/services/booking/bookingCompletion");
  const { transitionBooking } = require("../src/services/booking/bookingTransitions");
  const { expireUserPastBookings } = require("../src/services/booking/bookingCreate");
  const bookingController = require("../src/controllers/bookingController");
  const vendorPanel = require("../src/controllers/vendorPanelController");
  const { dateKey } = require("../src/config/businessTime");
  await Booking.init();

  const TODAY = dateKey();
  const tag = `nozlock-${Date.now()}`;
  const vendor = await User.create({
    name: `${tag}-vendor`,
    email: `${tag}-vendor@example.com`,
    password: "not-a-real-hash",
    role: "vendor",
    vendorStatus: "active",
    activated: true,
  });
  const customers = await User.insertMany(
    Array.from({ length: 8 }, (_, i) => ({
      name: `${tag}-c${i}`,
      email: `${tag}-c${i}@example.com`,
      password: "not-a-real-hash",
      role: "customer",
      isVerified: true,
    })),
  );
  const station = await Station.create({
    name: `${tag}-station`,
    address: "Nozzle Lock Test",
    owner: vendor._id,
    status: "Active",
    fuelTypes: ["Petrol", "CNG"],
    prices: { petrol: 100, cng: 80 },
    inventory: { petrol: 1000, cng: 1000 },
  });
  const LABELS = ["8:00 PM", "8:30 PM", "9:00 PM", "9:30 PM", "7:00 PM", "7:30 PM", "6:00 PM", "6:30 PM"];
  const book = (i, fields = {}) => {
    const start = nozzleScheduler.parseStartDateTime(TODAY, LABELS[i]);
    const w = nozzleScheduler.computeWindow(fields.fuelType || "Petrol", start);
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
      serviceDurationSeconds: w.durationSeconds,
      payMethod: "station",
      paymentStatus: "due_at_station",
      status: "upcoming",
      ...fields,
    });
  };
  const servingCount = () => Booking.countDocuments({ station: station._id, status: "serving" });
  const reload = (b) => Booking.findById(b._id).lean();
  const res = () => ({
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  });

  try {
    let bookings;

    await t.test("5 simultaneous check-ins: exactly one car gets the nozzle, four wait at the pump", async () => {
      bookings = await Promise.all([0, 1, 2, 3, 4].map((i) => book(i)));
      const results = await Promise.all(bookings.map((b) => nozzleService.checkIn({ bookingId: b._id })));
      const outcomes = results.map((r) => r.outcome).sort();
      assert.deepEqual(outcomes, ["queued", "queued", "queued", "queued", "started"], JSON.stringify(outcomes));
      assert.equal(await servingCount(), 1);
      const started = results.find((r) => r.outcome === "started");
      assert.ok(started.releaseAt > started.booking.fuelingStartTime, "the release time is start + service duration");
      for (const r of results.filter((x) => x.outcome === "queued")) {
        const saved = await reload(r.booking);
        assert.equal(saved.status, "upcoming");
        assert.ok(saved.arrivalTime, "arrival recorded");
        assert.equal(saved.fuelingStartTime ?? null, null, "no fueling while the nozzle is busy");
      }
    });

    await t.test("the database refuses a second serving booking at the station, even bypassing the lock", async () => {
      const waiting = await Booking.findOne({ station: station._id, status: "upcoming", arrivalTime: { $ne: null } }).lean();
      assert.equal(await transitionBooking({ bookingId: waiting._id, to: "serving" }), null);
      await assert.rejects(
        Booking.updateOne({ _id: waiting._id }, { $set: { status: "serving" } }),
        (err) => err.code === 11000 && /uniq_serving_per_station/.test(err.message),
      );
      assert.equal(await servingCount(), 1);
    });

    await t.test("re-scanning a waiting car keeps its place and first arrival time", async () => {
      const waiting = await Booking.findOne({ station: station._id, status: "upcoming", arrivalTime: { $ne: null } }).lean();
      const again = await nozzleService.checkIn({ bookingId: waiting._id });
      assert.equal(again.outcome, "already_waiting");
      assert.equal(String((await reload(waiting)).arrivalTime), String(waiting.arrivalTime));
    });

    await t.test("release: nothing starts while a car is serving; afterwards the earliest arrival starts", async () => {
      assert.equal(await nozzleService.advanceNozzle(station._id), null, "still serving");
      const serving = await Booking.findOne({ station: station._id, status: "serving" }).lean();
      const firstWaiting = await Booking.findOne({ station: station._id, status: "upcoming", arrivalTime: { $ne: null } })
        .sort({ arrivalTime: 1, _id: 1 })
        .lean();
      assert.ok(await completeBooking({ bookingId: serving._id, fromStatuses: ["serving"] }));

      const racers = await Promise.all([1, 2, 3].map(() => nozzleService.advanceNozzle(station._id)));
      const startedIds = racers.filter(Boolean).map((b) => String(b._id));
      assert.deepEqual(startedIds, [String(firstWaiting._id)], "three releases racing start exactly one car: the first to arrive");
      assert.equal(await servingCount(), 1);
    });

    await t.test("a car waiting at the pump is not expired by the customer's own expiry check", async () => {
      const waiting = await Booking.findOne({ station: station._id, status: "upcoming", arrivalTime: { $ne: null } }).lean();
      await expireUserPastBookings(waiting.user);
      assert.equal((await reload(waiting)).status, "upcoming");
    });

    await t.test("PIN scan and vendor start both go through the lock: busy nozzle -> 200, waiting", async () => {
      const scanned = await book(5);
      const r = res();
      await bookingController.verifyBooking(
        { body: { bookingId: String(scanned._id) }, user: { id: String(vendor._id), role: "admin" }, app: { get: () => null } },
        r,
      );
      assert.equal(r.statusCode, 200, JSON.stringify(r.body));
      assert.equal(r.body.queued, true);
      assert.match(r.body.msg, /nozzle is busy/);
      assert.equal((await reload(scanned)).paymentStatus, "paid", "pay-at-station is collected at the scan");

      const started = await book(6);
      const vr = res();
      await vendorPanel.updateBookingStatus(
        {
          params: { stationId: String(station._id), bookingId: String(started._id) },
          body: { status: "serving" },
          user: { id: String(vendor._id), role: "vendor" },
          app: { get: () => null },
        },
        vr,
      );
      assert.equal(vr.statusCode, 200, JSON.stringify(vr.body));
      assert.equal((await reload(started)).status, "upcoming", "the vendor cannot start a second car on a busy nozzle");
      assert.ok((await reload(started)).arrivalTime);
      assert.equal(await servingCount(), 1);
    });

    await t.test("drain the line: every release hands the nozzle to the next arrival until nobody waits", async () => {
      const order = [];
      for (let guard = 0; guard < 10; guard++) {
        const serving = await Booking.findOne({ station: station._id, status: "serving" }).lean();
        if (!serving) break;
        order.push(String(serving._id));
        await completeBooking({ bookingId: serving._id, fromStatuses: ["serving"] });
        await nozzleService.advanceNozzle(station._id);
      }
      assert.equal(await servingCount(), 0);
      assert.equal(await Booking.countDocuments({ station: station._id, status: "upcoming", arrivalTime: { $ne: null } }), 0);
      assert.equal(new Set(order).size, order.length, "no booking served twice");
      assert.equal(await Booking.countDocuments({ station: station._id, status: "completed" }), 7, "all seven checked-in cars were served once");
    });
  } finally {
    await Booking.deleteMany({ station: station._id });
    await require("../src/models/InventoryMovement").deleteMany({ station: station._id });
    await require("../src/models/Notification").deleteMany({ user: { $in: [vendor._id, ...customers.map((c) => c._id)] } });
    await Station.deleteOne({ _id: station._id });
    await User.deleteMany({ _id: { $in: [vendor._id, ...customers.map((c) => c._id)] } });
    await mongoose.disconnect();
  }
});
