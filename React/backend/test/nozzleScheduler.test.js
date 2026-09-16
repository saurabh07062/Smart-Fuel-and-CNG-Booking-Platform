/**
 * Single-nozzle interval scheduling: config/fuelDurations.js and
 * services/queue/nozzleScheduler.js (pure + light-DB), plus an HTTP-level
 * concurrency race against the live POST /api/bookings endpoint
 * (controllers/bookingController.js) now that it enforces one nozzle per
 * station via services/core/lock.js.
 *
 * Follows the same patterns as test/booking-race.test.js (HTTP race,
 * auto-skips when the API isn't reachable) and test/newServices.test.js
 * (tagged DB fixtures, unconditional cleanup).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { FUEL_SERVICE_DURATIONS_SECONDS, getServiceDurationSeconds } = require("../src/config/fuelDurations");
const nozzleScheduler = require("../src/services/queue/nozzleScheduler");

// ---------------------------------------------------------------------------
// config/fuelDurations.js — pure, no DB.
// ---------------------------------------------------------------------------

test("fuelDurations: exact durations per the spec", () => {
  assert.equal(getServiceDurationSeconds("petrol"), 40);
  assert.equal(getServiceDurationSeconds("diesel"), 40);
  assert.equal(getServiceDurationSeconds("cng"), 300);
});

test("fuelDurations: case/spacing-insensitive, matches discovery.normaliseFuel", () => {
  assert.equal(getServiceDurationSeconds("Petrol"), FUEL_SERVICE_DURATIONS_SECONDS.petrol);
  assert.equal(getServiceDurationSeconds(" CNG "), FUEL_SERVICE_DURATIONS_SECONDS.cng);
});

test("fuelDurations: unrecognised fuel falls back rather than throwing", () => {
  assert.equal(getServiceDurationSeconds("hydrogen"), FUEL_SERVICE_DURATIONS_SECONDS.petrol);
  assert.equal(getServiceDurationSeconds(undefined), FUEL_SERVICE_DURATIONS_SECONDS.petrol);
});

// ---------------------------------------------------------------------------
// nozzleScheduler: parsing + window math, pure, no DB.
// ---------------------------------------------------------------------------

const { clockParts } = require("../src/config/businessTime");

test("parseStartDateTime: a slot label is India time, whatever the server timezone", () => {
  const d = nozzleScheduler.parseStartDateTime("2026-06-01", "10:00 AM");
  // 10:00 IST is 04:30 UTC -- an absolute check, independent of process TZ.
  assert.equal(d.toISOString(), "2026-06-01T04:30:00.000Z");
  assert.deepEqual(clockParts(d), { dateKey: "2026-06-01", hours: 10, minutes: 0, dayOfWeek: 1 });
});

test("parseStartDateTime: handles PM and 12 AM/PM edge cases", () => {
  assert.equal(clockParts(nozzleScheduler.parseStartDateTime("2026-06-01", "6:30 PM")).hours, 18);
  const midnight = nozzleScheduler.parseStartDateTime("2026-06-01", "12:00 AM");
  assert.equal(clockParts(midnight).hours, 0);
  assert.equal(clockParts(midnight).dateKey, "2026-06-01", "12 AM IST stays on its India date");
  assert.equal(clockParts(nozzleScheduler.parseStartDateTime("2026-06-01", "12:00 PM")).hours, 12);
});

test("parseStartDateTime: malformed input returns null instead of throwing", () => {
  assert.equal(nozzleScheduler.parseStartDateTime(null, "10:00 AM"), null);
  assert.equal(nozzleScheduler.parseStartDateTime("2026-06-01", "whenever"), null);
  assert.equal(nozzleScheduler.parseStartDateTime("not-a-date", "10:00 AM"), null);
});

test("computeWindow: CNG occupies exactly 5 minutes, matching the spec's worked example", () => {
  const start = nozzleScheduler.parseStartDateTime("2026-06-01", "10:00 AM");
  const w = nozzleScheduler.computeWindow("cng", start);
  assert.equal(w.durationSeconds, 300);
  assert.equal(clockParts(w.end).hours, 10);
  assert.equal(clockParts(w.end).minutes, 5);
});

test("computeWindow: Petrol/Diesel occupy exactly 40 seconds", () => {
  const start = nozzleScheduler.parseStartDateTime("2026-06-01", "10:00 AM");
  const petrol = nozzleScheduler.computeWindow("petrol", start);
  const diesel = nozzleScheduler.computeWindow("diesel", start);
  assert.equal(petrol.end.getTime() - start.getTime(), 40_000);
  assert.equal(diesel.end.getTime() - start.getTime(), 40_000);
});

// ---------------------------------------------------------------------------
// Integration: hasOverlap against real fixtures, and an HTTP-level
// concurrency race through the live booking endpoint.
// ---------------------------------------------------------------------------

const API = require("./helpers/testDb").apiUrl();
const MONGO = require("./helpers/testDb").uri();

async function ping() {
  try {
    const r = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

test("nozzleScheduler + bookingController: single-nozzle overlap enforcement", async (t) => {
  let dbAvailable = true;
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch (err) {
    dbAvailable = false;
    t.skip(`MongoDB not reachable at ${MONGO} - skipping: ${err.message}`);
    return;
  }

  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const User = require("../src/models/User");

  const tag = `nozzletest-${Date.now()}`;
  const date = "2099-02-01"; // far future, cannot collide with real data

  const station = await Station.create({
    name: `${tag}-station`,
    address: "Nozzle Test Road, Pune",
    coordinates: { lat: 18.52, lng: 73.85 },
    fuelTypes: ["Petrol", "Diesel", "CNG"],
    prices: { petrol: 100, diesel: 90, cng: 80 },
    inventory: { petrol: 1_000_000, diesel: 1_000_000, cng: 1_000_000 },
    status: "Active",
  });

  const otherStation = await Station.create({
    name: `${tag}-other-station`,
    address: "Elsewhere Road, Pune",
    coordinates: { lat: 18.6, lng: 73.9 },
    fuelTypes: ["Petrol"],
    status: "Active",
  });

  const createdIds = { stations: [station._id, otherStation._id], bookings: [], users: [] };

  await t.test("hasOverlap: the spec's own worked example (CNG 10:00-10:05)", async () => {
    const cngStart = nozzleScheduler.parseStartDateTime(date, "10:00 AM");
    const cngWindow = nozzleScheduler.computeWindow("cng", cngStart);

    const cngBooking = await Booking.create({
      user: new mongoose.Types.ObjectId(),
      station: station._id,
      fuelType: "cng",
      quantity: 5,
      price: 80,
      amount: 400,
      bookingDate: date,
      timeSlot: "10:00 AM",
      bookingStartTime: cngWindow.start,
      bookingEndTime: cngWindow.end,
      serviceDurationSeconds: cngWindow.durationSeconds,
      status: "upcoming",
    });
    createdIds.bookings.push(cngBooking._id);

    // Rejected: a CNG request starting at any of these overlaps the 10:00-10:05 CNG reservation.
    const rejectedStarts = ["10:00 AM", "10:01 AM", "10:03 AM", "10:04 AM"];
    for (const label of rejectedStarts) {
      const s = nozzleScheduler.parseStartDateTime(date, label);
      const w = nozzleScheduler.computeWindow("cng", s);
      const conflict = await nozzleScheduler.hasOverlap(station._id, w.start, w.end, undefined, { fuelType: "cng" });
      assert.equal(conflict, true, `a CNG booking starting at ${label} must be rejected (overlaps the CNG reservation)`);
      // Petrol has its own nozzle: the CNG reservation never blocks it.
      const p = nozzleScheduler.computeWindow("petrol", s);
      const petrolConflict = await nozzleScheduler.hasOverlap(station._id, p.start, p.end, undefined, { fuelType: "petrol" });
      assert.equal(petrolConflict, false, `a Petrol booking starting at ${label} uses the Petrol nozzle`);
    }

    // Accepted: exactly at the CNG booking's end time, the CNG nozzle is free again.
    const freeStart = nozzleScheduler.parseStartDateTime(date, "10:05 AM");
    const freeWindow = nozzleScheduler.computeWindow("cng", freeStart);
    const noConflict = await nozzleScheduler.hasOverlap(station._id, freeWindow.start, freeWindow.end, undefined, { fuelType: "cng" });
    assert.equal(noConflict, false, "a booking starting exactly when the previous one ends must be allowed");
  });

  await t.test("hasOverlap: a different station's nozzle is never affected", async () => {
    const start = nozzleScheduler.parseStartDateTime(date, "10:00 AM");
    const window = nozzleScheduler.computeWindow("petrol", start);
    const conflict = await nozzleScheduler.hasOverlap(otherStation._id, window.start, window.end);
    assert.equal(conflict, false, "the CNG booking at the first station must not block the second station's nozzle");
  });

  await t.test("cancelling a booking immediately frees its window", async () => {
    const start = nozzleScheduler.parseStartDateTime(date, "2:00 PM");
    const window = nozzleScheduler.computeWindow("diesel", start);
    const b = await Booking.create({
      user: new mongoose.Types.ObjectId(),
      station: station._id,
      fuelType: "diesel",
      quantity: 5,
      price: 90,
      amount: 450,
      bookingDate: date,
      timeSlot: "2:00 PM",
      bookingStartTime: window.start,
      bookingEndTime: window.end,
      serviceDurationSeconds: window.durationSeconds,
      status: "upcoming",
    });
    createdIds.bookings.push(b._id);

    assert.equal(await nozzleScheduler.hasOverlap(station._id, window.start, window.end), true);

    b.status = "cancelled";
    await b.save();

    assert.equal(
      await nozzleScheduler.hasOverlap(station._id, window.start, window.end),
      false,
      "a cancelled booking must no longer occupy the nozzle",
    );
  });

  // --- HTTP-level concurrency race against the live endpoint -------------
  const available = await ping();
  if (!available) {
    await t.test("HTTP race (skipped)", (t2) => t2.skip(`API not reachable at ${API} — start the stack to run this part`));
  } else {
    await t.test("bookingController.createBooking: only one of many concurrent requests wins the nozzle", async () => {
      const CONCURRENCY = 15;
      const raceDate = "2099-03-01";
      const raceSlot = "11:00 AM";

      const password = "nozzletest1234";
      const hashed = await bcrypt.hash(password, 8);
      const users = await User.insertMany(
        Array.from({ length: CONCURRENCY }, (_, i) => ({
          name: `${tag}-race-u${i}`,
          email: `${tag}-race-u${i}@example.com`,
          password: hashed,
          role: "customer",
          isVerified: true,
        })),
      );
      createdIds.users.push(...users.map((u) => u._id));

      // Mint JWTs directly (same payload shape/secret authController.login
      // uses -- middleware/auth.js just verifies against JWT_SECRET) instead
      // of round-tripping through the rate-limited /api/auth/login endpoint
      // (10 requests / 5min / IP, authRoutes.js) -- that limiter is a real
      // security control worth keeping, not something a test should need to
      // fight to prove the nozzle lock works.
      const tokens = users.map((u) => jwt.sign({ user: { id: u.id } }, process.env.JWT_SECRET, { expiresIn: "5h" }));

      assert.equal(tokens.length, CONCURRENCY);

      const results = await Promise.all(
        tokens.map(async (token) => {
          try {
            const res = await fetch(`${API}/api/bookings`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-auth-token": token },
              body: JSON.stringify({
                stationId: String(station._id),
                fuelType: "Petrol",
                quantity: 5,
                price: 100,
                taxes: 5,
                amount: 505,
                bookingDate: raceDate,
                timeSlot: raceSlot,
                vehiclePlate: "TEST-1234",
                payMethod: "station",
              }),
            });
            const body = await res.json().catch(() => ({}));
            return { http: res.status, reason: body.reason, booking: body.booking };
          } catch (err) {
            return { http: 0, reason: "network-error", message: err.message };
          }
        }),
      );

      const persistedConfirmed = await Booking.countDocuments({
        station: station._id,
        bookingDate: raceDate,
        timeSlot: raceSlot,
        status: "upcoming",
      });
      createdIds.stations.push(station._id); // already tracked, harmless dupe-safe cleanup below

      const succeeded = results.filter((r) => r.http === 200);
      const conflicted = results.filter((r) => r.reason === "SLOT_FULL" || r.reason === "NOZZLE_BUSY");
      const networkErrors = results.filter((r) => r.reason === "network-error");

      console.log(
        `\n  ${tokens.length} concurrent bookings on one station's single nozzle:\n` +
          `    succeeded : ${succeeded.length} (db upcoming: ${persistedConfirmed})\n` +
          `    conflicted: ${conflicted.length}\n` +
          `    net errors: ${networkErrors.length}\n`,
      );

      // Clean up this sub-test's bookings before asserting.
      await Booking.deleteMany({ station: station._id, bookingDate: raceDate, timeSlot: raceSlot });

      assert.equal(networkErrors.length, 0, "no request should fail at the network level");
      assert.equal(persistedConfirmed, 1, `exactly one booking must persist as confirmed for the single nozzle, found ${persistedConfirmed}`);
      assert.equal(succeeded.length, 1, "exactly one client should receive a 200");
      assert.equal(succeeded.length + conflicted.length, tokens.length, "every request must get a definite answer");
    });
  }

  // --- cleanup: unconditional, so a failed assertion never leaves fixtures behind ---
  await Booking.deleteMany({ _id: { $in: createdIds.bookings } });
  await Booking.deleteMany({ station: { $in: createdIds.stations } });
  await require("../src/models/BookingAttempt").deleteMany({ user: { $in: createdIds.users } });
  await Station.deleteMany({ _id: { $in: createdIds.stations } });
  await User.deleteMany({ _id: { $in: createdIds.users } });
  await mongoose.disconnect();
});
