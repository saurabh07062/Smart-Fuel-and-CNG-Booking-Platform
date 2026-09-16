/**
 * Each fuel's app nozzle as a locked resource while a vehicle is actually at it.
 *
 * FuelMart reserves a nozzle's TIME when a booking is made
 * (services/queue/nozzleScheduler.js). This module guards the nozzle ITSELF,
 * separately for Petrol, Diesel and CNG:
 *
 *   checkIn        the attendant scans the PIN, or the vendor/admin starts
 *                  service by hand. That fuel's nozzle free -> the booking is
 *                  SERVING now. Busy -> the arrival is recorded and the booking
 *                  waits at the pump (status stays "upcoming", arrivalTime set).
 *   advanceNozzle  once a fuel's nozzle is free, the earliest vehicle waiting at
 *                  it -- a checked-in booking or a vendor-recorded walk-in
 *                  (models/WalkIn.js) -- starts, with no second scan.
 *
 * Both run under that fuel's nozzle lock (services/core/lock.js -- the same
 * lock booking creation takes). MongoDB refuses a second "serving" booking for
 * one station and fuel (models/Booking.js uniq_serving_per_station_fuel) and a
 * second serving walk-in (models/WalkIn.js); a booking and a walk-in at once is
 * prevented by the lock. Two attendants scanning at once, two server instances
 * or an expired lock still cannot put two cars on one nozzle.
 */

const Booking = require("../../models/Booking");
const WalkIn = require("../../models/WalkIn");
const lock = require("../core/lock");
const metrics = require("../core/metrics");
const { transitionBooking } = require("../booking/bookingTransitions");
const { getServiceDurationSeconds } = require("../../config/fuelDurations");
const { FUEL_KEYS, normaliseFuel, fuelLabel } = require("../../config/fuels");
const { dateKey } = require("../../config/businessTime");

const LOCK_OPTS = { ttlMs: 10_000, maxWaitMs: 3_000 };

/** The lock for one fuel's nozzle at one station. */
const nozzleKey = (stationId, fuelType) => `lock:nozzle:${stationId}:${normaliseFuel(fuelType) || "unknown"}`;

/** How long this booking holds the nozzle once fueling starts (config/fuelDurations.js). */
function serviceSecondsOf(booking) {
  const stored = Number(booking?.serviceDurationSeconds);
  return stored > 0 ? stored : getServiceDurationSeconds(booking?.fuelType, booking?.quantity);
}

/** When a serving booking's (or walk-in's) fill ends and the nozzle is released. */
function releaseAt(booking) {
  if (!booking?.fuelingStartTime) return null;
  return new Date(new Date(booking.fuelingStartTime).getTime() + serviceSecondsOf(booking) * 1000);
}

/** The vehicle at this fuel's nozzle now -- a booking or a walk-in -- or null. */
async function servingAt(stationId, fuelType) {
  const label = fuelLabel(fuelType);
  const booking = await Booking.findOne({ station: stationId, fuelType: label, status: "serving" })
    .select("_id fuelType quantity serviceDurationSeconds fuelingStartTime")
    .lean();
  if (booking) return booking;
  const walkIn = await WalkIn.findOne({ station: stationId, fuelType: label, status: "serving" })
    .select("_id fuelType quantity serviceDurationSeconds fuelingStartTime")
    .lean();
  return walkIn ? { ...walkIn, kind: "walkin" } : null;
}

/**
 * Upcoming -> serving, stamped now. null when the booking is no longer
 * upcoming or its fuel's nozzle already has a car serving (the unique index
 * turns that race into a refusal, via bookingTransitions).
 */
async function startService(bookingId, { now = new Date(), set = {} } = {}) {
  const current = await Booking.findOne({ _id: bookingId, status: "upcoming" })
    .select("fuelType quantity serviceDurationSeconds arrivalTime")
    .lean();
  if (!current) return null;
  return transitionBooking({
    bookingId,
    to: "serving",
    from: ["upcoming"],
    set: {
      arrivalTime: current.arrivalTime || now,
      ...set,
      fuelingStartTime: now,
      serviceDurationSeconds: serviceSecondsOf(current),
    },
  });
}

/**
 * A car is at the pump for this booking.
 *
 * @param {object} p
 * @param {string} p.bookingId
 * @param {object} [p.filter]  extra conditions, e.g. { station } for a vendor
 * @param {object} [p.set]     fields recorded at check-in (payment collection)
 * @param {Date}   [p.now]
 * @returns {Promise<{outcome:"started"|"queued"|"already_waiting", booking, releaseAt?:Date, nozzleFreeAt?:Date|null}
 *   | {outcome:"not_found"|"already_serving"|"not_upcoming"|"conflict", status?:string}>}
 * @throws LOCK_TIMEOUT / LOCK_EXPIRED (409) or LOCK_UNAVAILABLE (503) from services/core/lock.js
 */
