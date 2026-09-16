/**
 * Automatic completion at the exact moment a fill's service time ends, and
 * handing the released nozzle to the next vehicle waiting at it.
 *
 *   service starts (services/queue/nozzleService.js) -> scheduleCompletion(booking)
 *                                                      scheduleWalkInCompletion(walkIn)
 *   release time reached                       -> completeAndRelease(bookingId)
 *                                                  completeWalkInAndRelease(walkInId)
 *       1. completes the booking once (services/booking/bookingCompletion.js:
 *          status, stock, payment) or the walk-in once
 *       2. releases that fuel's nozzle: the earliest arrived vehicle starts
 *          (services/queue/nozzleService.js advanceNozzle), with its own timer
 *       3. refreshes the queue, slots and ETAs (services/queue/stationQueue.js)
 *       4. tells the customer, the station's vendor and admins over Socket.IO
 *
 * The release time is always computed from the stored fuelingStartTime and
 * serviceDurationSeconds, never from when a timer was created. So the timers
 * here -- one per booking or walk-in, a repeat schedule is ignored -- only
 * make completion punctual: recoverServiceTimers() rebuilds them after a
 * restart (an overdue fill completes at once), and the in-progress sweep
 * (services/booking/bookingSweep.js) completes anything overdue every few seconds.
 * Completion and hand-over are conditional writes under the nozzle lock, so a
 * timer, the sweep and a second server racing each other still complete a
 * booking once and start one next vehicle.
 */

const Booking = require("../../models/Booking");
const Station = require("../../models/Station");
const WalkIn = require("../../models/WalkIn");
const realtime = require("../notification/realtime");
const notifications = require("../notification/notifications");
const metrics = require("../core/metrics");
const nozzleService = require("./nozzleService");
const { completeBooking } = require("../booking/bookingCompletion");
const { dateKey } = require("../../config/businessTime");

/** timer key ("<bookingId>" or "walkin:<id>") -> { timeout, dueAt (ms) } */
const timers = new Map();

function arm(key, dueAt, onDue) {
  const existing = timers.get(key);
  if (existing && existing.dueAt === dueAt.getTime()) return false;
  if (existing) clearTimeout(existing.timeout);

  const timeout = setTimeout(() => {
    timers.delete(key);
    onDue().catch((err) => {
      metrics.inc("service_timer_error_count");
      console.error(`[serviceTimer] completing ${key} failed:`, err.message);
    });
  }, Math.max(0, dueAt.getTime() - Date.now()));
  if (typeof timeout.unref === "function") timeout.unref();

  timers.set(key, { timeout, dueAt: dueAt.getTime() });
  metrics.inc("service_timer_scheduled_count");
  return true;
}

/**
 * Arm the completion timer for a serving booking. Ignored when that booking
 * already has a timer for the same release time.
 * @returns {boolean} true when a timer was (re)armed
 */
function scheduleCompletion(booking) {
  if (!booking || booking.status !== "serving") return false;
  const dueAt = nozzleService.releaseAt(booking);
  if (!dueAt) return false;
  const id = String(booking._id);
  return arm(id, dueAt, () => completeAndRelease(id));
}

/** The same for a walk-in at the nozzle. */
function scheduleWalkInCompletion(walkIn) {
  if (!walkIn || walkIn.status !== "serving") return false;
  const dueAt = nozzleService.releaseAt(walkIn);
  if (!dueAt) return false;
  const id = String(walkIn._id);
  return arm(`walkin:${id}`, dueAt, () => completeWalkInAndRelease(id));
}

function clearWalkInTimer(walkInId) {
  const key = `walkin:${walkInId}`;
  const existing = timers.get(key);
  if (existing) clearTimeout(existing.timeout);
  timers.delete(key);
}

async function ownerOf(stationId) {
  const station = stationId ? await Station.findById(stationId).select("owner").lean() : null;
  return station && station.owner;
}

async function announceCompleted(booking) {
  try {
    realtime.bookingChanged(realtime.EVENTS.BOOKING_COMPLETED, booking, { stationOwner: await ownerOf(booking.station) });
    // Durable, so a customer who closed the tab still learns the fill finished.
    await notifications.notify({
      user: booking.user,
      type: "booking_completed",
      title: "Fuelling complete",
      body: `Your ${booking.fuelType || "fuel"} booking is complete.`,
      link: "booking",
      booking: booking._id,
      station: booking.station,
      dedupeKey: `booking:${booking._id}:completed`,
    });
  } catch (err) {
    console.error(`[serviceTimer] announcing completion of ${booking._id} failed:`, err.message);
  }
}

async function announceStarted(booking) {
  // A walk-in has no customer to tell; the queue refresh tells everyone else.
  if (booking.kind === "walkin") return;
  try {
    realtime.bookingChanged(realtime.EVENTS.BOOKING_UPDATED, booking, { stationOwner: await ownerOf(booking.station) });
  } catch (err) {
    console.error(`[serviceTimer] announcing start of ${booking._id} failed:`, err.message);
  }
}

async function refreshQueue(stationId) {
  try {
    await require("./stationQueue").refreshStationQueue(stationId);
  } catch (err) {
    console.error(`[serviceTimer] queue refresh failed for station ${stationId}:`, err.message);
  }
}

/**
 * A nozzle at this station may be free: start the next vehicle waiting at it
 * (if any), announce it and refresh the queue. With `fuelType`, only that
 * fuel's nozzle; without, every fuel's. Safe to call at any time -- nothing
 * starts while a vehicle is serving on that nozzle.
 *
 * @returns {Promise<object|null>} the first vehicle started, or null
 */
