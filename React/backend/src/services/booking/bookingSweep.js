/**
 * Closes bookings nobody ever showed up for, or that time has simply passed,
 * so their capacity and inventory hold stop counting against a station that
 * has, in reality, moved on.
 *
 * Two rules, both conservative on purpose -- a false "no_show" hurts a real
 * customer, a late one just means a slot frees up a little slower:
 *
 *   - a booking dated before today, still 'upcoming' or 'waitlisted' ->
 *     'expired' (the day is over; there is nothing left to attend)
 *   - a booking dated today whose slot has ended (plus NO_SHOW_GRACE_MINUTES,
 *     default 0) without the customer checking in, still 'upcoming' ->
 *     'no_show' -- cancelled automatically, then the next waitlisted customer (if
 *     any) is promoted into the newly-freed capacity, same as a cancellation
 *
 * "Today" and slot times are India time (config/businessTime.js).
 */

const Booking = require("../../models/Booking");
const realtime = require("../notification/realtime");
const { dateKey } = require("../../config/businessTime");
const { slotEndInstant, isSlotElapsed } = require("../../config/booking");
const lock = require("../core/lock");

/**
 * Minutes after a slot ends before a customer who never checked in is
 * cancelled as a no-show. 0: the moment the slot is over. Read per run.
 */
