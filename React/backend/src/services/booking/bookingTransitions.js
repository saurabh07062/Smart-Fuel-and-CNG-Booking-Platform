/**
 * Booking status transitions -- conditional, so concurrent actors cannot
 * overwrite each other.
 *
 * The problem this replaces: read the booking, check its status, change it,
 * save(). Mongoose's save() writes `status` unconditionally, so anything that
 * happened between the read and the save is silently undone. A customer
 * cancelling while the auto-complete sweep finishes the same booking left it
 * "cancelled" with its fuel already deducted from stock; the no-show sweep
 * could flip a booking the vendor had just started serving.
 *
 * Every status change now is one findOneAndUpdate whose filter includes the
 * statuses it may move FROM. If another actor changed the booking first, the
 * filter matches nothing and the caller gets null -- a conflict to report,
 * never a lost update.
 *
 * Completion is not here: it also deducts stock, exactly once, in
 * services/booking/bookingCompletion.js (the same conditional pattern).
 */

const Booking = require("../../models/Booking");
const metrics = require("../core/metrics");

/** from -> the statuses it may move to. Terminal statuses move nowhere. */
const TRANSITIONS = Object.freeze({
  waitlisted: ["upcoming", "cancelled", "expired"],
  upcoming: ["serving", "completed", "cancelled", "no_show", "expired"],
  serving: ["completed", "cancelled", "no_show"],
  completed: [],
  cancelled: [],
  no_show: [],
  expired: [],
});

const TERMINAL_STATUSES = Object.keys(TRANSITIONS).filter((s) => TRANSITIONS[s].length === 0);

/** Ending in one of these (not completion) returns a booking's reserved stock. */
const RELEASING_STATUSES = ["cancelled", "no_show", "expired"];

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

/** Statuses a booking may be in to move to `to`. */
function sourcesFor(to) {
  return Object.keys(TRANSITIONS).filter((from) => TRANSITIONS[from].includes(to));
}

/**
 * Move a booking to `to` if -- at the moment of the write -- it is in one of
 * the allowed source statuses.
 *
 * @param {object} p
 * @param {string} p.bookingId
 * @param {string} p.to
 * @param {string[]} [p.from]   narrow the allowed sources further
 * @param {object} [p.set]      fields written together with the status
 * @param {object} [p.filter]   extra conditions, e.g. { user } or { station }
 * @returns {Promise<import("mongoose").Document|null>} the updated booking, or
 *   null if it was not in an allowed status (or not found / not matching filter)
 */
async function transitionBooking({ bookingId, to, from, set = {}, filter = {} }) {
  if (to === "completed") {
    throw new Error("Use services/booking/bookingCompletion.js completeBooking() to complete a booking");
  }
  const allowed = (from || sourcesFor(to)).filter((f) => canTransition(f, to));
  if (allowed.length === 0) return null;

  try {
    const doc = await Booking.findOneAndUpdate(
      { ...filter, _id: bookingId, status: { $in: allowed } },
      { $set: { ...set, status: to } },
      { new: true, runValidators: true },
    );
    metrics.inc(doc ? "booking_transition_count" : "booking_transition_conflict_count");
    // A booking that stops being live without completing gives its reserved
    // stock back -- once, however many paths try (services/inventory/stockLedger.js).
    if (doc && RELEASING_STATUSES.includes(to)) {
      await require("../inventory/stockLedger")
        .releaseReservation(doc._id)
        .catch((err) => console.error(`[transition] stock release failed for ${doc._id}:`, err.message));
    }
    return doc;
  } catch (err) {
    // A move back into an active status (waitlisted -> upcoming) can collide
    // with the database guards: the nozzle start or the customer's one active
    // booking. That is a conflict, not a server error.
    if (err?.code === 11000) {
      metrics.inc("booking_transition_conflict_count");
      return null;
    }
    throw err;
  }
}

/** For a null transition: why? Returns the booking's current status, or null if absent. */
async function currentStatus(bookingId, filter = {}) {
  const b = await Booking.findOne({ ...filter, _id: bookingId }).select("status").lean();
  return b ? b.status : null;
}

module.exports = {
  TRANSITIONS,
  TERMINAL_STATUSES,
  canTransition,
  sourcesFor,
  transitionBooking,
  currentStatus,
};
