/**
 * Mark a booking as "the customer is at the pump".
 *
 * The 4-digit code only works after the customer has checked in at the
 * station (controllers/bookingController.js, NOT_CHECKED_IN), so any test
 * that drives the attendant's side has to put the customer there first.
 * Doing it in one helper keeps that rule in one place: when the rule changes,
 * the tests change here and not in nine files.
 */

const Booking = require("../../src/models/Booking");

/**
 * @param {import("mongoose").Types.ObjectId|string} bookingId
 * @param {Date} [at] when they arrived; defaults to now.
 */
async function arriveAtPump(bookingId, at = new Date()) {
  await Booking.updateOne(
    { _id: bookingId },
    { $set: { stationCheckInAt: at, stationCheckInDistanceM: 0 } },
  );
  return at;
}

module.exports = { arriveAtPump };
