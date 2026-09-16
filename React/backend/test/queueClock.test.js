/**
 * The queue clock: the line, waits and ETAs move with time alone, and are
 * pushed exactly when they change (services/queue/stationQueue.js nextQueueChange,
 * reconcileQueues).
 *
 * DEVELOPMENT TEST DATA, test database only: one tagged station and booking
 * on 2099-07-05 with an injected clock; removed at the end.
 *
 *   node --test test/queueClock.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { nextQueueChange, reconcileQueues } = require("../src/services/queue/stationQueue");
const nozzleScheduler = require("../src/services/queue/nozzleScheduler");
const { atBusinessTime } = require("../src/config/businessTime");

const DATE = "2099-07-05";
const at = (h, m = 0, s = 0) => new Date(atBusinessTime(DATE, h, m).getTime() + s * 1000);

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

test("nextQueueChange: nothing live means nothing to wake for", () => {
  assert.equal(nextQueueChange([], at(10)), null);
});

test("nextQueueChange: an upcoming booking's ETA ticks every minute until its slot starts", () => {
  const b = { _id: "b1", status: "upcoming", fuelType: "Petrol", bookingStartTime: at(10), bookingEndTime: at(10, 0, 40) };
  assert.equal(nextQueueChange([b], at(9, 50)).getTime(), at(9, 51).getTime(), "10 min -> 9 min at 9:51");
  assert.equal(nextQueueChange([b], at(9, 59, 30)).getTime(), at(10).getTime(), "the slot start itself");
});

test("nextQueueChange: a fill in progress wakes when the wait next ticks down, not only when it ends", () => {
  const serving = { _id: "s1", status: "serving", fuelType: "CNG", fuelingStartTime: at(10), serviceDurationSeconds: 300 };
  // At 10:01 the line clears at 10:05 (4 min): the wait reads 3 at 10:02.
  assert.equal(nextQueueChange([serving], at(10, 1)).getTime(), at(10, 2).getTime());
});

// ---------------------------------------------------------------------------
// MongoDB (test database)
// ---------------------------------------------------------------------------

test("queue clock against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const tag = `qclock-${Date.now()}`;
  const station = await Station.create({
    name: `${tag}-station`,
    address: "Queue Clock Test",
    status: "Active",
    fuelTypes: ["Petrol"],
    prices: { petrol: 100 },
    inventory: { petrol: 1000 },
  });
  const start = nozzleScheduler.parseStartDateTime(DATE, "10:00 AM");
  const w = nozzleScheduler.computeWindow("Petrol", start);
  const booking = await Booking.create({
    user: new mongoose.Types.ObjectId(),
    station: station._id,
    fuelType: "Petrol",
    quantity: 5,
    price: 100,
    amount: 505,
    bookingDate: DATE,
    timeSlot: "10:00 AM",
    bookingStartTime: w.start,
    bookingEndTime: w.end,
    status: "upcoming",
  });

  const run = (now) => reconcileQueues({ now, stationIds: [station._id] });
  const cached = async () => Station.findById(station._id).select("queueLength waitMinutes").lean();
  const eta = async () => (await Booking.findById(booking._id).select("etaMinutes").lean()).etaMinutes;

  try {
    await t.test("before the slot: the ETA is pushed, then nothing until it actually changes", async () => {
      const first = await run(at(9, 50));
      assert.equal(first.refreshed, 1);
      assert.equal(await eta(), 10);
      assert.equal(first.nextAt.getTime(), at(9, 51).getTime(), "wakes at the next minute tick, not on a poll");

      assert.equal((await run(at(9, 50, 20))).refreshed, 0, "no change, no push");
      assert.equal((await run(at(9, 51))).refreshed, 1);
      assert.equal(await eta(), 9);
    });

    await t.test("the slot starting puts the car in line with nothing else happening", async () => {
      assert.equal((await run(at(10, 0, 10))).refreshed, 1);
      assert.deepEqual(await cached(), { _id: station._id, queueLength: 1, waitMinutes: 1 });
    });

    await t.test("a slot that passes with no arrival drops out, and the station's line clears", async () => {
      assert.equal((await run(at(10, 31))).refreshed, 1);
      const after = await cached();
      assert.equal(after.queueLength, 0);
      assert.equal(after.waitMinutes, 0);
      assert.equal((await run(at(10, 32))).refreshed, 0, "an empty line is not pushed again");
    });
  } finally {
    await Booking.deleteMany({ station: station._id });
    await Station.deleteOne({ _id: station._id });
    await mongoose.disconnect();
  }
});
