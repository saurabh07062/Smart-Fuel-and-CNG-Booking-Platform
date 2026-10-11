/**
 * Checking a whole fleet in with ONE code.
 *
 * WHY THIS EXISTS
 *
 * Every vehicle of a fleet booking carries the same four-digit code
 * (services/booking/fleetBooking.js). When the attendant types it, the intent
 * is "this customer and their vans are here", not "this one van" -- so the
 * whole group is checked in at once.
 *
 * WHAT "CHECKED IN AT ONCE" ACTUALLY MEANS
 *
 * It does not mean five vehicles start fuelling together; a nozzle serves one
 * at a time and the database will not have it otherwise
 * (models/Booking.js uniq_serving_per_resource). Each member goes through the
 * SAME per-booking check-in the single-vehicle flow uses
 * (services/queue/nozzleService.js checkIn), in booked order, under that
 * fuel's nozzle lock. The first that can take a nozzle starts; the rest are
 * recorded as waiting at the pump and start by themselves as nozzles free.
 *
 * Nothing about slots, durations or queue order is decided here. This file
 * only fans one code out to the group's members and reports what happened to
 * each one.
 */

const Booking = require("../../models/Booking");
const nozzleService = require("../queue/nozzleService");

/** Statuses a member can still be checked in from. */
const CHECKABLE = ["upcoming"];

/**
 * Check in every live member of a group.
 *
 * @param {object} args
 * @param {Array} args.bookings  the group's member bookings (documents)
 * @param {Date}  [args.now]
 * @param {boolean} [args.allowNotCheckedIn] admin override: serve a member
 *        whose customer has not tapped "Check In at Petrol Pump"
 * @returns {Promise<{started: Array, queued: Array, skipped: Array}>}
 */
async function checkInGroup({ bookings, now = new Date(), allowNotCheckedIn = false }) {
  // Booked order, so the van the customer thinks of as "first" is served
  // first. Members without an index (impossible for new groups) fall to the end.
  const members = [...bookings].sort((a, b) => (a.fleetIndex ?? 99) - (b.fleetIndex ?? 99));

  const started = [];
  const queued = [];
  const skipped = [];

  for (const member of members) {
    const describe = (extra = {}) => ({
      bookingId: String(member._id),
      orderId: member.orderId || null,
      vehiclePlate: member.vehiclePlate || null,
      fleetIndex: member.fleetIndex ?? null,
      timeSlot: member.timeSlot || null,
      ...extra,
    });

    if (member.status === "serving") {
      queued.push(describe({ already: true, msg: "Already fuelling." }));
      continue;
    }
    if (!CHECKABLE.includes(member.status)) {
      skipped.push(describe({ reason: "NOT_UPCOMING", msg: `This vehicle's booking is ${member.status}.` }));
      continue;
    }
    // The same rule a single booking is held to: the code works once the
    // customer is actually at the station. For a group one tap checks every
    // member in (services/booking/stationArrival.js), so this only trips when
    // nobody has arrived yet.
    if (!member.stationCheckInAt && !allowNotCheckedIn) {
      skipped.push(describe({ reason: "NOT_CHECKED_IN", msg: "Not checked in at the pump yet." }));
      continue;
    }
    // An online booking must be settled; pay-at-pump is legitimately unpaid.
    if (member.paymentStatus !== "paid" && member.payMethod !== "station") {
      skipped.push(describe({ reason: "PAYMENT_PENDING", msg: "Payment not completed." }));
      continue;
    }

    let result;
    try {
      result = await nozzleService.checkIn({ bookingId: member._id, now });
    } catch (err) {
      // A lock problem concerns THIS vehicle only: the rest of the group is
      // still checked in, and the attendant can scan this one again.
      if (["LOCK_TIMEOUT", "LOCK_EXPIRED", "LOCK_UNAVAILABLE"].includes(err?.code)) {
        skipped.push(describe({ reason: "PUMP_BUSY", msg: "The pump was busy updating. Try this vehicle again." }));
        continue;
      }
      throw err;
    }

    if (result.outcome === "started") {
      started.push(describe({ completesAt: result.releaseAt ?? null }));
    } else if (result.outcome === "already_serving") {
      queued.push(describe({ already: true, msg: "Already fuelling." }));
    } else if (result.booking) {
      queued.push(describe({ nozzleFreeAt: result.nozzleFreeAt ?? null }));
    } else {
      skipped.push(describe({ reason: "CHANGED", msg: "This booking changed just now. Scan it again." }));
    }
  }

  return { started, queued, skipped };
}

/** What the attendant is told, in one line. */
function describeOutcome({ started, queued, skipped }) {
  const parts = [];
  if (started.length) {
    parts.push(
      started.length === 1
        ? `${started[0].vehiclePlate || "The first vehicle"} is fuelling now.`
        : `${started.length} vehicles started fuelling.`,
    );
  }
  if (queued.length) {
    parts.push(
      `${queued.length} waiting at the pump: ${queued.map((q) => q.vehiclePlate || "a vehicle").join(", ")}. Each starts as a nozzle frees.`,
    );
  }
  if (skipped.length) {
    parts.push(`${skipped.length} not checked in: ${skipped.map((s) => `${s.vehiclePlate || "a vehicle"} (${s.msg})`).join("; ")}`);
  }
  return parts.join(" ") || "Nothing to check in.";
}

/**
 * The group's live members, for a code that matched several bookings.
 *
 * Re-read as documents (the caller may hold lean rows) and restricted to the
 * one group -- a code shared by two DIFFERENT groups is not a group check-in
 * and the caller refuses it.
 */
async function liveMembers(fleetGroupId) {
  return Booking.find({ fleetGroup: fleetGroupId, status: { $in: ["upcoming", "serving"] } }).sort({ fleetIndex: 1 });
}

module.exports = { checkInGroup, describeOutcome, liveMembers };
