/**
 * Exhaustive scenario coverage for the single-nozzle booking algorithm
 * (services/queue/nozzleScheduler.js + controllers/bookingController.js), beyond
 * the spec's own worked example already covered in nozzleScheduler.test.js.
 *
 * Every scenario here maps to a real way the algorithm could be wrong:
 * boundary math (does "touching but not overlapping" count as a conflict?),
 * status handling (does every non-occupying status actually release the
 * nozzle, not just "cancelled"?), isolation (does a different station or a
 * different date leak into the check?), and the controller's input
 * validation and HTTP-level behaviour (not just the pure function).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const nozzleScheduler = require("../src/services/queue/nozzleScheduler");

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

test("single-nozzle algorithm: exhaustive scenarios", async (t) => {
  let dbOk = true;
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch (err) {
    dbOk = false;
    t.skip(`MongoDB not reachable at ${MONGO} - skipping: ${err.message}`);
    return;
  }

  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const User = require("../src/models/User");

  const tag = `nozscen-${Date.now()}`;
  const date = "2099-04-01";

  const stationA = await Station.create({
    name: `${tag}-A`,
    address: "Scenario Road A",
    coordinates: { lat: 18.52, lng: 73.85 },
    fuelTypes: ["Petrol", "Diesel", "CNG"],
    prices: { petrol: 100, diesel: 90, cng: 80 },
    inventory: { petrol: 1_000_000, diesel: 1_000_000, cng: 1_000_000 },
    status: "Active",
  });
  const stationB = await Station.create({
    name: `${tag}-B`,
    address: "Scenario Road B",
    coordinates: { lat: 18.6, lng: 73.9 },
    fuelTypes: ["Petrol", "Diesel", "CNG"],
    prices: { petrol: 100, diesel: 90, cng: 80 },
    inventory: { petrol: 1_000_000, diesel: 1_000_000, cng: 1_000_000 },
    status: "Active",
  });

  const createdIds = { stations: [stationA._id, stationB._id], bookings: [], users: [] };

  /** Helper: create a booking fixture directly, with a real computed window. */
  async function makeBooking({ station = stationA._id, fuel, label, status = "upcoming", onDate = date }) {
    const start = nozzleScheduler.parseStartDateTime(onDate, label);
    const window = nozzleScheduler.computeWindow(fuel, start);
    const b = await Booking.create({
      user: new mongoose.Types.ObjectId(),
      station,
      fuelType: fuel,
      quantity: 5,
      price: 100,
      amount: 500,
      bookingDate: onDate,
      timeSlot: label,
      bookingStartTime: window.start,
      bookingEndTime: window.end,
      serviceDurationSeconds: window.durationSeconds,
      status,
    });
    createdIds.bookings.push(b._id);
    return { booking: b, window };
  }

  // -------------------------------------------------------------------
  // Boundary math: does "touching" count as overlap? (it must not.)
  // -------------------------------------------------------------------

  await t.test("boundary: back-to-back bookings (touching, not overlapping) are both allowed", async () => {
    const { window: cngWindow } = await makeBooking({ fuel: "cng", label: "9:00 AM" }); // 9:00-9:05

    // A Petrol request starting exactly when CNG ends must be free.
    const noConflict = await nozzleScheduler.hasOverlap(stationA._id, cngWindow.end, new Date(cngWindow.end.getTime() + 40_000));
    assert.equal(noConflict, false, "a booking starting exactly at the previous one's end time must not conflict");

    // A request ending exactly when CNG starts must also be free.
    const before = new Date(cngWindow.start.getTime() - 40_000);
    const noConflictBefore = await nozzleScheduler.hasOverlap(stationA._id, before, cngWindow.start);
    assert.equal(noConflictBefore, false, "a booking ending exactly when the next one starts must not conflict");
  });

  await t.test("boundary: a 1-second overlap on either edge is rejected", async () => {
    const { window: cngWindow } = await makeBooking({ fuel: "cng", label: "9:30 AM" }); // 9:30-9:35

    // Ends 1 second after CNG starts (tail overlap).
    const tailOverlap = await nozzleScheduler.hasOverlap(
      stationA._id,
      new Date(cngWindow.start.getTime() - 39_000),
      new Date(cngWindow.start.getTime() + 1_000),
    );
    assert.equal(tailOverlap, true, "ending 1 second into the CNG window must conflict");

    // Starts 1 second before CNG ends (head overlap).
    const headOverlap = await nozzleScheduler.hasOverlap(
      stationA._id,
      new Date(cngWindow.end.getTime() - 1_000),
      new Date(cngWindow.end.getTime() + 39_000),
    );
    assert.equal(headOverlap, true, "starting 1 second before the CNG window ends must conflict");
  });

  await t.test("boundary: a new booking fully containing an existing one is rejected", async () => {
    const { window } = await makeBooking({ fuel: "petrol", label: "10:00 AM" }); // 10:00:00-10:00:40
    const containing = await nozzleScheduler.hasOverlap(
      stationA._id,
      new Date(window.start.getTime() - 60_000),
      new Date(window.end.getTime() + 60_000),
    );
    assert.equal(containing, true, "a window that swallows an existing booking whole must still conflict");
  });

  await t.test("boundary: a new booking fully contained within an existing one is rejected", async () => {
    const { window } = await makeBooking({ fuel: "cng", label: "10:30 AM" }); // 10:30-10:35
    const contained = await nozzleScheduler.hasOverlap(
      stationA._id,
      new Date(window.start.getTime() + 30_000),
      new Date(window.start.getTime() + 60_000),
    );
    assert.equal(contained, true, "a window entirely inside an existing booking must conflict");
  });

  await t.test("boundary: identical start, identical end -- both reject", async () => {
    const { window } = await makeBooking({ fuel: "diesel", label: "11:00 AM" });
    const exact = await nozzleScheduler.hasOverlap(stationA._id, window.start, window.end);
    assert.equal(exact, true, "requesting the exact same window as an existing booking must conflict");
  });

  // -------------------------------------------------------------------
  // Cross-fuel-type overlap: each fuel has its own nozzle
  // -------------------------------------------------------------------

  await t.test("cross-fuel: each fuel has its own nozzle -- only the same fuel conflicts, none when adjacent", async () => {
    const fuels = ["cng", "petrol", "diesel"];
    let slotHour = 1; // distinct hour per pairing so fixtures never collide with each other
    for (const blockerFuel of fuels) {
      for (const requesterFuel of fuels) {
        const label = `${slotHour}:00 PM`;
        const { window } = await makeBooking({ fuel: blockerFuel, label });

        // Requesting fuel starting 1 second into the blocker's window: conflicts only on the same nozzle.
        const reqStart = new Date(window.start.getTime() + 1_000);
        const reqWindow = nozzleScheduler.computeWindow(requesterFuel, reqStart);
        const conflict = await nozzleScheduler.hasOverlap(stationA._id, reqWindow.start, reqWindow.end, undefined, {
          fuelType: requesterFuel,
        });
        assert.equal(
          conflict,
          requesterFuel === blockerFuel,
          `${requesterFuel} ${requesterFuel === blockerFuel ? "must" : "must not"} be blocked by an overlapping ${blockerFuel} booking`,
        );

        // Requesting fuel starting exactly when the blocker ends: must be free.
        const adjWindow = nozzleScheduler.computeWindow(requesterFuel, window.end);
        const noConflict = await nozzleScheduler.hasOverlap(stationA._id, adjWindow.start, adjWindow.end, undefined, {
          fuelType: requesterFuel,
        });
        assert.equal(noConflict, false, `${requesterFuel} starting right after ${blockerFuel} ends must be allowed`);

        slotHour++;
      }
    }
  });

  // -------------------------------------------------------------------
  // Isolation: different station, different date
  // -------------------------------------------------------------------

  await t.test("isolation: an identical window at a different station never conflicts", async () => {
    const { window } = await makeBooking({ station: stationA._id, fuel: "cng", label: "8:30 AM" });
    const conflict = await nozzleScheduler.hasOverlap(stationB._id, window.start, window.end);
    assert.equal(conflict, false, "station B's nozzle must be completely unaffected by station A's booking");
  });

  await t.test("isolation: the same time-of-day on a different date never conflicts", async () => {
    const otherDate = "2099-04-02";
    // 8:00 AM rather than 9:00 AM: an earlier sub-test already holds an active
    // 9:00 AM booking at this station, and uniq_active_nozzle_start (correctly)
    // refuses a second active booking with the same start.
    await makeBooking({ fuel: "cng", label: "8:00 AM" }); // on `date`
    const otherDayStart = nozzleScheduler.parseStartDateTime(otherDate, "8:00 AM");
    const otherDayWindow = nozzleScheduler.computeWindow("cng", otherDayStart);
    const conflict = await nozzleScheduler.hasOverlap(stationA._id, otherDayWindow.start, otherDayWindow.end);
    assert.equal(conflict, false, "the same clock time on a different calendar day must not conflict");
  });

  // -------------------------------------------------------------------
  // Status handling: every non-occupying status must release the nozzle,
  // and "serving" (in-progress) must still occupy it.
  // -------------------------------------------------------------------

  await t.test("status: serving still occupies the nozzle; every terminal status releases it", async () => {
    // Dedicated date: this test creates and deletes fixtures at the same
    // label in a loop, and must not share a date with any other test's
    // persistent fixtures (which never get cleaned up until the whole file
    // finishes) or a leftover booking would falsely register as a conflict.
    const statusDate = "2099-04-10";
    const nonOccupying = ["completed", "cancelled", "no_show", "expired", "waitlisted"];
    for (const status of nonOccupying) {
      const { booking, window } = await makeBooking({ fuel: "petrol", label: "9:30 AM", status, onDate: statusDate });
      const conflict = await nozzleScheduler.hasOverlap(stationA._id, window.start, window.end);
      assert.equal(conflict, false, `status '${status}' must not occupy the nozzle`);
      // Clean up immediately so the next status in the loop can reuse the same label.
      await Booking.deleteOne({ _id: booking._id });
    }

    const { window: servingWindow } = await makeBooking({ fuel: "cng", label: "10:00 AM", status: "serving", onDate: statusDate });
    const servingConflict = await nozzleScheduler.hasOverlap(stationA._id, servingWindow.start, servingWindow.end);
    assert.equal(servingConflict, true, "a vehicle actually being served must still occupy the nozzle");
  });

  await t.test("hasOverlap: excludeBookingId lets a booking be compared against everything except itself", async () => {
    const { booking, window } = await makeBooking({ fuel: "diesel", label: "10:30 AM", onDate: "2099-04-11" });
    const selfConflict = await nozzleScheduler.hasOverlap(stationA._id, window.start, window.end);
    assert.equal(selfConflict, true, "without excluding itself, a booking always 'conflicts' with its own row");
    const excluded = await nozzleScheduler.hasOverlap(stationA._id, window.start, window.end, booking._id);
    assert.equal(excluded, false, "excluding a booking's own id must let it check cleanly against everything else");
  });

  // -------------------------------------------------------------------
  // findNextAvailableStart: skips over multiple stacked bookings correctly
  // -------------------------------------------------------------------

  await t.test("findNextAvailableStart: skips every consecutive stacked booking, not just the first", async () => {
    // Dedicated date, kept free of every other test's fixtures, so this is a
    // clean "book 3 in a row, expect the 4th label back" check.
    const stackedDate = "2099-04-12";
    // A window holds floor(1800 / 300) = 6 CNG fills on the one CNG nozzle:
    // fill three windows in a row completely.
    for (const label of ["11:00 AM", "11:30 AM", "12:00 PM"]) {
      const base = nozzleScheduler.parseStartDateTime(stackedDate, label).getTime();
      await Booking.insertMany(
        Array.from({ length: 6 }, (_, k) => ({
          user: new mongoose.Types.ObjectId(),
          station: stationA._id,
          fuelType: "CNG",
          quantity: 5,
          price: 80,
          amount: 400,
          bookingDate: stackedDate,
          timeSlot: label,
          status: "upcoming",
          resource: 1,
          bookingStartTime: new Date(base + k * 300_000),
          bookingEndTime: new Date(base + (k + 1) * 300_000),
          serviceDurationSeconds: 300,
        })),
      );
    }

    const next = await nozzleScheduler.findNextAvailableStart(stationA._id, "cng", stackedDate, "11:00 AM");
    assert.equal(next, "12:30 PM", "must walk past all three full windows to the first one with room");
    const partly = await nozzleScheduler.findNextAvailableStart(stationA._id, "petrol", stackedDate, "11:00 AM");
    assert.equal(partly, "11:00 AM", "full CNG windows leave the Petrol nozzle free");
  });

  // -------------------------------------------------------------------
  // HTTP-level: controller input validation and full request/response behaviour
  // -------------------------------------------------------------------

  const httpOk = await ping();
  if (!httpOk) {
    await t.test("HTTP-level scenarios (skipped)", (t2) => t2.skip(`API not reachable at ${API}`));
  } else {
    // A separate, pre-existing rule (bookingController.js's ACTIVE_BOOKING_EXISTS
    // check) limits each USER to one active booking platform-wide, independent
    // of the nozzle. That rule would silently contaminate these results if the
    // same user were reused across sub-tests that each expect a booking to
    // succeed, so every attempt below -- successful or not -- gets its own
    // never-reused user from this pool instead of trying to reason about which
    // earlier attempts consumed which user's "one active booking" slot.
    const password = "scenariotest1234";
    const hashed = await bcrypt.hash(password, 8);
    const pool = await User.insertMany(
      Array.from({ length: 16 }, (_, i) => ({
        name: `${tag}-u${i}`,
        email: `${tag}-u${i}@example.com`,
        password: hashed,
        role: "customer",
        isVerified: true,
      })),
    );
    createdIds.users.push(...pool.map((u) => u._id));
    let poolIndex = 0;
    const nextUser = () => pool[poolIndex++];
    const tokenFor = (u) => jwt.sign({ user: { id: u.id } }, process.env.JWT_SECRET, { expiresIn: "5h" });

    async function post(token, body) {
      const res = await fetch(`${API}/api/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-auth-token": token },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }

    const baseBody = (overrides) => ({
      stationId: String(stationA._id),
      quantity: 5,
      price: 100,
      taxes: 5,
      amount: 505,
      bookingDate: "2099-05-01",
      vehiclePlate: "TEST-0001",
      payMethod: "station",
      ...overrides,
    });

    await t.test("HTTP: an unrecognised fuel type is rejected with 400, not silently defaulted to Petrol", async () => {
      const { status, body } = await post(tokenFor(nextUser()), baseBody({ fuelType: "Hydrogen", timeSlot: "8:00 AM" }));
      assert.equal(status, 400);
      assert.equal(body.reason, "INVALID_FUEL_TYPE");
    });

    await t.test("HTTP: fuel type is case- and whitespace-insensitive", async () => {
      const { status, body } = await post(tokenFor(nextUser()), baseBody({ fuelType: " cNg ", timeSlot: "8:30 AM" }));
      assert.equal(status, 200, JSON.stringify(body));
      const { getServiceDurationSeconds } = require("../src/config/fuelDurations");
      assert.equal(
        body.booking.serviceDurationSeconds,
        getServiceDurationSeconds("cng", 5),
        "a loosely-cased 'cNg' must still resolve to CNG's duration for the booked 5 kg",
      );
    });

    await t.test("HTTP: a booking request in the past is rejected", async () => {
      const { status, body } = await post(tokenFor(nextUser()), baseBody({ fuelType: "Petrol", bookingDate: "2020-01-01", timeSlot: "9:00 AM" }));
      assert.equal(status, 400);
      assert.equal(body.reason, "SLOT_PASSED");
    });

    await t.test("HTTP: two DIFFERENT non-overlapping bookings fired concurrently at the SAME station both succeed", async () => {
      const [r1, r2] = await Promise.all([
        post(tokenFor(nextUser()), baseBody({ fuelType: "Petrol", timeSlot: "10:00 AM" })),
        post(tokenFor(nextUser()), baseBody({ fuelType: "CNG", timeSlot: "10:30 AM" })),
      ]);
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      assert.equal(r2.status, 200, JSON.stringify(r2.body));
    });

    await t.test("HTTP: concurrent bookings at TWO DIFFERENT stations never block each other", async () => {
      const stationC = await Station.create({
        name: `${tag}-C`,
        address: "Scenario Road C",
        coordinates: { lat: 18.4, lng: 73.7 },
        fuelTypes: ["CNG"],
        prices: { cng: 80 },
        inventory: { cng: 1000 },
        status: "Active",
      });
      createdIds.stations.push(stationC._id);

      const [r1, r2] = await Promise.all([
        post(tokenFor(nextUser()), { ...baseBody({ fuelType: "CNG", timeSlot: "11:00 AM" }), stationId: String(stationA._id) }),
        post(tokenFor(nextUser()), { ...baseBody({ fuelType: "CNG", timeSlot: "11:00 AM" }), stationId: String(stationC._id) }),
      ]);
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      assert.equal(r2.status, 200, JSON.stringify(r2.body));
    });

    await t.test("HTTP: completing a booking frees the nozzle for a new overlapping request", async () => {
      // All of 12:00 PM's Diesel positions but one are taken; b1 takes the last.
      await require("./helpers/fillWindow").fillWindow({ stationId: stationA._id, fuelType: "Diesel", date: "2099-05-02", label: "12:00 PM", leaveFree: 1 });
      const b1 = await post(tokenFor(nextUser()), baseBody({ fuelType: "Diesel", timeSlot: "12:00 PM", bookingDate: "2099-05-02" }));
      assert.equal(b1.status, 200, JSON.stringify(b1.body));
      const bookingId = b1.body.booking._id;

      // A second user's overlapping Diesel request must be rejected while it's still active.
      const conflictAttempt = await post(tokenFor(nextUser()), baseBody({ fuelType: "Diesel", timeSlot: "12:00 PM", bookingDate: "2099-05-02" }));
      assert.equal(conflictAttempt.status, 400);
      assert.equal(conflictAttempt.body.reason, "SLOT_FULL");

      // Petrol at the same time uses the Petrol nozzle: not blocked by the Diesel booking.
      const otherFuel = await post(tokenFor(nextUser()), baseBody({ fuelType: "Petrol", timeSlot: "12:00 PM", bookingDate: "2099-05-02" }));
      assert.equal(otherFuel.status, 200, JSON.stringify(otherFuel.body));

      // Mark it completed directly (mirrors what markServed/vendor completion does).
      await Booking.updateOne({ _id: bookingId }, { $set: { status: "completed" } });

      const afterComplete = await post(tokenFor(nextUser()), baseBody({ fuelType: "Diesel", timeSlot: "12:00 PM", bookingDate: "2099-05-02" }));
      assert.equal(afterComplete.status, 200, JSON.stringify(afterComplete.body));
    });

    await t.test("HTTP: cancelling via the real endpoint frees the nozzle for a new overlapping request", async () => {
      const canceller = nextUser();
      const b1 = await post(tokenFor(canceller), baseBody({ fuelType: "CNG", timeSlot: "1:00 PM", bookingDate: "2099-05-03" }));
      assert.equal(b1.status, 200, JSON.stringify(b1.body));
      const bookingId = b1.body.booking._id;

      const cancelRes = await fetch(`${API}/api/bookings/${bookingId}/cancel`, {
        method: "PATCH",
        headers: { "x-auth-token": tokenFor(canceller) },
      });
      assert.equal(cancelRes.status, 200);

      const afterCancel = await post(tokenFor(nextUser()), baseBody({ fuelType: "Petrol", timeSlot: "1:00 PM", bookingDate: "2099-05-03" }));
      assert.equal(afterCancel.status, 200, JSON.stringify(afterCancel.body));
    });

    await t.test("HTTP: the availability endpoint accurately reflects a real reservation", async () => {
      const resp = await fetch(
        `${API}/api/bookings/availability?stationId=${stationA._id}&fuelType=Petrol&date=2099-05-02`,
      );
      const data = await resp.json();
      const slot1200 = data.slots.find((s) => s.label === "12:00 PM");
      assert.ok(slot1200, "the availability grid must include the 12:00 PM label");
      // An earlier sub-test booked one Petrol fill at 12:00 PM: 44 of 45 remain.
      assert.equal(slot1200.capacity.total, 45);
      assert.equal(slot1200.capacity.reserved, 1, "the real booking is counted");
      assert.equal(slot1200.capacity.available, 44, "a real active booking reduces what is left");
      const slot1230 = data.slots.find((s) => s.label === "12:30 PM");
      assert.equal(slot1230.available, true, "an untouched slot must report available");
      assert.equal(slot1230.capacity.available, 45);
    });
  }

  // --- cleanup: unconditional ---
  await Booking.deleteMany({ station: { $in: createdIds.stations } });
  await Booking.deleteMany({ _id: { $in: createdIds.bookings } });
  await require("../src/models/BookingAttempt").deleteMany({ user: { $in: createdIds.users } });
  await require("../src/models/InventoryMovement").deleteMany({ station: { $in: createdIds.stations } });
  await Station.deleteMany({ _id: { $in: createdIds.stations } });
  await User.deleteMany({ _id: { $in: createdIds.users } });
  await mongoose.disconnect();
});