function noShowGraceMinutes() {
  const v = Number(process.env.NO_SHOW_GRACE_MINUTES);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * End time of a slot, in India time -- the same rule booking uses to decide a
 * slot has passed (config/booking.js), so a booking is never marked a no-show
 * while its slot is still open for booking. null (never throws) for a shape
 * it doesn't recognise, so one malformed row can't crash the sweep; the
 * date-based rule picks it up once the day passes.
 */
function parseSlotEndDateTime(bookingDate, timeSlot) {
  return slotEndInstant(bookingDate, timeSlot);
}

/**
 * Tell each customer, their station's vendor and admins about bookings the
 * sweep just closed (a bulk update emits nothing on its own). Only rows now
 * in `status` are announced, so one someone else changed first is left out.
 */
async function announceClosed(ids, status) {
  if (!ids.length) return;
  try {
    const Station = require("../../models/Station");
    const rows = await Booking.find({ _id: { $in: ids }, status }).lean();
    const stationIds = [...new Set(rows.map((b) => String(b.station)))];
    const owners = new Map(
      (await Station.find({ _id: { $in: stationIds } }).select("owner").lean()).map((s) => [String(s._id), s.owner]),
    );
    for (const b of rows) {
      realtime.bookingChanged(realtime.EVENTS.BOOKING_UPDATED, b, { stationOwner: owners.get(String(b.station)) });
    }
  } catch (err) {
    console.error(`[bookingSweep] announcing ${status} bookings failed:`, err.message);
  }
}

/**
 * Run both rules once.
 * @param {object} io  optional Socket.io server, so a freed no-show slot
 *   can promote a waitlisted customer and broadcast the update immediately.
 * @param {object} [opts]
 * @param {Array} [opts.stationIds]  limit the sweep to these stations. The
 *   background job passes none (every station); tests pass only their own
 *   fixtures so a test run can never change real bookings or stock.
 */
async function sweepStaleBookings(io, { stationIds = null } = {}) {
  const today = dateKey();
  const scope = stationIds ? { station: { $in: stationIds } } : {};

  const expired = await Booking.updateMany(
    { ...scope, status: { $in: ["upcoming", "waitlisted"] }, bookingDate: { $lt: today } },
    { $set: { status: "expired" } },
  );

  // Same-day no-shows: Mongo can't evaluate the timeSlot string format
  // inside a query, so fetch today's candidates and check each one in code.
  const cutoff = new Date(Date.now() - noShowGraceMinutes() * 60_000);
  // A car checked in and waiting at the pump (arrivalTime set) is not a no-show.
  const candidates = await Booking.find({
    ...scope,
    status: "upcoming",
    bookingDate: today,
    arrivalTime: null,
  }).select("_id timeSlot station");

  const staleIds = [];
  const affectedStations = new Set();
  for (const b of candidates) {
    const end = parseSlotEndDateTime(today, b.timeSlot);
    if (end && end <= cutoff) {
      staleIds.push(b._id);
      affectedStations.add(String(b.station));
    }
  }

  let noShowCount = 0;
  if (staleIds.length > 0) {
    // Status re-checked in the write: a booking the vendor started serving
    // (or the customer cancelled) since the read above is left alone.
    const result = await Booking.updateMany(
      { _id: { $in: staleIds }, status: "upcoming", arrivalTime: null },
      { $set: { status: "no_show" } },
    );
    noShowCount = result.modifiedCount || 0;
    await announceClosed(staleIds, "no_show");

    // A no-show frees capacity exactly like a cancellation does -- let the
    // next waitlisted customer (if any) take the slot.
    const bookingService = require("./booking");
    for (const stationId of affectedStations) {
      try {
        await bookingService.promoteFromWaitlist(stationId, io);
        await bookingService.recalculateQueue(stationId, io);
      } catch (err) {
        console.error(`[bookingSweep] promotion failed for station ${stationId}:`, err.message);
      }
    }
  }

  // Waitlisted today for a slot that has now passed: the nozzle never freed
  // in time, so there is nothing left to wait for. (No stock was reserved.)
  const waitingToday = await Booking.find({ ...scope, status: "waitlisted", bookingDate: today })
    .select("_id timeSlot")
    .lean();
  const lapsed = waitingToday.filter((b) => isSlotElapsed(today, b.timeSlot)).map((b) => b._id);
  let waitlistExpired = 0;
  if (lapsed.length > 0) {
    const r = await Booking.updateMany({ _id: { $in: lapsed }, status: "waitlisted" }, { $set: { status: "expired" } });
    waitlistExpired = r.modifiedCount || 0;
    await announceClosed(lapsed, "expired");
  }

  // Every station someone is still waiting at: a window freed by a vendor or
  // admin change (which do not promote on their own path) is filled here.
  const waitingStations = await Booking.distinct("station", { ...scope, status: "waitlisted" });
  let waitlistPromoted = 0;
  if (waitingStations.length > 0) {
    const bookingService = require("./booking");
    for (const stationId of waitingStations) {
      if (affectedStations.has(String(stationId))) continue; // already tried above
      try {
        if (await bookingService.promoteFromWaitlist(stationId, io)) {
          waitlistPromoted += 1;
          await bookingService.recalculateQueue(stationId, io);
        }
      } catch (err) {
        console.error(`[bookingSweep] waitlist promotion failed for station ${stationId}:`, err.message);
      }
    }
  }

  // A walk-in still waiting from an earlier day has left the line.
  await require("../queue/walkIns").cancelStaleWaiting({ stationIds });

  // Expired and no-show reservations give their stock back; then check each
  // station's committed stock against its live bookings.
  const stockSvc = require("../inventory/stockLedger");
  const released = await stockSvc.releaseStaleReservations(scope);
  const commitments = await stockSvc.reconcileCommitments({ apply: true, stationIds });

  return {
    expired: expired.modifiedCount || 0,
    noShow: noShowCount,
    waitlistExpired,
    waitlistPromoted,
    stockReleased: released,
    commitmentDrift: commitments.drift.length,
    commitmentRepaired: commitments.repaired,
  };
}

/** A car waiting this long at a free nozzle, with no completion just before, was missed by a hand-over. */
const HAND_OVER_GRACE_MS = 10_000;

/**
 * The safety net behind services/queue/serviceTimer.js, which completes each fill at
 * its exact release time. Every few seconds, whether or not a timer exists
 * (another server started it, a restart lost it):
 *
 *   - a serving booking or walk-in past its release time is completed and its
 *     fuel's nozzle handed to the next vehicle waiting at it
 *   - one not yet due has its timer re-armed -- never completed early
 *   - a free nozzle with a vehicle waiting at it for longer than the grace
 *     period (a crash between a completion and the hand-over) is handed over,
 *     each fuel's nozzle on its own
 *
 * Completion goes through services/booking/bookingCompletion.js (status, stock,
 * payment, exactly once) and hand-over through the nozzle lock, so this sweep
 * racing a timer, a vendor or another server never completes twice or starts
 * two cars. The release time comes from the stored fuelingStartTime -- not the
 * frontend countdown.
 *
 * @param {object} [opts]
 * @param {Array} [opts.stationIds]  limit to these stations (tests)
 */
async function sweepInProgressBookings(io, { stationIds = null, now = new Date(), handOverGraceMs = HAND_OVER_GRACE_MS } = {}) {
  const serviceTimer = require("../queue/serviceTimer");
  const { releaseAt } = require("../queue/nozzleService");
  const scope = stationIds ? { station: { $in: stationIds } } : {};

  const candidates = await Booking.find({ ...scope, status: "serving", fuelingStartTime: { $ne: null } })
    .select("_id station status fuelType fuelingStartTime serviceDurationSeconds")
    .lean();

  let completed = 0;
  let started = 0;
  for (const b of candidates) {
    const dueAt = releaseAt(b);
    if (!dueAt || now < dueAt) {
      serviceTimer.scheduleCompletion(b); // a no-op when this process already has the timer
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- each completion is its own conditional update
    const result = await serviceTimer.completeAndRelease(b._id, { now });
    if (result.completed) completed += 1;
    if (result.started) started += 1;
  }

  const WalkIn = require("../../models/WalkIn");
  const servingWalkIns = await WalkIn.find({ ...scope, status: "serving", fuelingStartTime: { $ne: null } }).lean();
  for (const w of servingWalkIns) {
    const dueAt = releaseAt(w);
    if (!dueAt || now < dueAt) {
      serviceTimer.scheduleWalkInCompletion(w);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await serviceTimer.completeWalkInAndRelease(w._id, { now });
    if (result.completed) completed += 1;
    if (result.started) started += 1;
  }

  // Each fuel's nozzle separately: a vehicle waiting at the Petrol nozzle is
  // not held up by a car at the CNG one.
  const cutoff = new Date(now.getTime() - handOverGraceMs);
  const today = dateKey(now);
  const [waitingBookings, waitingWalkIns] = await Promise.all([
    Booking.find({ ...scope, status: "upcoming", bookingDate: today, arrivalTime: { $lte: cutoff } })
      .select("station fuelType")
      .lean(),
    WalkIn.find({ ...scope, status: "waiting", businessDate: today, arrivalTime: { $lte: cutoff } })
      .select("station fuelType")
      .lean(),
  ]);
  const nozzles = new Map();
  for (const r of [...waitingBookings, ...waitingWalkIns]) nozzles.set(`${r.station}:${r.fuelType}`, r);
  for (const { station: stationId, fuelType } of nozzles.values()) {
    const busy =
      (await Booking.exists({ station: stationId, fuelType, status: "serving" })) ||
      (await WalkIn.exists({ station: stationId, fuelType, status: "serving" }));
    if (busy) continue;
    // A completion a moment ago means its hand-over is still on the way.
    const justFinished =
      (await Booking.exists({ station: stationId, fuelType, status: "completed", completionTime: { $gt: cutoff } })) ||
      (await WalkIn.exists({ station: stationId, fuelType, status: "completed", completionTime: { $gt: cutoff } }));
    if (justFinished) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await serviceTimer.releaseNozzle(stationId, { now, fuelType })) started += 1;
  }

  return { completed, started };
}

/** Start the recurring sweep. Returns the interval handle so callers can stop it. */
function startBookingSweepJob({ intervalMs = 10 * 60_000, getIo } = {}) {
  const run = () => {
    const io = typeof getIo === "function" ? getIo() : undefined;
    // Once per interval across all server instances (services/core/lock.js).
    lock
      .runExclusive("bookingSweep", Math.max(1_000, intervalMs - 1_000), () => sweepStaleBookings(io))
      .then(({ ran, result }) => {
        if (ran && (result.expired > 0 || result.noShow > 0)) {
          console.log(`[bookingSweep] expired ${result.expired}, no-show ${result.noShow}`);
        }
      })
      .catch((err) => console.error("[bookingSweep] job failed:", err.message));
  };

  run();
  const handle = setInterval(run, intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}

/**
 * Start the fast-cadence auto-completion sweep. A 5-minute (or 40-second, for
 * Petrol/Diesel) service duration needs checking often enough that
 * "completed" lands close to when the countdown reaches zero.
 */
function startInProgressSweepJob({ intervalMs = 5_000, getIo } = {}) {
  const run = () => {
    const io = typeof getIo === "function" ? getIo() : undefined;
    lock
      .runExclusive("inProgressSweep", Math.max(1_000, intervalMs - 1_000), () => sweepInProgressBookings(io))
      .then(({ ran, result }) => {
        if (ran && (result.completed > 0 || result.started > 0)) {
          console.log(`[bookingSweep] safety net: completed ${result.completed}, handed over ${result.started}`);
        }
      })
      .catch((err) => console.error("[bookingSweep] in-progress job failed:", err.message));
  };

  run();
  const handle = setInterval(run, intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}

module.exports = {
  sweepStaleBookings,
  sweepInProgressBookings,
  parseSlotEndDateTime,
  startBookingSweepJob,
  startInProgressSweepJob,
};
