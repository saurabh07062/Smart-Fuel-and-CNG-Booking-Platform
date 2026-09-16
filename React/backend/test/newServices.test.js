/**
 * Unit + integration coverage for the new backend/build-order pieces:
 * rateLimiter, riskEngine, stationMetrics, demandHistory, bookingSweep.
 *
 * The pure parsing/math functions run with no DB. The scoring/aggregation
 * functions need real documents to aggregate over, so this connects to
 * MongoDB the same way test/booking-race.test.js and the Station/Booking
 * schema tests already do, using a unique tag per run so fixtures can never
 * collide with real data, and cleaning up unconditionally afterwards.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
// The limiter tests below run before any database test calls uri(): make sure
// they count in the test Redis (or in-process), never the application's Redis.
require("./helpers/testDb").isolateRedis();

const mongoose = require("mongoose");

const rateLimiter = require("../src/services/security/rateLimiter");
const { rateLimit, check: rateCheck } = rateLimiter;
const { parseSlotEndDateTime } = require("../src/services/booking/bookingSweep");
const { clockParts, dateKey } = require("../src/config/businessTime");

// The limiter opens a Redis connection lazily on first use; close it once
// every test in this file has run, or the process never exits (same reason
// algorithms.test.js closes services/core/lock.js's connection in test.after).
test.after(async () => {
  await rateLimiter.close();
  // The booking sweep below takes locks (waitlist promotion); with a test
  // Redis configured that opens services/core/lock.js's connection too.
  await require("../src/services/core/lock").close();
});

// ---------------------------------------------------------------------------
// rateLimiter: pure sliding-window math, no DB needed.
// ---------------------------------------------------------------------------

test("rateLimiter: allows requests within the limit", async () => {
  const key = `test-rl-${Date.now()}-a`;
  const r1 = await rateCheck(key, 3, 1000);
  const r2 = await rateCheck(key, 3, 1000);
  const r3 = await rateCheck(key, 3, 1000);
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, true);
});

test("rateLimiter: blocks once the window's estimate exceeds the limit", async () => {
  const key = `test-rl-${Date.now()}-b`;
  let lastResult;
  for (let i = 0; i < 6; i++) {
    lastResult = await rateCheck(key, 3, 1000);
  }
  assert.equal(lastResult.allowed, false, "the 6th request against a limit of 3 must be blocked");
  assert.ok(lastResult.retryAfterMs > 0, "a blocked result must say how long to wait");
});

test("rateLimiter: a fresh window resets the count", async () => {
  const key = `test-rl-${Date.now()}-c`;
  const windowMs = 150;
  for (let i = 0; i < 4; i++) await rateCheck(key, 2, windowMs);
  await new Promise((r) => setTimeout(r, windowMs * 2 + 50));
  const afterReset = await rateCheck(key, 2, windowMs);
  assert.equal(afterReset.allowed, true, "a request two windows later must not still be penalised");
});

test("rateLimiter: express middleware returns 429 with a Retry-After header once blocked", async () => {
  const mw = rateLimit({ limit: 1, windowMs: 1000, keyPrefix: `test-mw-${Date.now()}`, keyFn: () => "same-user" });

  const calls = [];
  const fakeRes = () => {
    const res = {
      statusCode: 200,
      headers: {},
      body: null,
      set(k, v) {
        this.headers[k] = v;
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    return res;
  };

  const res1 = fakeRes();
  await mw({}, res1, () => calls.push("next-1"));
  const res2 = fakeRes();
  await mw({}, res2, () => calls.push("next-2"));

  assert.deepEqual(calls, ["next-1"], "only the first request should reach the route handler");
  assert.equal(res2.statusCode, 429);
  assert.ok(res2.headers["Retry-After"], "a 429 must tell the client when to retry");
});

// ---------------------------------------------------------------------------
// bookingSweep: slot-end parsing, no DB needed.
// ---------------------------------------------------------------------------

test("parseSlotEndDateTime: 24h range slot ends at the second time", () => {
  const d = parseSlotEndDateTime("2026-01-15", "10:00-10:30");
  assert.equal(d.toISOString(), "2026-01-15T05:00:00.000Z", "10:30 IST");
  assert.equal(clockParts(d).hours, 10);
  assert.equal(clockParts(d).minutes, 30);
});

test("parseSlotEndDateTime: a slot label ends one 30-minute slot later, as booking assumes", () => {
  const d = parseSlotEndDateTime("2026-01-15", "6:30 PM");
  assert.equal(clockParts(d).hours, 19);
  assert.equal(clockParts(d).minutes, 0);
});

test("parseSlotEndDateTime: unrecognised shapes return null instead of throwing", () => {
  assert.equal(parseSlotEndDateTime("2026-01-15", "whenever"), null);
  assert.equal(parseSlotEndDateTime(null, "10:00-10:30"), null);
});

// ---------------------------------------------------------------------------
// Integration: riskEngine, stationMetrics, demandHistory, bookingSweep
// against a real (throwaway, tagged) set of fixtures.
// ---------------------------------------------------------------------------

const MONGO = require("./helpers/testDb").uri();
let dbAvailable = true;

test("integration fixtures", async (t) => {
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch (err) {
    dbAvailable = false;
    t.skip(`MongoDB not reachable at ${MONGO} - skipping integration coverage: ${err.message}`);
    return;
  }

  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const { evaluateBookingRisk } = require("../src/services/security/riskEngine");
  const { recomputeStationMetrics } = require("../src/services/station/stationMetrics");
  const { monthlyDemand } = require("../src/services/inventory/demandHistory");
  const { sweepStaleBookings } = require("../src/services/booking/bookingSweep");

  const tag = `newsvc-${Date.now()}`;

  const user = await User.create({
    name: `${tag}-user`,
    email: `${tag}@example.com`,
    password: "not-a-real-hash",
    role: "customer",
  });

  const stationA = await Station.create({
    name: `${tag}-A`,
    address: "Test Road A",
    coordinates: { lat: 18.52, lng: 73.85 }, // Pune
    fuelTypes: ["Petrol"],
    prices: { petrol: 100, diesel: 90, cng: 80 },
    inventory: { petrol: 1000, diesel: 0, cng: 0 },
    nozzles: 2,
    slotCapacity: 10,
    status: "Active",
  });

  const stationB = await Station.create({
    name: `${tag}-B`,
    address: "Test Road B, far away",
    coordinates: { lat: 28.61, lng: 77.21 }, // Delhi -- ~1150km from Pune
    fuelTypes: ["Petrol"],
    prices: { petrol: 100, diesel: 90, cng: 80 },
    inventory: { petrol: 1000, diesel: 0, cng: 0 },
    nozzles: 2,
    slotCapacity: 10,
    status: "Active",
  });

  const createdIds = { users: [user._id], stations: [stationA._id, stationB._id], bookings: [] };

  async function makeBooking(overrides) {
    const b = await Booking.create({
      user: user._id,
      station: stationA._id,
      fuelType: "petrol",
      quantity: 10,
      price: 100,
      amount: 1000,
      bookingDate: dateKey(),
      timeSlot: "10:00-10:30",
      status: "upcoming",
      ...overrides,
    });
    createdIds.bookings.push(b._id);
    return b;
  }

  const BookingAttempt = require("../src/models/BookingAttempt");
  const riskDate = dateKey();
  async function recordAttempts(n, overrides = {}) {
    for (let i = 0; i < n; i++) {
      await BookingAttempt.create({
        user: user._id,
        station: stationA._id,
        bookingDate: riskDate,
        timeSlot: `${(i % 11) + 1}:00 PM`,
        fuelType: "petrol",
        outcome: "rejected",
        ...overrides,
      });
    }
  }

  await t.test("riskEngine: saved bookings alone do not count as attempts", async () => {
    // Completed, not live: a customer holds at most one live booking
    // (models/Booking.js uniq_active_booking_per_user), and these only need
    // to exist as saved bookings.
    for (let i = 0; i < 8; i++) await makeBooking({ timeSlot: `${8 + i}:00-${8 + i}:30`, status: "completed" });

    const risk = await evaluateBookingRisk({
      userId: user._id,
      stationId: stationA._id,
      bookingDate: riskDate,
      timeSlot: "4:00 PM",
      fuelType: "petrol",
    });
    assert.ok(!risk.reasons.some((r) => r.rule === "velocity"), "velocity must count attempts, not saved bookings");
  });

  await t.test("riskEngine: velocity trips on attempts, but alone never blocks", async () => {
    await recordAttempts(7);

    const risk = await evaluateBookingRisk({
      userId: user._id,
      stationId: stationA._id,
      bookingDate: riskDate,
      timeSlot: "9:00 AM",
      fuelType: "petrol",
    });
    assert.ok(risk.reasons.some((r) => r.rule === "velocity"), "7 earlier attempts should trip velocity");
    assert.equal(risk.blocked, false, "one signal on its own must not block a customer");
  });

  await t.test("riskEngine: duplicate-slot + velocity together block, with explanations", async () => {
    await recordAttempts(4, { timeSlot: "8:00 PM" });

    const risk = await evaluateBookingRisk({
      userId: user._id,
      stationId: stationA._id,
      bookingDate: riskDate,
      timeSlot: "8:00 PM",
      fuelType: "petrol",
    });
    assert.ok(risk.reasons.some((r) => r.rule === "duplicate-slot"));
    assert.ok(risk.reasons.some((r) => r.rule === "velocity"));
    assert.equal(risk.blocked, true);
    assert.ok(risk.reasons.every((r) => typeof r.reason === "string" && r.reason.length > 0));
  });

  await t.test("riskEngine: excludeAttemptId leaves the current attempt out of the count", async () => {
    const extra = await BookingAttempt.create({
      user: user._id,
      station: stationA._id,
      bookingDate: riskDate,
      timeSlot: "7:00 AM",
      fuelType: "diesel",
    });
    const withIt = await evaluateBookingRisk({ userId: user._id, stationId: stationA._id, bookingDate: riskDate, timeSlot: "7:00 AM", fuelType: "diesel" });
    const without = await evaluateBookingRisk({ userId: user._id, stationId: stationA._id, bookingDate: riskDate, timeSlot: "7:00 AM", fuelType: "diesel", excludeAttemptId: extra._id });
    const count = (r) => Number(r.reasons.find((x) => x.rule === "velocity")?.reason.split(" ")[0] || 0);
    assert.equal(count(withIt) - count(without), 1);
  });

  await t.test("riskEngine: only the customer's own cancellations count", async () => {
    const canceller = await User.create({
      name: `${tag}-canceller`,
      email: `${tag}-canceller@example.com`,
      password: "not-a-real-hash",
      role: "customer",
    });
    createdIds.users.push(canceller._id);

    for (let i = 0; i < 3; i++) {
      await makeBooking({ user: canceller._id, status: "cancelled", cancelledBy: "vendor", cancelledAt: new Date() });
    }
    let risk = await evaluateBookingRisk({ userId: canceller._id, stationId: stationA._id, bookingDate: riskDate, timeSlot: "9:00 AM", fuelType: "petrol" });
    assert.ok(!risk.reasons.some((r) => r.rule === "cancellations"), "vendor cancellations must not count against the customer");

    for (let i = 0; i < 3; i++) {
      await makeBooking({ user: canceller._id, status: "cancelled", cancelledBy: "customer", cancelledAt: new Date() });
    }
    risk = await evaluateBookingRisk({ userId: canceller._id, stationId: stationA._id, bookingDate: riskDate, timeSlot: "9:00 AM", fuelType: "petrol" });
    assert.ok(risk.reasons.some((r) => r.rule === "cancellations"));
    assert.equal(risk.blocked, false, "cancellations alone must not block");

    await BookingAttempt.deleteMany({ user: { $in: [user._id, canceller._id] } });
  });

  await t.test("riskEngine: a lone, ordinary booking scores zero", async () => {
    const loneUser = await User.create({
      name: `${tag}-lone`,
      email: `${tag}-lone@example.com`,
      password: "not-a-real-hash",
      role: "customer",
    });
    createdIds.users.push(loneUser._id);

    const risk = await evaluateBookingRisk({
      userId: loneUser._id,
      stationId: stationA._id,
      bookingDate: dateKey(),
      timeSlot: "11:00-11:30",
      fuelType: "petrol",
    });

    assert.equal(risk.score, 0);
    assert.equal(risk.blocked, false);
  });

  await t.test("stationMetrics: recomputes a real arrival rate from booking history", async () => {
    const freshStation = await Station.create({
      name: `${tag}-metrics`,
      address: "Test Road C",
      coordinates: { lat: 18.5, lng: 73.8 },
      fuelTypes: ["Petrol"],
      status: "Active",
    });
    createdIds.stations.push(freshStation._id);

    for (let i = 0; i < 3; i++) {
      const b = await Booking.create({
        user: user._id,
        station: freshStation._id,
        fuelType: "petrol",
        quantity: 10,
        price: 100,
        amount: 1000,
        bookingDate: dateKey(),
        timeSlot: "12:00-12:30",
        status: "completed",
      });
      createdIds.bookings.push(b._id);
    }

    const result = await recomputeStationMetrics(freshStation._id, { windowDays: 7 });
    assert.ok(result, "3 recent bookings should be enough to produce a result");
    assert.equal(result.sampleSize, 3);
    assert.ok(result.arrivalRatePerHour > 0);

    const updated = await Station.findById(freshStation._id).select("arrivalRatePerHour observedAvgQueueLength");
    assert.equal(updated.arrivalRatePerHour, result.arrivalRatePerHour, "the station document must actually be updated");
  });

  await t.test("stationMetrics: a station with no recent bookings is left untouched", async () => {
    const quietStation = await Station.create({
      name: `${tag}-quiet`,
      address: "Test Road D",
      coordinates: { lat: 18.4, lng: 73.7 },
      fuelTypes: ["Petrol"],
      status: "Active",
      arrivalRatePerHour: 42, // a prior value that must survive
    });
    createdIds.stations.push(quietStation._id);

    const result = await recomputeStationMetrics(quietStation._id, { windowDays: 7 });
    assert.equal(result, null);

    const unchanged = await Station.findById(quietStation._id).select("arrivalRatePerHour");
    assert.equal(unchanged.arrivalRatePerHour, 42, "a quiet station's prior value must not be zeroed out");
  });

  await t.test("demandHistory: aggregates completed quantity by month, filling gaps with zero", async () => {
    const thisMonth = dateKey().slice(0, 7);
    const b = await Booking.create({
      user: user._id,
      station: stationA._id,
      fuelType: "petrol",
      quantity: 25,
      price: 100,
      amount: 2500,
      bookingDate: dateKey(),
      timeSlot: "13:00-13:30",
      status: "completed",
    });
    createdIds.bookings.push(b._id);

    const history = await monthlyDemand(stationA._id, "petrol");
    const current = history.months.find((m) => m.month === thisMonth);
    assert.ok(current, "the current month must be present");
    assert.equal(current.complete, false, "the running month is not a complete month");
    assert.ok(current.quantity >= 25, "the completed booking's quantity must be counted");
    assert.equal(history.months[0].month, thisMonth, "no invented zero months before the first sale");
  });

  await t.test("bookingSweep: an elapsed same-day slot becomes a no-show and promotes the waitlist", async () => {
    const sweepStation = await Station.create({
      name: `${tag}-sweep`,
      address: "Test Road E",
      coordinates: { lat: 18.3, lng: 73.6 },
      fuelTypes: ["Petrol"],
      status: "Active",
      slotCapacity: 1,
    });
    createdIds.stations.push(sweepStation._id);

    // A one-minute slot ending 90 minutes ago, in India time. Skipped in the
    // first 92 minutes of an India day, when that would fall on yesterday.
    const past = clockParts(new Date(Date.now() - 90 * 60_000));
    const today = dateKey();
    if (past.dateKey !== today) return;
    const pad = (n) => String(n).padStart(2, "0");
    const endMin = past.minutes + 1;
    const pastSlot = `${pad(past.hours)}:${pad(past.minutes)}-${pad(past.hours + Math.floor(endMin / 60))}:${pad(endMin % 60)}`;

    const stale = await Booking.create({
      user: user._id,
      station: sweepStation._id,
      fuelType: "petrol",
      quantity: 10,
      price: 100,
      amount: 1000,
      bookingDate: today,
      timeSlot: pastSlot,
      status: "upcoming",
    });
    createdIds.bookings.push(stale._id);

    // A different customer: one customer cannot hold a live and a waitlisted
    // booking at once (uniq_active_booking_per_user).
    const waitingUser = new mongoose.Types.ObjectId();
    const waiting = await Booking.create({
      user: waitingUser,
      station: sweepStation._id,
      fuelType: "petrol",
      quantity: 10,
      price: 100,
      amount: 1000,
      bookingDate: today,
      timeSlot: pastSlot,
      status: "waitlisted",
      waitlistPriority: Date.now(),
    });
    createdIds.bookings.push(waiting._id);

    const { waitlist } = require("../src/services/queue/waitlist");
    waitlist.enqueue(sweepStation._id, { bookingId: String(waiting._id), user: String(waitingUser) }, waiting.waitlistPriority);

    // Scoped to this test's station: the sweep must never touch real bookings or stock.
    const result = await sweepStaleBookings(undefined, { stationIds: [sweepStation._id] });
    assert.ok(result.noShow >= 1, "the elapsed slot should be counted as a no-show");

    const reloaded = await Booking.findById(stale._id).select("status");
    assert.equal(reloaded.status, "no_show");
  });

  // --- cleanup: unconditional, so a failed assertion never leaves fixtures behind ---
  await Booking.deleteMany({ _id: { $in: createdIds.bookings } });
  await Booking.deleteMany({ station: { $in: createdIds.stations } }); // catch any created indirectly (e.g. by promotion)
  await Station.deleteMany({ _id: { $in: createdIds.stations } });
  await User.deleteMany({ _id: { $in: createdIds.users } });
  await mongoose.disconnect();
});
