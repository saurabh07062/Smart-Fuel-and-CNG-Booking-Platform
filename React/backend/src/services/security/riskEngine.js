/**
 * Deterministic risk scoring for a booking request.
 *
 * Explicit rules, each worth a fixed number of points, summed against a
 * threshold. Every block can be explained in one sentence and there is
 * nothing to train -- the platform has no labelled abuse data to learn from.
 *
 * Signals, and where their data comes from:
 *
 *   velocity        booking ATTEMPTS by this user in the last 10 minutes
 *                   (models/BookingAttempt, which records rejected and
 *                   malformed attempts too -- saved bookings would undercount)
 *   duplicate-slot  attempts at the exact same station/date/slot/fuel
 *   cancellations   bookings this customer cancelled themselves in the last
 *                   24 hours (vendor/admin cancellations are not the
 *                   customer's behaviour and are not counted)
 *
 * No single signal can block a customer on its own (every rule is worth less
 * than the threshold, checked when this module loads); two together can. A
 * customer retrying a full slot a few times, or cancelling twice after a
 * change of plans, is normal.
 *
 * A blocked request carries retryAfterSeconds: when enough of the counted
 * activity ages out of its window for the score to fall below the threshold.
 *
 * Deliberately NOT a signal here: "impossible travel" between booked
 * stations. Booking two stations far apart minutes apart is ordinary (plans
 * change, a customer books for a later time), because booking does not place
 * the customer at the station. It would block legitimate users.
 */

const Booking = require("../../models/Booking");
const BookingAttempt = require("../../models/BookingAttempt");

const DEFAULT_THRESHOLD = 70;

const RULES = Object.freeze({
  // more than 6 earlier attempts
  velocity: { name: "velocity", points: 40, windowMinutes: 10, limit: 6 },
  // more than 3 earlier attempts at the same slot
  duplicateSlot: { name: "duplicate-slot", points: 40, windowMinutes: 10, limit: 3 },
  // more than 2 self-cancellations
  cancellations: { name: "cancellations", points: 30, windowHours: 24, windowMinutes: 24 * 60, limit: 2 },
});

// The guarantee the rules are designed around, enforced rather than hoped for.
for (const rule of Object.values(RULES)) {
  if (rule.points >= DEFAULT_THRESHOLD) {
    throw new Error(`Risk rule "${rule.name}" (${rule.points} points) could block on its own; threshold is ${DEFAULT_THRESHOLD}`);
  }
}

const REASON = {
  velocity: (n) => `${n} booking attempts in the last ${RULES.velocity.windowMinutes} minutes`,
  duplicateSlot: (n) => `${n} attempts at the same slot in the last ${RULES.duplicateSlot.windowMinutes} minutes`,
  cancellations: (n) => `${n} bookings cancelled in the last ${RULES.cancellations.windowHours} hours`,
};

/** Pure: does `count` trip rule `key`? */
function ruleResult(key, count) {
  const rule = RULES[key];
  if (count <= rule.limit) return { rule: rule.name, hit: false, count };
  return { rule: rule.name, hit: true, count, points: rule.points, reason: REASON[key](count) };
}

/**
 * Pure: combine rule results into one decision.
 *
 * retryAfterSeconds (blocked only) is the soonest moment one hit rule clears
 * and takes the score under the threshold.
 */
function combine(results, threshold = DEFAULT_THRESHOLD) {
  const hits = results.filter((r) => r.hit);
  const score = hits.reduce((sum, r) => sum + r.points, 0);
  const blocked = score >= threshold;

  let retryAfterSeconds = 0;
  if (blocked) {
    const clearing = hits.filter((h) => score - h.points < threshold).map((h) => h.retryAfterSeconds || 0);
    retryAfterSeconds = clearing.length
      ? Math.min(...clearing)
      : Math.max(...hits.map((h) => h.retryAfterSeconds || 0));
  }

  return {
    score,
    threshold,
    blocked,
    retryAfterSeconds,
    reasons: hits.map((h) => ({ rule: h.rule, points: h.points, reason: h.reason, count: h.count })),
  };
}