async function checkIn({ bookingId, filter = {}, set = {}, now = new Date() }) {
  const booking = await Booking.findOne({ ...filter, _id: bookingId }).select("station fuelType status arrivalTime").lean();
  if (!booking) return { outcome: "not_found" };
  if (booking.status === "serving") return { outcome: "already_serving", status: "serving" };
  if (booking.status !== "upcoming") return { outcome: "not_upcoming", status: booking.status };

  const result = await lock.withLock(
    nozzleKey(booking.station, booking.fuelType),
    async (guard) => {
      const busy = await servingAt(booking.station, booking.fuelType);
      guard.assertHeld();

      if (!busy) {
        // Fueling starts when the nozzle is actually taken -- inside the lock,
        // which may have waited for a car ahead to finish -- not when the scan
        // arrived (that is recorded as arrivalTime).
        const startedAt = new Date(Math.max(now.getTime(), Date.now()));
        const started = await startService(bookingId, {
          now: startedAt,
          set: { ...(booking.arrivalTime ? {} : set), arrivalTime: booking.arrivalTime || now },
        });
        if (started) {
          // Completion fires at exactly releaseAt (services/queue/serviceTimer.js).
          require("./serviceTimer").scheduleCompletion(started);
          return { outcome: "started", booking: started, releaseAt: releaseAt(started) };
        }
      }

      // The nozzle is in use (or another server started a car in this same
      // instant): the car waits at the pump, keeping its first arrival time.
      const waiting = await Booking.findOneAndUpdate(
        { _id: bookingId, status: "upcoming" },
        { $set: { ...(booking.arrivalTime ? {} : set), arrivalTime: booking.arrivalTime || now } },
        { returnDocument: "after" },
      );
      if (!waiting) return { outcome: "conflict" };
      const holder = busy || (await servingAt(booking.station, booking.fuelType));
      return {
        outcome: booking.arrivalTime ? "already_waiting" : "queued",
        booking: waiting,
        nozzleFreeAt: releaseAt(holder),
      };
    },
    LOCK_OPTS,
  );

  metrics.inc(`nozzle_checkin_${result.outcome}_count`);
  return result;
}

/**
 * One fuel's nozzle at this station has been released: start the vehicle
 * that arrived first today -- a checked-in booking or a walk-in. null when a
 * vehicle is still serving or nobody is waiting.
 *
 * Without `fuelType`, every fuel's nozzle is advanced; the first vehicle
 * started is returned (advanceAllNozzles returns them all).
 *
 * @returns {Promise<object|null>} the started booking document, or the started
 *   walk-in (a plain object with kind "walkin")
 */
async function advanceNozzle(stationId, { now = new Date(), fuelType = null } = {}) {
  if (!fuelType) return (await advanceAllNozzles(stationId, { now }))[0] || null;

  const label = fuelLabel(fuelType);
  const started = await lock.withLock(
    nozzleKey(stationId, fuelType),
    async (guard) => {
      if (await servingAt(stationId, fuelType)) return null;
      const today = dateKey(now);
      const [nextBooking, nextWalkIn] = await Promise.all([
        Booking.findOne({ station: stationId, fuelType: label, status: "upcoming", bookingDate: today, arrivalTime: { $ne: null } })
          .sort({ arrivalTime: 1, _id: 1 })
          .select("_id arrivalTime")
          .lean(),
        WalkIn.findOne({ station: stationId, fuelType: label, status: "waiting", businessDate: today })
          .sort({ arrivalTime: 1, _id: 1 })
          .select("_id arrivalTime")
          .lean(),
      ]);
      if (!nextBooking && !nextWalkIn) return null;
      guard.assertHeld();
      // Started when the nozzle is taken, never before the release that freed it.
      const startedAt = new Date(Math.max(now.getTime(), Date.now()));

      const walkInFirst =
        nextWalkIn && (!nextBooking || new Date(nextWalkIn.arrivalTime) < new Date(nextBooking.arrivalTime));
      if (!walkInFirst) return startService(nextBooking._id, { now: startedAt });

      const walkIn = await WalkIn.findOneAndUpdate(
        { _id: nextWalkIn._id, status: "waiting" },
        { $set: { status: "serving", fuelingStartTime: startedAt } },
        { returnDocument: "after" },
      ).lean();
      return walkIn ? { ...walkIn, kind: "walkin" } : null;
    },
    LOCK_OPTS,
  );
  if (started) {
    metrics.inc(started.kind === "walkin" ? "walkin_started_count" : "nozzle_auto_start_count");
    const timer = require("./serviceTimer");
    if (started.kind === "walkin") timer.scheduleWalkInCompletion(started);
    else timer.scheduleCompletion(started);
  }
  return started;
}

/** Advance every fuel's nozzle at a station; each started vehicle, in fuel order. */
async function advanceAllNozzles(stationId, { now = new Date() } = {}) {
  const started = [];
  for (const fuel of FUEL_KEYS) {
    // eslint-disable-next-line no-await-in-loop -- one lock per fuel, taken in a fixed order
    const s = await advanceNozzle(stationId, { now, fuelType: fuel });
    if (s) started.push(s);
  }
  return started;
}

module.exports = {
  checkIn,
  advanceNozzle,
  advanceAllNozzles,
  startService,
  releaseAt,
  serviceSecondsOf,
  servingAt,
  nozzleKey,
};
