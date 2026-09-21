/**
 * Booking against the nozzle as it is actually in use
 * (services/queue/nozzleScheduler.js liveServiceWindows): a fill running past its
 * booked window, and cars waiting at the pump behind it, block the slots they
 * reach into -- for new bookings and in the availability grid -- until the
 * nozzle is released.
 *
 * DEVELOPMENT TEST DATA, test database only: tagged users and stations with no
 * map position; bookings dated today at the first slots still ahead; all
 * removed at the end.
 *
 *   node --test test/nozzleAvailability.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

test.after(async () => {
  require("../src/services/queue/serviceTimer").clearAllTimers();
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("booking against the live nozzle, against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const { BOOKABLE_SLOT_LABELS } = require("../src/config/booking");
  const { dateKey } = require("../src/config/businessTime");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");
  const { createCustomerBooking } = require("../src/services/booking/bookingCreate");
  const { completeBooking } = require("../src/services/booking/bookingCompletion");
  const { transitionBooking } = require("../src/services/booking/bookingTransitions");
  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const BookingAttempt = require("../src/models/BookingAttempt");
  await Booking.init();

  const TODAY = dateKey();
  const startOf = (label) => nozzleScheduler.parseStartDateTime(TODAY, label);
  // The first label starting at least 10 minutes from now, with 6 more after it.
  const index = BOOKABLE_SLOT_LABELS.findIndex((l) => startOf(l).getTime() >= Date.now() + 10 * 60_000);
  if (index === -1 || index + 6 >= BOOKABLE_SLOT_LABELS.length) {
    t.skip("not enough of today's slots left to set this up");
    await mongoose.disconnect();
    return;
  }
  const L = BOOKABLE_SLOT_LABELS[index];
  const later = (n) => BOOKABLE_SLOT_LABELS[index + n];

  const tag = `nozavail-${Date.now()}`;
  const customers = await User.insertMany(
    Array.from({ length: 6 }, (_, i) => ({
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
      address: "Nozzle Availability Test",
      status: "Active",
      fuelTypes: ["Petrol", "CNG"],
      prices: { petrol: 100, cng: 80 },
      inventory: { petrol: 1000, cng: 1000 },
    });
    stationIds.push(s._id);
    return s;
  };
  const fixture = (station, user, label, fields = {}) => {
    const w = nozzleScheduler.computeWindow(fields.fuelType || "Petrol", startOf(label));
    return Booking.create({
      user: user._id,
      station: station._id,
      fuelType: "Petrol",
      quantity: 5,
      price: 100,
      amount: 505,
      bookingDate: TODAY,
      timeSlot: label,
      bookingStartTime: w.start,
      bookingEndTime: w.end,
      serviceDurationSeconds: w.durationSeconds,
      payMethod: "station",
      status: "upcoming",
      ...fields,
    });
  };
  /** The availability grid's row for one label: what GET /api/bookings/availability returns. */
  const rowFor = async (station, label) =>
    (await nozzleScheduler.generateAvailability(station._id, "Petrol", TODAY, { station })).find((r) => r.label === label);
  const bookSlot = (station, user, label) =>
    createCustomerBooking({
      user: { id: String(user._id) },
      body: { stationId: String(station._id), fuelType: "Petrol", quantity: 5, bookingDate: TODAY, timeSlot: label, payMethod: "station" },
    });

  try {
    await t.test(`a Petrol fill running into ${L} pushes ${L}'s first position past its release`, async () => {
      const s = await makeStation("overrun");
      const slotWindow = nozzleScheduler.computeWindow("Petrol", startOf(L));
      const cngWindow = nozzleScheduler.computeWindow("CNG", startOf(L));
      assert.equal(await nozzleScheduler.hasOverlap(s._id, slotWindow.start, slotWindow.end, undefined, { fuelType: "Petrol" }), false, "free before");

      // Checked in late for an earlier slot: fueling from 1 minute before L, for 200 s.
      const filling = await fixture(s, customers[0], later(6), {
        status: "serving",
        arrivalTime: new Date(startOf(L).getTime() - 60_000),
        fuelingStartTime: new Date(startOf(L).getTime() - 60_000),
        serviceDurationSeconds: 200,
      });

      assert.equal(await nozzleScheduler.hasOverlap(s._id, slotWindow.start, slotWindow.end, undefined, { fuelType: "Petrol" }), true);
      assert.equal(
        await nozzleScheduler.hasOverlap(s._id, cngWindow.start, cngWindow.end, undefined, { fuelType: "CNG" }),
        false,
        "the CNG nozzle is a different nozzle: a Petrol fill never blocks it",
      );
      // The fill holds the nozzle until L + 140 s: the window keeps the rest.
      const L0 = startOf(L).getTime();
      const busyRow = await rowFor(s, L);
      assert.equal(busyRow.bookable, true);
      assert.equal(busyRow.start.getTime(), L0 + 140_000, "the first position starts when the fill is released");
      assert.equal(busyRow.capacity.available, 41, "floor((1800 - 140) / 40)");
      const b = await bookSlot(s, customers[1], L);
      assert.equal(new Date(b.bookingStartTime).getTime(), L0 + 140_000, "booking gets that exact position");
      await transitionBooking({ bookingId: b._id, to: "cancelled" });

      assert.ok(await completeBooking({ bookingId: filling._id, fromStatuses: ["serving"] }));
      const freeRow = await rowFor(s, L);
      assert.equal(freeRow.start.getTime(), L0, "released: the window starts at its own start again");
      assert.equal(freeRow.capacity.available, 45);
    });

    await t.test("a car waiting at the pump holds the nozzle for its projected turn", async () => {
      const s = await makeStation("waiting");
      // A 40 s petrol fill ending 10 s before L: on its own it leaves L free.
      await fixture(s, customers[2], later(5), {
        status: "serving",
        arrivalTime: new Date(startOf(L).getTime() - 50_000),
        fuelingStartTime: new Date(startOf(L).getTime() - 50_000),
        serviceDurationSeconds: 40,
      });
      assert.equal((await rowFor(s, L)).bookable, true);

      // A Petrol car checked in behind it: its turn starts 10 s before L and lasts 200 s.
      const waiting = await fixture(s, customers[3], later(4), {
        arrivalTime: new Date(),
        serviceDurationSeconds: 200,
      });
      // Its projected turn is L - 10 s to L + 190 s.
      const L0 = startOf(L).getTime();
      const row = await rowFor(s, L);
      assert.equal(row.start.getTime(), L0 + 190_000);
      assert.equal(row.capacity.available, 40, "floor((1800 - 190) / 40)");
      const placed = await bookSlot(s, customers[4], L);
      assert.equal(new Date(placed.bookingStartTime).getTime(), L0 + 190_000);
      await transitionBooking({ bookingId: placed._id, to: "cancelled" });
      const cngWindow = nozzleScheduler.computeWindow("CNG", startOf(L));
      assert.equal(
        await nozzleScheduler.hasOverlap(s._id, cngWindow.start, cngWindow.end, undefined, { fuelType: "CNG" }),
        false,
        "the Petrol line never holds the CNG nozzle",
      );

      // Excluding a booking ignores its own live window (waitlist promotion of that booking).
      const slotWindow = nozzleScheduler.computeWindow("Petrol", startOf(L));
      assert.equal(await nozzleScheduler.hasOverlap(s._id, slotWindow.start, slotWindow.end, waiting._id, { fuelType: "Petrol" }), false);

      await transitionBooking({ bookingId: waiting._id, to: "cancelled" });
      const after = await rowFor(s, L);
      assert.equal(after.start.getTime(), startOf(L).getTime(), "the waiting car left: L starts at its own start again");
      assert.equal(after.capacity.available, 45);
    });
  } finally {
    await Booking.deleteMany({ station: { $in: stationIds } });
    await BookingAttempt.deleteMany({ user: { $in: userIds } });
    await require("../src/models/InventoryMovement").deleteMany({ station: { $in: stationIds } });
    await Station.deleteMany({ _id: { $in: stationIds } });
    await User.deleteMany({ _id: { $in: userIds } });
    await mongoose.disconnect();
  }
});
