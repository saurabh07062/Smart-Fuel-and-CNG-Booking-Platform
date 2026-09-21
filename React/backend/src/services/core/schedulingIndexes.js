/**
 * Replace the one-booking-per-slot database guards with per-nozzle ones.
 *
 * Before booking windows held several bookings on several app nozzles
 * (services/queue/slotAllocator.js), the database allowed one live booking per
 * slot start, one serving booking and one serving walk-in per station and
 * fuel. Those indexes would now refuse valid bookings, so they are dropped and
 * the new ones (models/Booking.js, models/WalkIn.js) are built. Documents are
 * not changed: a booking without a nozzle number counts as nozzle 1.
 *
 * Idempotent and run once per process: at server start, and before any code
 * path that places a second vehicle on a fuel.
 */

const LEGACY = {
  bookings: ["uniq_active_nozzle_start_per_fuel", "uniq_serving_per_station_fuel"],
  walkins: ["uniq_serving_walkin_per_station_fuel", "uniq_serving_walkin_per_lane"],
};

let ready = null;

function ensureSchedulingIndexes() {
  if (!ready) {
    const Booking = require("../../models/Booking");
    const WalkIn = require("../../models/WalkIn");
    const drop = (model, names) =>
      Promise.all(names.map((n) => model.collection.dropIndex(n).catch(() => {}))); // already gone
    ready = Promise.all([drop(Booking, LEGACY.bookings), drop(WalkIn, LEGACY.walkins)])
      .then(() => Promise.all([Booking.createIndexes(), WalkIn.createIndexes()]))
      .then(() => true)
      .catch((err) => {
        ready = null; // try again next time
        throw err;
      });
  }
  return ready;
}

module.exports = { ensureSchedulingIndexes, LEGACY };