async function releaseNozzle(stationId, { now = new Date(), refresh = true, fuelType = null } = {}) {
  if (!stationId) return null;
  let started = [];
  try {
    started = fuelType
      ? [await nozzleService.advanceNozzle(stationId, { now, fuelType })].filter(Boolean) // arms its own timer
      : await nozzleService.advanceAllNozzles(stationId, { now });
  } catch (err) {
    metrics.inc("nozzle_advance_error_count");
    console.error(`[serviceTimer] hand-over failed at station ${stationId}:`, err.message);
  }
  for (const s of started) await announceStarted(s);
  if (refresh) await refreshQueue(stationId);
  return started[0] || null;
}

/**
 * Complete a serving booking whose service time has run out, then release its
 * fuel's nozzle. A booking not yet due is re-armed instead (never completed
 * early); one already finished elsewhere only has its nozzle released.
 *
 * @returns {Promise<{completed:object|null, started:object|null, notDue?:boolean}>}
 */
async function completeAndRelease(bookingId, { now = new Date() } = {}) {
  const current = await Booking.findById(bookingId)
    .select("_id station status fuelType quantity fuelingStartTime serviceDurationSeconds")
    .lean();
  if (!current) return { completed: null, started: null };

  if (current.status !== "serving") {
    return { completed: null, started: await releaseNozzle(current.station, { now, fuelType: current.fuelType }) };
  }

  const dueAt = nozzleService.releaseAt(current);
  if (!dueAt || dueAt > now) {
    scheduleCompletion(current);
    return { completed: null, started: null, notDue: true };
  }

  // Finishing the fill is not receiving the money: a pay-at-the-pump booking
  // stays owed until its payment is recorded (check-in scan or "Collect payment").
  const completed = await completeBooking({ bookingId, fromStatuses: ["serving"] });
  if (completed) {
    metrics.inc("service_auto_completed_count");
    await announceCompleted(completed);
  }
  // The next car starts after this one's completion was written -- never at
  // the `now` captured before it, which would overlap the two fills on record.
  const releasedAt = new Date(Math.max(Date.now(), completed?.completionTime ? new Date(completed.completionTime).getTime() : 0));
  const started = await releaseNozzle(current.station, { now: releasedAt, refresh: false, fuelType: current.fuelType });
  await refreshQueue(current.station);
  return { completed, started };
}

/** completeAndRelease for a walk-in at the nozzle. */
async function completeWalkInAndRelease(walkInId, { now = new Date() } = {}) {
  const current = await WalkIn.findById(walkInId).lean();
  if (!current) return { completed: null, started: null };

  if (current.status !== "serving") {
    return { completed: null, started: await releaseNozzle(current.station, { now, fuelType: current.fuelType }) };
  }
  const dueAt = nozzleService.releaseAt(current);
  if (!dueAt || dueAt > now) {
    scheduleWalkInCompletion(current);
    return { completed: null, started: null, notDue: true };
  }

  const completed = await require("./walkIns").completeServing(walkInId, { now: new Date(Math.max(Date.now(), dueAt.getTime())) });
  const releasedAt = new Date(Math.max(Date.now(), completed?.completionTime ? new Date(completed.completionTime).getTime() : 0));
  const started = await releaseNozzle(current.station, { now: releasedAt, refresh: false, fuelType: current.fuelType });
  await refreshQueue(current.station);
  return { completed, started };
}

/**
 * After a restart: re-arm every fill in progress from its stored start time
 * (an overdue one completes immediately), and hand any free nozzle to a
 * vehicle left waiting at it today.
 *
 * @param {object} [opts]
 * @param {Array} [opts.stationIds]  limit to these stations (tests)
 */
async function recoverServiceTimers({ stationIds = null, now = new Date() } = {}) {
  const scope = stationIds ? { station: { $in: stationIds } } : {};
  const [serving, servingWalkIns] = await Promise.all([
    Booking.find({ ...scope, status: "serving" })
      .select("_id station status fuelType quantity fuelingStartTime serviceDurationSeconds")
      .lean(),
    WalkIn.find({ ...scope, status: "serving" }).lean(),
  ]);

  let scheduled = 0;
  let overdue = 0;
  let missingStart = 0;
  for (const b of serving) {
    const dueAt = nozzleService.releaseAt(b);
    if (!dueAt) {
      missingStart += 1;
      continue;
    }
    if (dueAt <= now) overdue += 1;
    if (scheduleCompletion(b)) scheduled += 1;
  }
  for (const w of servingWalkIns) scheduleWalkInCompletion(w);

  const today = dateKey(now);
  const waitingAt = new Set(
    [
      ...(await Booking.distinct("station", { ...scope, status: "upcoming", bookingDate: today, arrivalTime: { $ne: null } })),
      ...(await WalkIn.distinct("station", { ...scope, status: "waiting", businessDate: today })),
    ].map(String),
  );
  let started = 0;
  for (const stationId of waitingAt) {
    if (await releaseNozzle(stationId, { now })) started += 1;
  }

  if (missingStart) console.warn(`[serviceTimer] ${missingStart} serving booking(s) have no fuelingStartTime and cannot be timed`);
  return { serving: serving.length, scheduled, overdue, started, missingStart, walkInsServing: servingWalkIns.length };
}

/** Test helpers: pending timers, and clearing them (what a restart does). */
function pendingTimers() {
  return timers.size;
}
function clearAllTimers() {
  for (const { timeout } of timers.values()) clearTimeout(timeout);
  timers.clear();
}

module.exports = {
  scheduleCompletion,
  scheduleWalkInCompletion,
  clearWalkInTimer,
  completeAndRelease,
  completeWalkInAndRelease,
  releaseNozzle,
  recoverServiceTimers,
  pendingTimers,
  clearAllTimers,
};
