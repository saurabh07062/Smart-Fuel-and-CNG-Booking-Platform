/**
 * Fuel-specific queues and the pre-booking estimate.
 *
 *   - service time from the booked quantity (config/fuelDurations.js)
 *   - one line per fuel: a CNG fill never delays Petrol (services/queue/stationQueue.js)
 *   - the pre-booking estimate: remaining time of the vehicle at the nozzle
 *     plus every vehicle ahead, each for its own quantity (buildQueuePreview)
 *   - per-fuel nozzle windows and database guards (nozzleScheduler, models/Booking.js)
 *   - vendor-recorded walk-ins joining, starting and leaving a fuel's line
 *     (services/queue/walkIns.js, services/queue/nozzleService.js)
 *
 * DEVELOPMENT TEST DATA, test database only: tagged users and stations with no
 * map position, bookings and walk-ins dated today; all removed at the end.
 *
 *   node --test test/fuelQueue.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { getServiceDurationSeconds } = require("../src/config/fuelDurations");
const { simulateStation, maskVehicle } = require("../src/services/queue/stationQueue");

test.after(async () => {
  require("../src/services/queue/serviceTimer").clearAllTimers();
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

test("service time comes from the booked quantity", () => {
  assert.deepEqual(
    [10, 5, 8, 3].map((q) => getServiceDurationSeconds("Petrol", q)),
    [40, 23, 33, 16],
    "6 s + 3.4 s per litre",
  );
  assert.equal(getServiceDurationSeconds("diesel", 10), 40);
  assert.equal(getServiceDurationSeconds("CNG", 20), 300, "60 s + 12 s per kg");
  assert.equal(getServiceDurationSeconds("petrol"), 40, "no quantity: a typical fill");
  assert.equal(getServiceDurationSeconds("cng"), 300);
  assert.ok(getServiceDurationSeconds("cng", 60) < 30 * 60, "the largest fill still fits inside a slot gap");
});

test("each fuel is its own line: a long CNG line never adds to Petrol's wait", () => {
  const now = new Date("2099-01-01T05:00:00Z");
  const ago = (s) => new Date(now.getTime() - s * 1000);
  const rows = [
    { _id: "cng-serving", status: "serving", fuelType: "CNG", fuelingStartTime: ago(10), serviceDurationSeconds: 780 },
    { _id: "cng-waiting", status: "upcoming", fuelType: "CNG", arrivalTime: ago(5), serviceDurationSeconds: 780 },
    { _id: "petrol-serving", status: "serving", fuelType: "Petrol", fuelingStartTime: ago(10), serviceDurationSeconds: 40 },
  ];
  const s = simulateStation(rows, now);
  assert.equal(s.byFuel.petrol.queueLength, 1);
  assert.equal(s.byFuel.petrol.waitMinutes, 1, "30 s left on the petrol fill, nothing from CNG");
  assert.equal(s.byFuel.cng.queueLength, 2);
  assert.equal(s.byFuel.diesel.queueLength, 0);
  assert.equal(s.queueLength, 3);
  const petrolEta = s.etas.find((e) => e.bookingId === "petrol-serving");
  assert.equal(petrolEta.position, 1, "positions count within a fuel");
});

test("vehicle numbers are masked for the public queue", () => {
  assert.equal(maskVehicle("MH12AB1234"), "MH12 •••• 34");
  assert.equal(maskVehicle("mh 12 ab 1234"), "MH12 •••• 34");
  assert.equal(maskVehicle("F101"), null, "too short to mask safely");
  assert.equal(maskVehicle(null), null);
});

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

test("fuel queues against MongoDB", async (t) => {
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
  const WalkIn = require("../src/models/WalkIn");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");
  const nozzleService = require("../src/services/queue/nozzleService");
  const serviceTimer = require("../src/services/queue/serviceTimer");
  const walkIns = require("../src/services/queue/walkIns");
  const { buildQueuePreview } = require("../src/services/queue/stationQueue");
  const { dateKey } = require("../src/config/businessTime");
  await Promise.all([Booking.init(), WalkIn.init()]);

  // The per-fuel guards must be in place (scripts/migrations/perFuelNozzleIndexes.js).
  const indexNames = (await Booking.collection.indexes()).map((i) => i.name);
  if (indexNames.includes("uniq_active_nozzle_start") || indexNames.includes("uniq_serving_per_station")) {
    t.skip("the test database still has the station-wide nozzle indexes: run scripts/migrations/perFuelNozzleIndexes.js --apply on it");
    return;
  }

  const TODAY = dateKey();
  const tag = `fuelqueue-${Date.now()}`;
  const customers = await User.insertMany(
    Array.from({ length: 8 }, (_, i) => ({
      name: `${tag}-c${i}`,
      email: `${tag}-c${i}@example.com`,
      password: "not-a-real-hash",
      role: "customer",
      isVerified: true,
    })),
  );
  const stationIds = [];
  const makeStation = async (name) => {
    const s = await Station.create({
      name: `${tag}-${name}`,
      address: "Fuel Queue Test",
      status: "Active",
      fuelTypes: ["Petrol", "Diesel", "CNG"],
      prices: { petrol: 100, diesel: 90, cng: 80 },
      inventory: { petrol: 1000, diesel: 1000, cng: 1000 },
    });
    stationIds.push(s._id);
    return s;
  };
  let next = 0;
  const LABELS = ["6:00 AM", "6:30 AM", "7:00 AM", "7:30 AM", "8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM"];
  const book = (station, fuelType, quantity, fields = {}) => {
    const i = next++;
    const label = fields.timeSlot || LABELS[i];
    const start = nozzleScheduler.parseStartDateTime(TODAY, label);
    const w = nozzleScheduler.computeWindow(fuelType, start, quantity);
    return Booking.create({
      user: customers[i]._id,
      station: station._id,
      fuelType,
      quantity,
      price: 100,
      amount: quantity * 100 + 5,
      bookingDate: TODAY,
      timeSlot: label,
      bookingStartTime: w.start,
      bookingEndTime: w.end,
      serviceDurationSeconds: w.durationSeconds,
      payMethod: "station",
      paymentStatus: "due_at_station",
      status: "upcoming",
      ...fields,
    });
  };
  const ago = (s) => new Date(Date.now() - s * 1000);
  const near = (actual, expected, tolerance, label) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ~${expected}, got ${actual}`);

  try {
    await t.test("pre-booking estimate: remaining time of the vehicle at the nozzle plus each one ahead", async () => {
      const s = await makeStation("estimate");
      // F101: 10 L petrol, at the nozzle for 10 s of its 40 s.
      await book(s, "Petrol", 10, { status: "serving", arrivalTime: ago(12), fuelingStartTime: ago(10), vehiclePlate: "MH12AB1101" });
      // F102-F104 waiting at the nozzle: 5 L, 8 L, 3 L.
      for (const [qty, secs] of [[5, 9], [8, 8], [3, 7]]) {
        await WalkIn.create({
          station: s._id, fuelType: "Petrol", quantity: qty, status: "waiting", businessDate: TODAY,
          arrivalTime: ago(secs), serviceDurationSeconds: getServiceDurationSeconds("Petrol", qty),
        });
      }
      // A long CNG fill at the same station: a different nozzle.
      await WalkIn.create({
        station: s._id, fuelType: "CNG", quantity: 50, status: "serving", businessDate: TODAY,
        arrivalTime: ago(20), fuelingStartTime: ago(15), serviceDurationSeconds: getServiceDurationSeconds("CNG", 50),
      });

      const p = await buildQueuePreview({ stationId: s._id, fuelType: "Petrol", quantity: 10 });
      assert.equal(p.fuelType, "Petrol");
      assert.equal(p.currentServing.vehicle, "MH12 •••• 01");
      near(p.currentServing.remainingSeconds, 30, 2, "F101 remaining");
      assert.equal(p.vehiclesWaiting, 3);
      assert.deepEqual(p.queue.map((q) => [q.status, q.quantity, q.serviceSeconds]), [
        ["serving", 10, 40],
        ["waiting", 5, 23],
        ["waiting", 8, 33],
        ["waiting", 3, 16],
      ]);
      assert.equal(p.you.vehiclesAhead, 4);
      assert.equal(p.you.serviceSeconds, 40);
      near(p.you.estimatedWaitSeconds, 30 + 23 + 33 + 16, 2, "wait = remaining F101 + F102 + F103 + F104");
      assert.equal(p.you.estimatedCompleteAt - p.you.estimatedStartAt, 40_000);

      const cng = await buildQueuePreview({ stationId: s._id, fuelType: "CNG", quantity: 10 });
      assert.equal(cng.you.vehiclesAhead, 1, "the CNG line holds only the CNG vehicle");
      const diesel = await buildQueuePreview({ stationId: s._id, fuelType: "Diesel", quantity: 10 });
      assert.equal(diesel.you.vehiclesAhead, 0);
      assert.equal(diesel.you.estimatedWaitSeconds, 0, "an empty Diesel nozzle: no wait, whatever Petrol and CNG hold");
    });

    await t.test("nozzle windows and database guards are per fuel", async () => {
      const s = await makeStation("windows");
      const petrol = await book(s, "Petrol", 10, { timeSlot: "10:00 PM" });
      const start = petrol.bookingStartTime;
      const cngWindow = nozzleScheduler.computeWindow("CNG", start, 20);
      assert.equal(await nozzleScheduler.hasOverlap(s._id, cngWindow.start, cngWindow.end, undefined, { fuelType: "CNG" }), false);
      assert.equal(await nozzleScheduler.hasOverlap(s._id, start, petrol.bookingEndTime, undefined, { fuelType: "Petrol" }), true);

      // Same start, different fuel: allowed by the database.
      await book(s, "CNG", 20, { timeSlot: "10:00 PM" });
      // Same start, same fuel: refused by uniq_active_nozzle_start_per_fuel.
      await assert.rejects(book(s, "Petrol", 5, { timeSlot: "10:00 PM" }), (err) => err.code === 11000);
    });

    await t.test("a vehicle at the CNG nozzle does not stop a Petrol check-in", async () => {
      const s = await makeStation("checkin");
      await book(s, "CNG", 20, { status: "serving", arrivalTime: ago(5), fuelingStartTime: ago(5) });
      const petrol = await book(s, "Petrol", 10);
      const r = await nozzleService.checkIn({ bookingId: petrol._id });
      assert.equal(r.outcome, "started");
      const secondPetrol = await book(s, "Petrol", 5);
      assert.equal((await nozzleService.checkIn({ bookingId: secondPetrol._id })).outcome, "queued", "same fuel waits");
      serviceTimer.clearAllTimers();
      await Booking.updateMany({ station: s._id, status: { $in: ["serving", "upcoming"] } }, { $set: { status: "cancelled" } });
    });

    await t.test("walk-ins join their fuel's line, start when the nozzle frees, and leave", async () => {
      const s = await makeStation("walkins");
      const first = await walkIns.addWalkIn({ stationId: s._id, fuelType: "Petrol", quantity: 5, vehicleNumber: "MH12CD5678" });
      assert.equal(first.status, "serving", "nozzle free: starts at once");
      assert.equal(first.serviceDurationSeconds, 23);
      const second = await walkIns.addWalkIn({ stationId: s._id, fuelType: "Petrol", quantity: 8 });
      assert.equal(second.status, "waiting");
      const cng = await walkIns.addWalkIn({ stationId: s._id, fuelType: "CNG", quantity: 10 });
      assert.equal(cng.status, "serving", "another fuel's nozzle is free");

      // A booked car checking in behind the waiting walk-in waits its turn.
      const booked = await book(s, "Petrol", 10);
      assert.equal((await nozzleService.checkIn({ bookingId: booked._id })).outcome, "queued");

      const preview = await buildQueuePreview({ stationId: s._id, fuelType: "Petrol", quantity: 10 });
      assert.deepEqual(preview.queue.map((q) => [q.kind, q.status]), [
        ["walkin", "serving"],
        ["walkin", "waiting"],
        ["booking", "waiting"],
      ]);

      await walkIns.updateWalkIn({ stationId: s._id, walkInId: first._id, action: "complete" });
      assert.equal((await WalkIn.findById(second._id).lean()).status, "serving", "arrived first: gets the nozzle");
      assert.equal((await Booking.findById(booked._id).lean()).status, "upcoming");

      await walkIns.updateWalkIn({ stationId: s._id, walkInId: second._id, action: "cancel" });
      assert.equal((await WalkIn.findById(second._id).lean()).status, "cancelled");
      assert.equal((await Booking.findById(booked._id).lean()).status, "serving", "the booked car is next");

      await assert.rejects(
        walkIns.addWalkIn({ stationId: s._id, fuelType: "Petrol", quantity: 0 }),
        (err) => err.status === 400,
      );
      serviceTimer.clearAllTimers();
      await Booking.updateMany({ station: s._id, status: { $in: ["serving", "upcoming"] } }, { $set: { status: "cancelled" } });
      await WalkIn.updateMany({ station: s._id, status: { $in: ["serving", "waiting"] } }, { $set: { status: "cancelled" } });
    });

    await t.test("a walk-in completes by itself at its release time and hands over", async () => {
      const s = await makeStation("walkin-timer");
      const a = await WalkIn.create({
        station: s._id, fuelType: "Diesel", quantity: 1, status: "serving", businessDate: TODAY,
        arrivalTime: ago(5), fuelingStartTime: ago(5), serviceDurationSeconds: 1,
      });
      const b = await WalkIn.create({
        station: s._id, fuelType: "Diesel", quantity: 1, status: "waiting", businessDate: TODAY,
        arrivalTime: ago(4), serviceDurationSeconds: 1,
      });
      const { sweepInProgressBookings } = require("../src/services/booking/bookingSweep");
      const r = await sweepInProgressBookings(undefined, { stationIds: [s._id] });
      assert.equal(r.completed, 1);
      assert.equal((await WalkIn.findById(a._id).lean()).status, "completed");
      assert.equal((await WalkIn.findById(b._id).lean()).status, "serving");
      serviceTimer.clearAllTimers();
      await WalkIn.updateMany({ station: s._id, status: "serving" }, { $set: { status: "cancelled" } });
    });
  } finally {
    serviceTimer.clearAllTimers();
    await Booking.deleteMany({ station: { $in: stationIds } });
    await WalkIn.deleteMany({ station: { $in: stationIds } });
    await Station.deleteMany({ _id: { $in: stationIds } });
    await User.deleteMany({ _id: { $in: customers.map((c) => c._id) } });
    await mongoose.disconnect();
  }
});
