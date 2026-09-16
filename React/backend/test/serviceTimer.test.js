/**
 * Automatic completion and hand-over (services/queue/serviceTimer.js): a fill
 * completes at its release time (never before), the nozzle passes to the next
 * car waiting at the pump, duplicate timers and racing completions complete
 * once, a restart recovers fills from their stored start time, and the sweep
 * picks up a missed hand-over.
 *
 * DEVELOPMENT TEST DATA, test database only: tagged users and stations with no
 * map position, bookings dated today with SHORT fixture service durations (1-2
 * seconds, stored on the booking) so the timers can be observed; all removed.
 *
 *   node --test test/serviceTimer.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.after(async () => {
  require("../src/services/queue/serviceTimer").clearAllTimers();
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("service timers against MongoDB", async (t) => {
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
  const InventoryMovement = require("../src/models/InventoryMovement");
  const Notification = require("../src/models/Notification");
  const serviceTimer = require("../src/services/queue/serviceTimer");
  const nozzleService = require("../src/services/queue/nozzleService");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");
  const { sweepInProgressBookings } = require("../src/services/booking/bookingSweep");
  const { dateKey } = require("../src/config/businessTime");
  await Booking.init();

  const TODAY = dateKey();
  const tag = `svctimer-${Date.now()}`;
  const customers = await User.insertMany(
    Array.from({ length: 10 }, (_, i) => ({
      name: `${tag}-c${i}`,
      email: `${tag}-c${i}@example.com`,
      password: "not-a-real-hash",
      role: "customer",
      isVerified: true,
    })),
  );
  const userIds = customers.map((c) => c._id);
  const stationIds = [];
  const makeStation = async (name) => {
    const s = await Station.create({
      name: `${tag}-${name}`,
      address: "Service Timer Test",
      status: "Active",
      fuelTypes: ["Petrol"],
      prices: { petrol: 100 },
      inventory: { petrol: 1000 },
    });
    stationIds.push(s._id);
    return s;
  };
  const LABELS = ["8:00 PM", "8:30 PM", "9:00 PM", "9:30 PM", "7:00 PM", "7:30 PM", "6:00 PM", "6:30 PM", "5:00 PM", "5:30 PM"];
  let next = 0;
  const book = (station, fields = {}) => {
    const i = next++;
    const start = nozzleScheduler.parseStartDateTime(TODAY, LABELS[i]);
    const w = nozzleScheduler.computeWindow("Petrol", start);
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
      payMethod: "station",
      paymentStatus: "due_at_station",
      status: "upcoming",
      ...fields,
    });
  };
  const reload = (b) => Booking.findById(b._id).lean();
  const waitFor = async (fn, ms, label) => {
    const until = Date.now() + ms;
    for (;;) {
      if (await fn()) return;
      if (Date.now() > until) throw new Error(`timed out waiting for: ${label}`);
      await sleep(50);
    }
  };
  const sales = (station) => InventoryMovement.countDocuments({ station: station._id, type: "sale" });

  try {
    await t.test("a fill completes at its release time -- not before -- and the next car at the pump starts", async () => {
      const s = await makeStation("handover");
      const a = await book(s, { serviceDurationSeconds: 1 });
      const b = await book(s, { serviceDurationSeconds: 1 });
      assert.equal((await nozzleService.checkIn({ bookingId: a._id })).outcome, "started");
      assert.equal((await nozzleService.checkIn({ bookingId: b._id })).outcome, "queued");

      // Measured against the booking's own stored clock, not this test's sleep:
      // under a loaded parallel run the check-ins alone can take most of a second.
      const startedA = await reload(a);
      const releaseA = new Date(startedA.fuelingStartTime).getTime() + 1000;
      await sleep(Math.max(0, releaseA - Date.now() - 400));
      const midway = await reload(a);
      if (Date.now() < releaseA - 100) {
        assert.equal(midway.status, "serving", "before its release time: still fueling");
        assert.equal((await reload(b)).status, "upcoming", "the next car waits while the nozzle is locked");
      }

      await waitFor(async () => (await reload(a)).status === "completed" && (await reload(b)).status === "serving", 3000, "hand-over");
      const doneA = await reload(a);
      const heldMs = new Date(doneA.completionTime) - new Date(doneA.fuelingStartTime);
      assert.ok(heldMs >= 1000 && heldMs < 2500, `nozzle held ${heldMs} ms for a 1 s fill`);
      // Finishing the fill is not receiving the money: this pump booking was not
      // checked in with a scan, so it stays owed until "Collect payment" records it.
      assert.equal(doneA.paymentStatus, "due_at_station");

      const startedB = await reload(b);
      assert.ok(
        new Date(startedB.fuelingStartTime) >= new Date(doneA.completionTime),
        "the next car's fueling starts at or after the previous car's completion, never overlapping on record",
      );

      await waitFor(async () => (await reload(b)).status === "completed", 3000, "second fill");
      assert.equal(await sales(s), 2, "each car's fuel deducted once");
      assert.equal(await Booking.countDocuments({ station: s._id, status: "serving" }), 0, "nozzle released at the end");
      assert.equal(await Notification.countDocuments({ booking: { $in: [a._id, b._id] }, type: "booking_completed" }), 2);
    });

    await t.test("duplicate timers and racing completions complete a booking once", async () => {
      const s = await makeStation("duplicates");
      const c = await book(s, {
        status: "serving",
        arrivalTime: new Date(Date.now() - 3000),
        fuelingStartTime: new Date(Date.now() - 3000),
        serviceDurationSeconds: 1,
      });
      const lean = await reload(c);
      assert.equal(serviceTimer.scheduleCompletion(lean), true);
      assert.equal(serviceTimer.scheduleCompletion(lean), false, "a second schedule for the same fill is ignored");

      const results = await Promise.all([1, 2, 3].map(() => serviceTimer.completeAndRelease(c._id)));
      assert.equal(results.filter((r) => r.completed).length, 1, "three racers, one completion");
      await sleep(200); // let the armed timer fire too
      assert.equal((await reload(c)).status, "completed");
      assert.equal(await sales(s), 1, "stock deducted once");
      assert.equal(await Notification.countDocuments({ booking: c._id, type: "booking_completed" }), 1);
    });

    await t.test("never early: a fill still in progress is re-armed, not completed", async () => {
      const s = await makeStation("early");
      const d = await book(s, { status: "serving", arrivalTime: new Date(), fuelingStartTime: new Date(), serviceDurationSeconds: 30 });
      const r = await serviceTimer.completeAndRelease(d._id);
      assert.equal(r.notDue, true);
      assert.equal((await reload(d)).status, "serving");
      await Booking.updateOne({ _id: d._id }, { $set: { status: "cancelled" } }); // tidy: nothing else needs it
    });

    await t.test("restart: fills resume from their stored start time; an overdue one completes and hands over at once", async () => {
      const running = await makeStation("restart-running");
      const overdueStation = await makeStation("restart-overdue");
      const e = await book(running, {
        status: "serving",
        arrivalTime: new Date(Date.now() - 500),
        fuelingStartTime: new Date(Date.now() - 500),
        serviceDurationSeconds: 2,
      });
      const f = await book(overdueStation, {
        status: "serving",
        arrivalTime: new Date(Date.now() - 5000),
        fuelingStartTime: new Date(Date.now() - 5000),
        serviceDurationSeconds: 1,
      });
      const g = await book(overdueStation, { arrivalTime: new Date(Date.now() - 1000), serviceDurationSeconds: 1 });

      serviceTimer.clearAllTimers(); // what a restart does to in-memory timers
      const recovered = await serviceTimer.recoverServiceTimers({ stationIds: [running._id, overdueStation._id] });
      assert.equal(recovered.serving, 2);
      assert.equal(recovered.overdue, 1);

      await waitFor(async () => (await reload(f)).status === "completed" && (await reload(g)).status === "serving", 1500, "overdue fill completed and handed over");
      await sleep(600);
      assert.equal((await reload(e)).status, "serving", "1.5 s were left on this fill: not completed yet");
      await waitFor(async () => (await reload(e)).status === "completed", 3000, "remaining duration elapsed");
      await waitFor(async () => (await reload(g)).status === "completed", 3000, "the handed-over car finished too");
    });

    await t.test("the sweep hands a free nozzle to a car left waiting (a missed hand-over), after a grace period", async () => {
      const stuck = await makeStation("stuck");
      const fresh = await makeStation("fresh");
      const h = await book(stuck, { arrivalTime: new Date(Date.now() - 30_000), serviceDurationSeconds: 30 });
      const k = await book(fresh, { arrivalTime: new Date(Date.now() - 2000), serviceDurationSeconds: 30 });

      const result = await sweepInProgressBookings(undefined, { stationIds: [stuck._id, fresh._id] });
      assert.equal(result.started, 1);
      assert.equal((await reload(h)).status, "serving", "waited 30 s at a free nozzle: started");
      assert.equal((await reload(k)).status, "upcoming", "arrived 2 s ago: left to the normal hand-over");
      await Booking.updateMany({ _id: { $in: [h._id, k._id] } }, { $set: { status: "cancelled" } });
    });
  } finally {
    serviceTimer.clearAllTimers();
    await Booking.deleteMany({ station: { $in: stationIds } });
    await InventoryMovement.deleteMany({ station: { $in: stationIds } });
    await Notification.deleteMany({ user: { $in: userIds } });
    await Station.deleteMany({ _id: { $in: stationIds } });
    await User.deleteMany({ _id: { $in: userIds } });
    await mongoose.disconnect();
  }
});
