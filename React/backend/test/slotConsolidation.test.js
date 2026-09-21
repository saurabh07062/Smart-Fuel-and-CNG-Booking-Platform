/**
 * Phase 4: one slot model.
 *
 * config/booking.js (labels, slot end, elapsed), models/Station.js opening
 * hours, services/queue/nozzleScheduler.js generateAvailability /
 * findNextAvailableStart, GET /api/bookings/availability, booking creation
 * refusing a closed slot, and the retired /api/v1/slots/availability.
 *
 * DEVELOPMENT TEST DATA: tagged stations/users and bookings on 2099 dates,
 * removed at the end. Booking creation is called as a service, so no email.
 *
 *   node --test test/slotConsolidation.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const {
  BOOKABLE_SLOT_LABELS,
  SLOT_SPACING_SECONDS,
  slotEndInstant,
  isSlotElapsed,
} = require("../src/config/booking");
const { atBusinessTime, clockParts } = require("../src/config/businessTime");
const Station = require("../src/models/Station");

// Booking creation below takes locks and the booking route rate limit; with a
// test Redis configured each opens a connection, and an open one keeps this
// file's process from ever exiting.
test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const dayNameOf = (date) => DAY_NAMES[clockParts(atBusinessTime(date, 12, 0)).dayOfWeek];

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

test("slot labels: the whole day, 12:00 AM to 11:30 PM, 30 minutes apart", () => {
  assert.equal(BOOKABLE_SLOT_LABELS.length, 48);
  assert.equal(BOOKABLE_SLOT_LABELS[0], "12:00 AM");
  assert.equal(BOOKABLE_SLOT_LABELS[47], "11:30 PM");
  assert.equal(SLOT_SPACING_SECONDS, 1800);
});

test("slotEndInstant / isSlotElapsed: one rule, India time", () => {
  assert.equal(slotEndInstant("2099-01-15", "6:30 PM").toISOString(), "2099-01-15T13:30:00.000Z"); // 19:00 IST
  assert.equal(slotEndInstant("2099-01-15", "10:00-10:15").toISOString(), "2099-01-15T04:45:00.000Z");
  assert.equal(slotEndInstant("2099-01-15", "whenever"), null);

  const now = atBusinessTime("2099-01-15", 10, 29);
  assert.equal(isSlotElapsed("2099-01-15", "10:00 AM", now), false, "still inside its 30 minutes");
  assert.equal(isSlotElapsed("2099-01-15", "10:00 AM", atBusinessTime("2099-01-15", 10, 31)), true);
  assert.equal(isSlotElapsed("2099-01-14", "9:30 PM", now), true);
  assert.equal(isSlotElapsed(null, "10:00 AM", now), true);
});

test("bookingSweep and bookingCreate use the same slot end", () => {
  const { parseSlotEndDateTime } = require("../src/services/booking/bookingSweep");
  const bookingCreate = require("../src/services/booking/bookingCreate");
  assert.equal(parseSlotEndDateTime("2099-01-15", "6:30 PM").getTime(), slotEndInstant("2099-01-15", "6:30 PM").getTime());
  assert.equal(bookingCreate.isSlotElapsed, isSlotElapsed);
});

test("scheduleAllowsSlot: closed day, hours, 24h, legacy openingHours", () => {
  const date = "2099-06-01";
  const day = dayNameOf(date);
  const withDay = (d) => ({ operatingSchedule: { [day]: d } });

  assert.equal(Station.scheduleAllowsSlot(withDay({ isClosed: true }), date, "10:00 AM"), false);
  assert.equal(Station.scheduleAllowsSlot(withDay({ is24h: true }), date, "6:00 AM"), true);
  const hours = withDay({ is24h: false, open: "08:00", close: "20:00" });
  assert.equal(Station.scheduleAllowsSlot(hours, date, "7:30 AM"), false);
  assert.equal(Station.scheduleAllowsSlot(hours, date, "8:00 AM"), true);
  assert.equal(Station.scheduleAllowsSlot(hours, date, "7:30 PM"), true);
  assert.equal(Station.scheduleAllowsSlot(hours, date, "8:00 PM"), false, "close time is exclusive");
  assert.equal(Station.scheduleAllowsSlot({ openingHours: "Closed" }, date, "10:00 AM"), false);
  assert.equal(Station.scheduleAllowsSlot({ openingHours: "24 Hours" }, date, "10:00 AM"), true);
});

test("isOpenNow uses the same hours, at an injected time", () => {
  const date = "2099-06-01";
  const day = dayNameOf(date);
  const s = Station.hydrate({ status: "Active", operatingSchedule: { [day]: { is24h: false, open: "08:00", close: "20:00" } } });
  assert.equal(s.isOpenNow(atBusinessTime(date, 9, 0)).isOpen, true);
  const early = s.isOpenNow(atBusinessTime(date, 7, 0));
  assert.equal(early.isOpen, false);
  assert.equal(early.nextOpenTime, "Today 08:00");
  assert.equal(s.isOpenNow(atBusinessTime(date, 21, 0)).isOpen, false);
});

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

test("slot model against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const Booking = require("../src/models/Booking");
  const User = require("../src/models/User");
  const BookingAttempt = require("../src/models/BookingAttempt");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");
  const bookingController = require("../src/controllers/bookingController");
  const { createCustomerBooking } = require("../src/services/booking/bookingCreate");

  const tag = `slots-${Date.now()}`;
  const DATE = "2099-06-01";
  const day = dayNameOf(DATE);

  const station = await Station.create({
    name: `${tag}-station`,
    address: "Slot Test",
    status: "Active",
    // Away from the geo test files' fixtures, which run concurrently.
    coordinates: { lat: -55, lng: -10 },
    fuelTypes: ["Petrol", "CNG"],
    prices: { petrol: 100, cng: 80 },
    inventory: { petrol: 1000, cng: 500 },
    operatingSchedule: { [day]: { is24h: false, open: "08:00", close: "20:00", isClosed: false } },
  });
  const customer = await User.create({
    name: `${tag}-customer`,
    email: `${tag}@example.com`,
    password: "not-a-real-hash",
    role: "customer",
    isVerified: true,
  });

  // 10:00 AM is fully booked on the Petrol nozzle: 45 back-to-back 40 s fills.
  await require("./helpers/fillWindow").fillWindow({ stationId: station._id, fuelType: "Petrol", date: DATE, label: "10:00 AM" });

  const call = async (fn, query) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
    await fn({ query }, res);
    return res;
  };

  try {
    await t.test("generateAvailability: every label with bookable and a reason", async () => {
      const now = atBusinessTime(DATE, 9, 15);
      const rows = await nozzleScheduler.generateAvailability(station._id, "petrol", DATE, { station, now });
      const by = Object.fromEntries(rows.map((r) => [r.label, r]));
      assert.equal(rows.length, 48);
      assert.equal(by["7:30 AM"].reason, "PASSED");
      assert.equal(by["8:30 AM"].reason, "PASSED");
      assert.equal(by["9:00 AM"].reason, null, "9:00 AM is still inside its slot at 9:15");
      assert.equal(by["10:00 AM"].reason, "RESERVED");
      assert.deepEqual({ ...by["10:00 AM"].capacity }, { total: 45, available: 0, reserved: 45, resources: 1 });
      assert.equal(by["10:30 AM"].bookable, true);
      assert.equal(by["10:30 AM"].capacity.available, 45);
      assert.equal(by["8:00 PM"].reason, "CLOSED");
      assert.equal(by["9:30 PM"].withinHours, false);
      assert.equal(by["10:30 AM"].durationSeconds, 40);
    });

    await t.test("findNextAvailableStart never suggests a passed, closed or reserved slot", async () => {
      const next = (from, now) => nozzleScheduler.findNextAvailableStart(station._id, "cng", DATE, from, { station, now });
      const nextPetrol = (from, now) => nozzleScheduler.findNextAvailableStart(station._id, "petrol", DATE, from, { station, now });
      assert.equal(await nextPetrol("10:00 AM", atBusinessTime(DATE, 6, 0)), "10:30 AM", "10:00 AM is reserved on the Petrol nozzle");
      assert.equal(await next("10:00 AM", atBusinessTime(DATE, 6, 0)), "10:00 AM", "the 10:00 Petrol booking is on another nozzle");
      assert.equal(await next("6:00 AM", atBusinessTime(DATE, 6, 0)), "8:00 AM", "the station opens at 8");
      assert.equal(await next("9:30 AM", atBusinessTime(DATE, 10, 45)), "10:30 AM", "earlier labels have passed");
      assert.equal(await next("7:30 PM", atBusinessTime(DATE, 6, 0)), "7:30 PM");
      assert.equal(await next("8:00 PM", atBusinessTime(DATE, 6, 0)), null, "closed for the rest of the day");
    });

    await t.test("GET /api/bookings/availability validates input and applies the station's hours", async () => {
      const q = { stationId: String(station._id), fuelType: "Petrol", date: DATE };
      assert.equal((await call(bookingController.getAvailability, { ...q, stationId: "nope" })).statusCode, 400);
      assert.equal((await call(bookingController.getAvailability, { ...q, fuelType: "hydrogen" })).statusCode, 400);
      assert.equal((await call(bookingController.getAvailability, { ...q, date: "2099-02-30" })).statusCode, 400);
      assert.equal(
        (await call(bookingController.getAvailability, { ...q, stationId: String(new mongoose.Types.ObjectId()) })).statusCode,
        404,
      );

      const ok = await call(bookingController.getAvailability, q);
      assert.equal(ok.statusCode, 200);
      assert.equal(ok.body.fuelType, "Petrol");
      assert.equal(ok.body.stationActive, true);
      const by = Object.fromEntries(ok.body.slots.map((r) => [r.label, r]));
      assert.equal(by["7:30 AM"].reason, "CLOSED");
      assert.equal(by["10:00 AM"].reason, "RESERVED");
      assert.equal(by["10:00 AM"].available, false, "`available` still means the nozzle, as the grid expects");
      assert.equal(by["11:00 AM"].bookable, true);
    });

    await t.test("booking creation refuses a slot outside the station's hours", async () => {
      const body = {
        stationId: String(station._id),
        fuelType: "Petrol",
        quantity: 5,
        bookingDate: DATE,
        payMethod: "station",
      };
      await assert.rejects(
        createCustomerBooking({ user: { id: String(customer._id) }, body: { ...body, timeSlot: "7:00 AM" } }),
        (err) => err.reason === "STATION_CLOSED_AT_SLOT" && err.status === 409,
      );
      const ok = await createCustomerBooking({ user: { id: String(customer._id) }, body: { ...body, timeSlot: "11:00 AM" } });
      assert.equal(ok.timeSlot, "11:00 AM");
    });

    await t.test("GET /api/v1/slots/availability is retired", async () => {
      const express = require("express");
      const app = express().use("/s", require("../src/routes/slotRoutes"));
      const server = app.listen(0);
      try {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/s/availability?stationId=${station._id}&date=${DATE}`);
        assert.equal(r.status, 410);
        assert.equal((await r.json()).reason, "ENDPOINT_RETIRED");
      } finally {
        server.close();
      }
    });
  } finally {
    await Booking.deleteMany({ station: station._id });
    await BookingAttempt.deleteMany({ user: customer._id });
    await Station.deleteOne({ _id: station._id });
    await User.deleteOne({ _id: customer._id });
    await mongoose.disconnect();
  }
});
