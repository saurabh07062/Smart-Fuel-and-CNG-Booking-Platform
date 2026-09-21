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
 * second serving walk-in per nozzle (models/WalkIn.js); a booking and a walk-in at once is
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

const Station = require("../../models/Station");
const nozzleSetup = require("../../config/nozzleModes");

const LOCK_OPTS = { ttlMs: 10_000, maxWaitMs: 3_000 };

/**
 * How this fuel's nozzles are split (config/nozzleModes.js): `resources` app
 * nozzles for bookings (at least 1 here, so a vehicle already checked in is
 * always served); `separate` when walk-ins have their own `lanes` nozzles.
 */
async function laneSetup(stationId, fuelType) {
  const station = await Station.findById(stationId).select("nozzleConfig").lean();
  const lanes = nozzleSetup.offlineNozzles(station, fuelType);
  return { separate: lanes >= 1, lanes, resources: Math.max(1, nozzleSetup.onlineResources(station, fuelType)) };
}

/** The lock for one fuel's walk-in nozzles at one station. */
const walkInLanesKey = (stationId, fuelType) => `lock:walkin-lanes:${stationId}:${normaliseFuel(fuelType) || "unknown"}`;

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

/**
 * The vehicles at this fuel's app nozzles now, by nozzle number: bookings
 * being served and walk-ins sharing an app nozzle. A vehicle from before
 * nozzles were numbered counts as nozzle 1.
 * @returns {Promise<{resources:number, byResource:Map<number,object>}>}
 */
async function appNozzleUse(stationId, fuelType) {
  const label = fuelLabel(fuelType);
  const { separate, resources } = await laneSetup(stationId, fuelType);
  const [bookings, walkIns] = await Promise.all([
    Booking.find({ station: stationId, fuelType: label, status: "serving" })
      .select("_id fuelType quantity serviceDurationSeconds fuelingStartTime resource")
      .lean(),
    // With walk-in nozzles, only a walk-in still on an app nozzle (lane 0)
    // occupies one; otherwise walk-ins share the app nozzles.
    WalkIn.find({
      station: stationId,
      fuelType: label,
      status: "serving",
      ...(separate ? { lane: { $in: [0, null] } } : {}),
    })
      .select("_id fuelType quantity serviceDurationSeconds fuelingStartTime resource lane")
      .lean(),
  ]);
  const byResource = new Map();
  for (const b of bookings) byResource.set(Number(b.resource) || 1, b);
  for (const w of walkIns) {
    if (separate || !(w.lane >= 1)) byResource.set(Number(w.resource) || 1, { ...w, kind: "walkin" });
  }
  return { resources, byResource };
}

/** The lowest-numbered free app nozzle for this fuel, or null when all are in use. */
async function freeAppNozzle(stationId, fuelType) {
  const { resources, byResource } = await appNozzleUse(stationId, fuelType);
  for (let r = 1; r <= resources; r++) if (!byResource.has(r)) return r;
  return null;
}

/**
 * null when an app nozzle for this fuel is free; otherwise the vehicle whose
 * fill ends first (when the next nozzle frees).
 */
async function servingAt(stationId, fuelType) {
  const { resources, byResource } = await appNozzleUse(stationId, fuelType);
  if (byResource.size < resources) return null;
  let first = null;
  for (const v of byResource.values()) {
    if (!first || (releaseAt(v)?.getTime() ?? Infinity) < (releaseAt(first)?.getTime() ?? Infinity)) first = v;
  }
  return first;
}

/**
 * Upcoming -> serving, stamped now. null when the booking is no longer
 * upcoming or its fuel's nozzle already has a car serving (the unique index
 * turns that race into a refusal, via bookingTransitions).
 */
