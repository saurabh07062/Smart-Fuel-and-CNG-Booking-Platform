/**
 * Walk-in vehicles at a fuel's app nozzle, recorded by the station's vendor.
 *
 * A walk-in joins its fuel's line the moment it is recorded (arrivalTime) and
 * is started by the same hand-over as a checked-in booking: whoever arrived
 * first gets the nozzle when it is free (services/queue/nozzleService.js
 * advanceNozzle). It completes at its release time (services/queue/serviceTimer.js),
 * or when the vendor marks it done; leaving the line cancels it. Every change
 * refreshes the station's queue, which pushes the new queue and ETAs to
 * customers over Socket.IO (services/queue/stationQueue.js).
 *
 * Walk-ins are queue records only: fuel sold to them is not deducted from the
 * station's booking stock ledger.
 */

const mongoose = require("mongoose");
const WalkIn = require("../../models/WalkIn");
const Station = require("../../models/Station");
const metrics = require("../core/metrics");
const { normaliseFuel, fuelLabel } = require("../../config/fuels");
const { getServiceDurationSeconds } = require("../../config/fuelDurations");
const { QUANTITY_MIN, QUANTITY_MAX } = require("../../config/booking");
const { dateKey } = require("../../config/businessTime");

const ACTIVE_STATUSES = ["waiting", "serving"];

class WalkInError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const serviceTimer = () => require("./serviceTimer");

/**
 * Record a walk-in and, when its fuel's nozzle is free, start it at once.
 * @returns {Promise<object>} the walk-in as stored after the hand-over
 */
async function addWalkIn({ stationId, fuelType, quantity, vehicleNumber = null, createdBy = null, now = new Date() }) {
  const fuel = normaliseFuel(fuelType);
  if (!fuel) throw new WalkInError(400, "fuelType must be Petrol, Diesel or CNG");
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty < QUANTITY_MIN || qty > QUANTITY_MAX) {
    throw new WalkInError(400, `quantity must be between ${QUANTITY_MIN} and ${QUANTITY_MAX}`);
  }
  if (!mongoose.isValidObjectId(stationId)) throw new WalkInError(404, "Station not found");
  const station = await Station.findById(stationId).select("fuelTypes").lean();
  if (!station) throw new WalkInError(404, "Station not found");
  if (!(station.fuelTypes || []).some((f) => normaliseFuel(f) === fuel)) {
    throw new WalkInError(409, `This station does not sell ${fuelLabel(fuel)}`);
  }

  const plate = vehicleNumber ? String(vehicleNumber).trim().toUpperCase().slice(0, 20) : null;
  const walkIn = await WalkIn.create({
    station: stationId,
    fuelType: fuel,
    quantity: qty,
    vehicleNumber: plate || null,
    status: "waiting",
    businessDate: dateKey(now),
    arrivalTime: now,
    serviceDurationSeconds: getServiceDurationSeconds(fuel, qty),
    createdBy,
  });
  metrics.inc("walkin_added_count");

  // Starts it if the nozzle is free, and refreshes the queue either way.
  await serviceTimer().releaseNozzle(stationId, { fuelType: fuel, now });
  return WalkIn.findById(walkIn._id).lean();
}

/**
 * Serving -> completed, once. `due` completions (the timer, the sweep) only
 * complete a fill whose service time has run; the vendor's "done" does not wait.
 * @returns {Promise<object|null>} the completed walk-in, or null if it was not serving
 */
async function completeServing(walkInId, { now = new Date() } = {}) {
  const completed = await WalkIn.findOneAndUpdate(
    { _id: walkInId, status: "serving" },
    { $set: { status: "completed", completionTime: now } },
    { returnDocument: "after" },
  ).lean();
  if (completed) metrics.inc("walkin_completed_count");
  return completed;
}

/**
 * The vendor's actions on a walk-in: "complete" (a serving fill is done) or
 * "cancel" (the vehicle left the line). Either frees the nozzle for the next
 * vehicle and refreshes the queue.
 */
async function updateWalkIn({ stationId, walkInId, action, now = new Date() }) {
  if (!mongoose.isValidObjectId(walkInId)) throw new WalkInError(404, "Walk-in not found");
  const current = await WalkIn.findOne({ _id: walkInId, station: stationId }).lean();
  if (!current) throw new WalkInError(404, "Walk-in not found");

  let updated = null;
  if (action === "complete") {
    if (current.status !== "serving") throw new WalkInError(409, `This walk-in is ${current.status}, not at the nozzle`);
    updated = await completeServing(walkInId, { now });
  } else if (action === "cancel") {
    if (!ACTIVE_STATUSES.includes(current.status)) throw new WalkInError(409, `This walk-in is already ${current.status}`);
    updated = await WalkIn.findOneAndUpdate(
      { _id: walkInId, status: { $in: ACTIVE_STATUSES } },
      { $set: { status: "cancelled", cancelledAt: now } },
      { returnDocument: "after" },
    ).lean();
    if (updated) metrics.inc("walkin_cancelled_count");
  } else {
    throw new WalkInError(400, 'action must be "complete" or "cancel"');
  }
  if (!updated) throw new WalkInError(409, "This walk-in was just changed. Refresh and try again.");

  serviceTimer().clearWalkInTimer(walkInId);
  await serviceTimer().releaseNozzle(stationId, { fuelType: current.fuelType, now });
  return updated;
}

/** Today's waiting and serving walk-ins at a station, in arrival order. */
function listActive(stationId, { now = new Date() } = {}) {
  return WalkIn.find({
    station: stationId,
    status: { $in: ACTIVE_STATUSES },
    $or: [{ status: "serving" }, { businessDate: dateKey(now) }],
  })
    .sort({ arrivalTime: 1, _id: 1 })
    .lean();
}

/** A walk-in still waiting from an earlier day has left: cancel it (the stale sweep). */
async function cancelStaleWaiting({ stationIds = null, now = new Date() } = {}) {
  const scope = stationIds ? { station: { $in: stationIds } } : {};
  const r = await WalkIn.updateMany(
    { ...scope, status: "waiting", businessDate: { $lt: dateKey(now) } },
    { $set: { status: "cancelled", cancelledAt: now } },
  );
  return r.modifiedCount || 0;
}

module.exports = {
  ACTIVE_STATUSES,
  WalkInError,
  addWalkIn,
  completeServing,
  updateWalkIn,
  listActive,
  cancelStaleWaiting,
};
