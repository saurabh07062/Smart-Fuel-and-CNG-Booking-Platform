/**
 * Phase 5: concurrency.
 *
 * services/core/lock.js (lock expiry guard, runExclusive), services/booking/bookingTransitions.js
 * (conditional status changes), the one-active-booking-per-customer index,
 * and races between cancel / complete / sweep / booking creation.
 *
 * DEVELOPMENT TEST DATA: tagged users and stations without a map position
 * (so no geo search sees them) and bookings dated 2099, removed at the end.
 * Services are called directly, so no email is sent.
 *
 *   node --test test/concurrency.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const lock = require("../src/services/core/lock");
const { TRANSITIONS, canTransition, sourcesFor } = require("../src/services/booking/bookingTransitions");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.after(async () => {
  await lock.close();
  await require("../src/services/security/rateLimiter").close();
});

// ---------------------------------------------------------------------------
// Pure / in-process
// ---------------------------------------------------------------------------

test("transition table: terminal statuses never move; completion only from live ones", () => {
  for (const terminal of ["completed", "cancelled", "no_show", "expired"]) {
    assert.deepEqual(TRANSITIONS[terminal], []);
  }
  assert.equal(canTransition("upcoming", "serving"), true);
  assert.equal(canTransition("serving", "upcoming"), false);
  assert.equal(canTransition("completed", "cancelled"), false);
  assert.deepEqual(sourcesFor("completed").sort(), ["serving", "upcoming"]);
  assert.deepEqual(sourcesFor("upcoming"), ["waitlisted"]);
});

test("withLock: assertHeld refuses to write once the lock's TTL has run out", async () => {
  const key = `lock:test:expiry:${Date.now()}`;
  await assert.rejects(
    lock.withLock(
      key,
      async (guard) => {
        assert.ok(guard.remainingMs() > 0);
        guard.assertHeld(0); // fresh: fine
        await sleep(120);
        guard.assertHeld(0); // TTL 100 ms has passed
      },
      { ttlMs: 100 },
    ),
    (err) => err.code === "LOCK_EXPIRED",
  );
  // The margin: with 500 ms of a 600 ms lock needed, it refuses at once.
  await assert.rejects(lock.withLock(`${key}:margin`, async (g) => g.assertHeld(), { ttlMs: 400 }), { code: "LOCK_EXPIRED" });
});

test("runExclusive: a job runs once per interval however many instances fire", async () => {
  const name = `test-job-${Date.now()}`;
  let runs = 0;
  const job = async () => {
    runs += 1;
    await sleep(20);
    return runs;
  };
  const results = await Promise.all(Array.from({ length: 5 }, () => lock.runExclusive(name, 200, job)));
  assert.equal(results.filter((r) => r.ran).length, 1);
  assert.equal(runs, 1);

  // Held for the rest of the interval even though the run finished.
  assert.equal((await lock.runExclusive(name, 200, job)).ran, false);
  await sleep(220);
  assert.equal((await lock.runExclusive(name, 200, job)).ran, true);
  assert.equal(runs, 2);
});

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

test("booking concurrency against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const User = require("../src/models/User");
  const BookingAttempt = require("../src/models/BookingAttempt");
  const { completeBooking } = require("../src/services/booking/bookingCompletion");
  const { transitionBooking } = require("../src/services/booking/bookingTransitions");
  const { createCustomerBooking, expireUserPastBookings } = require("../src/services/booking/bookingCreate");
  const bookingController = require("../src/controllers/bookingController");
  const vendorPanel = require("../src/controllers/vendorPanelController");
  await Booking.init();

  const tag = `conc-${Date.now()}`;
  const vendor = await User.create({
    name: `${tag}-vendor`,
    email: `${tag}-vendor@example.com`,
    password: "not-a-real-hash",
    role: "vendor",
    vendorStatus: "active",
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
  const makeStation = (name) =>
    Station.create({
      name: `${tag}-${name}`,
      address: "Concurrency Test",
      owner: vendor._id,
      status: "Active",
      fuelTypes: ["Petrol"],
      prices: { petrol: 100 },
      inventory: { petrol: 100 },
    });
  const [stationA, stationB] = await Promise.all([makeStation("A"), makeStation("B")]);
  const stationIds = [stationA._id, stationB._id];
  const userIds = [vendor._id, ...customers.map((c) => c._id)];

  let slotIdx = 0;
  const LABELS = ["8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "11:00 AM"];
  const makeBooking = (user, fields = {}) =>
    Booking.create({
      user: user._id,
      station: stationA._id,
      fuelType: "Petrol",
      quantity: 10,
      price: 100,
      amount: 1005,
      bookingDate: "2099-08-01",
      timeSlot: LABELS[slotIdx++ % LABELS.length],
      status: "upcoming",
      ...fields,
    });
  const stock = async () => (await Station.findById(stationA._id).lean()).inventory.petrol;
  const fakeRes = () => ({
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
  });

  try {
    await t.test("cancel racing complete: exactly one wins, and stock matches the winner", async () => {
      for (let round = 0; round < 5; round++) {
        const b = await makeBooking(customers[0]);
        const before = await stock();
        const outcomes = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            i % 2
              ? completeBooking({ bookingId: b._id }).then((d) => (d ? "completed" : null))
              : transitionBooking({ bookingId: b._id, to: "cancelled" }).then((d) => (d ? "cancelled" : null)),
          ),
        );
        const winners = outcomes.filter(Boolean);
        assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(outcomes)}`);

        const saved = await Booking.findById(b._id).lean();
        assert.equal(saved.status, winners[0]);
        assert.equal(await stock(), winners[0] === "completed" ? before - 10 : before);
        assert.equal(Boolean(saved.inventoryDeductedAt), winners[0] === "completed");
      }
    });

    await t.test("the database allows one live booking per customer, whatever the code path", async () => {
      const first = await makeBooking(customers[1]);
      await assert.rejects(
        makeBooking(customers[1], { station: stationB._id }),
        (err) => err.code === 11000 && Boolean(err.keyPattern?.user),
      );
      await transitionBooking({ bookingId: first._id, to: "cancelled" });
      const again = await makeBooking(customers[1], { station: stationB._id });
      assert.ok(again._id, "a finished booking does not count");
      await transitionBooking({ bookingId: again._id, to: "cancelled" });
    });

    await t.test("one customer booking two stations at once: exactly one is created", async () => {
      const body = (stationId, timeSlot) => ({
        stationId: String(stationId),
        fuelType: "Petrol",
        quantity: 5,
        bookingDate: "2099-08-02",
        timeSlot,
        payMethod: "station",
      });
      const user = { id: String(customers[2]._id) };
      const results = await Promise.allSettled([
        createCustomerBooking({ user, body: body(stationA._id, "9:00 AM") }),
        createCustomerBooking({ user, body: body(stationB._id, "9:00 AM") }),
        createCustomerBooking({ user, body: body(stationB._id, "9:30 AM") }),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.reason?.reason || "ok")));
      assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.reason === "ACTIVE_BOOKING_EXISTS"));
      assert.equal(await Booking.countDocuments({ user: customers[2]._id, status: "upcoming" }), 1);
    });

    await t.test("expiry never touches a booking that is being served", async () => {
      const serving = await makeBooking(customers[3], { bookingDate: "2020-01-01", status: "serving" });
      await expireUserPastBookings(customers[3]._id);
      assert.equal((await Booking.findById(serving._id).lean()).status, "serving");
      await completeBooking({ bookingId: serving._id });

      const stale = await makeBooking(customers[3], { bookingDate: "2020-01-01" });
      await expireUserPastBookings(customers[3]._id);
      assert.equal((await Booking.findById(stale._id).lean()).status, "expired");
    });

    await t.test("customer cancel after the booking was completed: refused, not overwritten", async () => {
      const b = await makeBooking(customers[4]);
      await completeBooking({ bookingId: b._id });
      const res = fakeRes();
      await bookingController.cancelBooking({ params: { id: String(b._id) }, user: { id: String(customers[4]._id) }, app: { get: () => null } }, res);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.msg, /completed/);
      assert.equal((await Booking.findById(b._id).lean()).status, "completed");
    });

    await t.test("vendor status change: conflict is a 409, a repeat click is a no-op", async () => {
      const b = await makeBooking(customers[5]);
      const req = (status) => ({
        params: { stationId: String(stationA._id), bookingId: String(b._id) },
        body: { status },
        user: { id: String(vendor._id), role: "vendor" },
        app: { get: () => null },
      });

      let res = fakeRes();
      await vendorPanel.updateBookingStatus(req("serving"), res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      const started = (await Booking.findById(b._id).lean()).fuelingStartTime;
      assert.ok(started);

      res = fakeRes();
      await vendorPanel.updateBookingStatus(req("serving"), res);
      assert.equal(res.statusCode, 200);
      assert.equal(String((await Booking.findById(b._id).lean()).fuelingStartTime), String(started), "start time kept");

      // The sweep completes it between the vendor's read and write.
      await completeBooking({ bookingId: b._id });
      res = fakeRes();
      await vendorPanel.updateBookingStatus(req("no_show"), res);
      assert.equal(res.statusCode, 400, "already terminal when read");
      assert.equal((await Booking.findById(b._id).lean()).status, "completed");
    });
  } finally {
    await Booking.deleteMany({ $or: [{ station: { $in: stationIds } }, { user: { $in: userIds } }] });
    await BookingAttempt.deleteMany({ user: { $in: userIds } });
    await require("../src/models/InventoryMovement").deleteMany({ station: { $in: stationIds } });
    await Station.deleteMany({ _id: { $in: stationIds } });
    await User.deleteMany({ _id: { $in: userIds } });
    await mongoose.disconnect();
  }
});
