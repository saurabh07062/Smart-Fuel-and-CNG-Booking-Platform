/**
 * A customer who has not arrived by the end of their slot is cancelled
 * automatically (services/booking/bookingSweep.js): status "no_show", stock
 * given back. NO_SHOW_GRACE_MINUTES (default 0) delays it; a car already
 * checked in at the pump is never cancelled.
 *
 * Test database only; the tagged station and bookings are removed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const mongoose = require("mongoose");
const testDb = require("./helpers/testDb");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("missed slot: cancelled automatically when the slot ends", { timeout: 60_000 }, async (t) => {
  testDb.isolateRedis();
  try {
    await mongoose.connect(testDb.uri(), { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const { sweepStaleBookings } = require("../src/services/booking/bookingSweep");
  const { BOOKABLE_SLOT_LABELS, slotEndInstant } = require("../src/config/booking");
  const { dateKey } = require("../src/config/businessTime");

  const today = dateKey();
  // The latest slot today that has already ended.
  const ended = [...BOOKABLE_SLOT_LABELS].reverse().find((l) => slotEndInstant(today, l) <= new Date());
  if (!ended) {
    t.skip("no slot has ended yet today (India time)");
    await mongoose.disconnect();
    return;
  }

  const tag = `noshow-${Date.now()}`;
  const station = await Station.create({
    name: `${tag}-station`, address: "No-show Road", status: "Active",
    fuelTypes: ["Petrol"], prices: { petrol: 100 }, inventory: { petrol: 1000 }, inventoryCommitted: { petrol: 20 },
  });
  const mk = (extra = {}) =>
    Booking.create({
      user: new mongoose.Types.ObjectId(), station: station._id, fuelType: "Petrol", quantity: 10, price: 100, amount: 1005,
      bookingDate: today, timeSlot: ended, status: "upcoming", stockReserved: true, payMethod: "station", ...extra,
    });
  const saved = process.env.NO_SHOW_GRACE_MINUTES;

  try {
    await t.test("with a grace period set, it waits", async () => {
      const b = await mk();
      process.env.NO_SHOW_GRACE_MINUTES = "100000";
      await sweepStaleBookings(undefined, { stationIds: [station._id] });
      assert.equal((await Booking.findById(b._id).lean()).status, "upcoming");
      await Booking.deleteOne({ _id: b._id });
    });

    await t.test("default: cancelled as soon as the slot is over; stock given back", async () => {
      delete process.env.NO_SHOW_GRACE_MINUTES;
      const missed = await mk();
      const atPump = await mk({ arrivalTime: new Date() });
      const result = await sweepStaleBookings(undefined, { stationIds: [station._id] });
      assert.ok(result.noShow >= 1);
      const m = await Booking.findById(missed._id).lean();
      assert.equal(m.status, "no_show", "not arrived in the slot: cancelled");
      assert.equal(m.stockReserved, false, "its fuel is back in stock");
      assert.equal((await Booking.findById(atPump._id).lean()).status, "upcoming", "checked in at the pump: never cancelled");
    });
  } finally {
    if (saved === undefined) delete process.env.NO_SHOW_GRACE_MINUTES;
    else process.env.NO_SHOW_GRACE_MINUTES = saved;
    await Booking.deleteMany({ station: station._id });
    await Station.deleteMany({ _id: station._id });
    await mongoose.disconnect();
  }
});