async function startService(bookingId, { now = new Date(), set = {}, resource = null } = {}) {
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
      // The nozzle it is actually served at (any free app nozzle of its fuel).
      ...(resource ? { resource } : {}),
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
        const resource = await freeAppNozzle(booking.station, booking.fuelType);
        // Fueling starts when the nozzle is actually taken -- inside the lock,
        // which may have waited for a car ahead to finish -- not when the scan
        // arrived (that is recorded as arrivalTime).
        const startedAt = new Date(Math.max(now.getTime(), Date.now()));
        const started = await startService(bookingId, {
          now: startedAt,
          resource,
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
 * App nozzles of one fuel at this station have been released: start the
 * vehicles that arrived first today -- checked-in bookings or walk-ins sharing
 * the app nozzles -- one per free nozzle. [] when none is free or nobody waits.
 *
 * @returns {Promise<object[]>} started booking documents and walk-ins (kind "walkin")
 */
async function advanceAppNozzles(stationId, { now = new Date(), fuelType }) {
  const label = fuelLabel(fuelType);
  const started = await lock.withLock(
    nozzleKey(stationId, fuelType),
    async (guard) => {
      const out = [];
      const today = dateKey(now);
      // Walk-ins with their own nozzles never take an app nozzle.
      const { separate } = await laneSetup(stationId, fuelType);
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- one nozzle at a time, in order
        const resource = await freeAppNozzle(stationId, fuelType);
        if (!resource) break;
        // eslint-disable-next-line no-await-in-loop
        const [nextBooking, nextWalkIn] = await Promise.all([
          Booking.findOne({ station: stationId, fuelType: label, status: "upcoming", bookingDate: today, arrivalTime: { $ne: null } })
            .sort({ arrivalTime: 1, _id: 1 })
            .select("_id arrivalTime")
            .lean(),
          separate
            ? null
            : WalkIn.findOne({ station: stationId, fuelType: label, status: "waiting", businessDate: today })
                .sort({ arrivalTime: 1, _id: 1 })
                .select("_id arrivalTime")
                .lean(),
        ]);
        if (!nextBooking && !nextWalkIn) break;
        guard.assertHeld();
        // Started when the nozzle is taken, never before the release that freed it.
        const startedAt = new Date(Math.max(now.getTime(), Date.now()));

        const walkInFirst =
          nextWalkIn && (!nextBooking || new Date(nextWalkIn.arrivalTime) < new Date(nextBooking.arrivalTime));
        let s;
        if (!walkInFirst) {
          // eslint-disable-next-line no-await-in-loop
          s = await startService(nextBooking._id, { now: startedAt, resource });
        } else {
          // eslint-disable-next-line no-await-in-loop
          const w = await WalkIn.findOneAndUpdate(
            { _id: nextWalkIn._id, status: "waiting" },
            { $set: { status: "serving", fuelingStartTime: startedAt, lane: 0, resource } },
            { returnDocument: "after" },
          ).lean();
          s = w ? { ...w, kind: "walkin" } : null;
        }
        if (!s) break; // raced by another server: it will hand the nozzle over
        out.push(s);
      }
      return out;
    },
    LOCK_OPTS,
  );
  if (started.length) {
    const timer = require("./serviceTimer");
    for (const s of started) {
      metrics.inc(s.kind === "walkin" ? "walkin_started_count" : "nozzle_auto_start_count");
      if (s.kind === "walkin") timer.scheduleWalkInCompletion(s);
      else timer.scheduleCompletion(s);
    }
  }
  return started;
}

/**
 * One fuel's app nozzles at this station: start what can start; the first
 * vehicle started, or null. Without `fuelType`, every fuel.
 */
async function advanceNozzle(stationId, { now = new Date(), fuelType = null } = {}) {
  if (!fuelType) return (await advanceAllNozzles(stationId, { now }))[0] || null;
  return (await advanceAppNozzles(stationId, { now, fuelType }))[0] || null;
}

/** Advance every fuel's nozzle at a station; each started vehicle, in fuel order. */
async function advanceAllNozzles(stationId, { now = new Date() } = {}) {
  const started = [];
  for (const fuel of FUEL_KEYS) {
    // eslint-disable-next-line no-await-in-loop -- one lock per fuel, taken in a fixed order
    started.push(...(await advanceAppNozzles(stationId, { now, fuelType: fuel })));
    // eslint-disable-next-line no-await-in-loop
    started.push(...(await advanceWalkInLanes(stationId, { now, fuelType: fuel })));
  }
  return started;
}

/**
 * Walk-ins at a fuel's own walk-in nozzles (config/nozzleModes.js): start the
 * earliest waiting walk-ins on every free nozzle, several at once. Nothing
 * when walk-ins share the app nozzle (advanceNozzle handles them there).
 * @returns {Promise<object[]>} the walk-ins started (kind "walkin")
 */
async function advanceWalkInLanes(stationId, { now = new Date(), fuelType } = {}) {
  const { separate, lanes } = await laneSetup(stationId, fuelType);
  if (!separate) return [];
  await WalkIn.ensureLaneIndexes();
  const label = fuelLabel(fuelType);
  const started = await lock.withLock(
    walkInLanesKey(stationId, fuelType),
    async (guard) => {
      const busy = await WalkIn.find({ station: stationId, fuelType: label, status: "serving", lane: { $gte: 1 } })
        .select("lane")
        .lean();
      const taken = new Set(busy.map((w) => w.lane));
      const free = [];
      for (let lane = 1; lane <= lanes; lane++) if (!taken.has(lane)) free.push(lane);
      if (!free.length) return [];
      const waiting = await WalkIn.find({ station: stationId, fuelType: label, status: "waiting", businessDate: dateKey(now) })
        .sort({ arrivalTime: 1, _id: 1 })
        .limit(free.length)
        .select("_id")
        .lean();
      guard.assertHeld();
      const startedAt = new Date(Math.max(now.getTime(), Date.now()));
      const out = [];
      for (let i = 0; i < waiting.length; i++) {
        // eslint-disable-next-line no-await-in-loop -- one nozzle each, in arrival order
        const w = await WalkIn.findOneAndUpdate(
          { _id: waiting[i]._id, status: "waiting" },
          { $set: { status: "serving", fuelingStartTime: startedAt, lane: free[i] } },
          { returnDocument: "after" },
        ).lean();
        if (w) out.push({ ...w, kind: "walkin" });
      }
      return out;
    },
    LOCK_OPTS,
  );
  if (started.length) {
    metrics.inc("walkin_started_count", started.length);
    const timer = require("./serviceTimer");
    started.forEach((w) => timer.scheduleWalkInCompletion(w));
  }
  return started;
}

module.exports = {
  checkIn,
  advanceNozzle,
  advanceAppNozzles,
  appNozzleUse,
  freeAppNozzle,
  advanceAllNozzles,
  advanceWalkInLanes,
  laneSetup,
  startService,
  releaseAt,
  serviceSecondsOf,
  servingAt,
  nozzleKey,
};
