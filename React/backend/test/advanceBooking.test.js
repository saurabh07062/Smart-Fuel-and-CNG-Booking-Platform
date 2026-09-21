/**
 * Advance booking window (config/booking.js ADVANCE_BOOKING_DAYS, default 2):
 * today, tomorrow and the day after can be booked; later dates are refused.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

test("bookings are accepted only 2 days ahead", () => {
  const saved = process.env.ADVANCE_BOOKING_DAYS;
  delete process.env.ADVANCE_BOOKING_DAYS; // the real default
  try {
    const rules = require("../src/config/booking");
    const { validateInput } = require("../src/services/booking/bookingCreate");
    const { dateKey } = require("../src/config/businessTime");
    const day = (n) => dateKey(new Date(Date.now() + n * 86_400_000));
    const body = (bookingDate) => ({ stationId: "6aabb9028830bdc4c60f978b", fuelType: "Petrol", quantity: 5, bookingDate, timeSlot: "9:30 PM" });

    assert.equal(rules.advanceBookingDays(), 2);
    assert.equal(rules.lastBookableDate(), day(2));
    for (const n of [1, 2]) assert.doesNotThrow(() => validateInput(body(day(n))), `${n} day(s) ahead is allowed`);
    assert.throws(() => validateInput(body(day(3))), { reason: "DATE_TOO_FAR" });
    assert.throws(() => validateInput(body("2099-01-01")), { reason: "DATE_TOO_FAR" });

    process.env.ADVANCE_BOOKING_DAYS = "5";
    assert.equal(rules.lastBookableDate(), day(5), "configurable without a code change");
  } finally {
    if (saved === undefined) delete process.env.ADVANCE_BOOKING_DAYS;
    else process.env.ADVANCE_BOOKING_DAYS = saved;
  }
});