/** Pure: score plain counts (used to replay history -- scripts/riskReplay.js). */
function scoreFromCounts({ velocity = 0, duplicateSlot = 0, cancellations = 0 }, threshold = DEFAULT_THRESHOLD) {
  return combine(
    [ruleResult("velocity", velocity), ruleResult("duplicateSlot", duplicateSlot), ruleResult("cancellations", cancellations)],
    threshold,
  );
}

/**
 * Count the matching rows in the rule's window and, if the rule trips, work
 * out when it stops tripping: the moment the (count - limit)-th oldest row
 * ages out of the window.
 */
async function countInWindow(key, Model, query, timeField, now) {
  const rule = RULES[key];
  const windowMs = rule.windowMinutes * 60_000;
  const q = { ...query, [timeField]: { $gte: new Date(now.getTime() - windowMs), $lte: now } };

  const count = await Model.countDocuments(q);
  const result = ruleResult(key, count);
  if (!result.hit) return result;

  const over = count - rule.limit;
  const oldest = await Model.findOne(q).sort({ [timeField]: 1 }).skip(over - 1).select(timeField).lean();
  const agesOutAt = new Date(oldest?.[timeField] || now).getTime() + windowMs;
  return { ...result, retryAfterSeconds: Math.max(1, Math.ceil((agesOutAt - now.getTime()) / 1000)) };
}

/**
 * Earlier booking attempts by this user, any station.
 * `excludeAttemptId` leaves out the attempt currently being evaluated.
 */
async function velocityScore({ userId, excludeAttemptId, now = new Date() }) {
  const query = { user: userId };
  if (excludeAttemptId) query._id = { $ne: excludeAttemptId };
  return countInWindow("velocity", BookingAttempt, query, "createdAt", now);
}

/** Earlier attempts at the exact same station, date, slot and fuel. */
async function duplicateSlotScore({ userId, stationId, bookingDate, timeSlot, fuelType, excludeAttemptId, now = new Date() }) {
  const query = { user: userId, station: stationId, bookingDate, timeSlot, fuelType };
  if (excludeAttemptId) query._id = { $ne: excludeAttemptId };
  return countInWindow("duplicateSlot", BookingAttempt, query, "createdAt", now);
}

/** Bookings this customer cancelled themselves recently. */
async function cancellationScore({ userId, now = new Date() }) {
  return countInWindow(
    "cancellations",
    Booking,
    { user: userId, status: "cancelled", cancelledBy: "customer" },
    "cancelledAt",
    now,
  );
}

/**
 * Run every rule and combine them into one score + decision.
 *
 * @returns {{score:number, threshold:number, blocked:boolean, retryAfterSeconds:number,
 *            reasons:Array<{rule:string, points:number, reason:string, count:number}>}}
 */
async function evaluateBookingRisk({
  userId,
  stationId,
  bookingDate,
  timeSlot,
  fuelType,
  excludeAttemptId = null,
  threshold = DEFAULT_THRESHOLD,
  now = new Date(),
}) {
  if (!userId) return { score: 0, threshold, blocked: false, retryAfterSeconds: 0, reasons: [] };

  const results = await Promise.all([
    velocityScore({ userId, excludeAttemptId, now }),
    stationId
      ? duplicateSlotScore({ userId, stationId, bookingDate, timeSlot, fuelType, excludeAttemptId, now })
      : { rule: RULES.duplicateSlot.name, hit: false, count: 0 },
    cancellationScore({ userId, now }),
  ]);

  return combine(results, threshold);
}

module.exports = {
  evaluateBookingRisk,
  velocityScore,
  duplicateSlotScore,
  cancellationScore,
  scoreFromCounts,
  combine,
  DEFAULT_THRESHOLD,
  RULES,
};
