/**
 * Smart Queue-Aware Station Recommender ("Is It Worth It?" Engine)
 *
 * Evaluates whether redirecting a customer from a crowded station/slot (Station A)
 * to an alternative station (Station B) produces genuine net benefits in time,
 * distance, and queue wait.
 *
 * Decision Model:
 *   TotalTime(S) = TravelTime(User -> S) + WaitTime(S, Slot) + ServiceTime(S)
 *   NetTimeSaved = TotalTime(Station A) - TotalTime(Station B)
 *
 * Worth-It Thresholds:
 *   1. NetTimeSaved >= minTimeSavedMinutes (default: 7 mins)
 *   2. ExtraDetourDistance <= maxDetourKm (default: 8 km)
 *   3. Station B has available slot capacity and sufficient fuel inventory
 */

const Station = require("../../models/Station");
const geo = require("../algorithms/geo");
const discovery = require("./discovery");
const stationQueue = require("../queue/stationQueue");
const { getServiceDurationSeconds } = require("../../config/fuelDurations");
const nozzleScheduler = require("../queue/nozzleScheduler");
const { atBusinessTime, dateKey } = require("../../config/businessTime");

const DEFAULT_AVG_SPEED_KMH = 30; // Urban driving speed (~2 min per km)
const ROAD_CURVATURE_FACTOR = 1.25; // Ratio of road distance to straight-line distance
const DEFAULT_MIN_TIME_SAVED_MINUTES = 7;
const DEFAULT_MAX_DETOUR_KM = 8;
const HIGH_QUEUE_THRESHOLD_MINUTES = 10;

/**
 * Calculates estimated travel duration in minutes from origin to station.
 *
 * @param {number} distanceKm - Straight-line or road distance in km
 * @param {number} speedKmh - Estimated average speed in km/h
 * @returns {number} Drive duration in minutes
 */
function estimateDriveTimeMinutes(distanceKm, speedKmh = DEFAULT_AVG_SPEED_KMH) {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 0;
  const effectiveRoadKm = distanceKm * ROAD_CURVATURE_FACTOR;
  const speed = Math.max(5, speedKmh);
  return (effectiveRoadKm / speed) * 60;
}

/**
 * Computes Total Trip Time = Drive Time + Expected Queue Wait + Service Time.
 *
 * @param {object} params
 * @param {number} params.distanceKm
 * @param {number} params.waitMinutes
 * @param {number} params.avgServiceMinutes
 * @param {number} params.speedKmh
 * @returns {number} Total minutes
 */
function calculateTotalTripTime({
  distanceKm = 0,
  waitMinutes = 0,
  avgServiceMinutes = 4,
  speedKmh = DEFAULT_AVG_SPEED_KMH,
}) {
  const drive = estimateDriveTimeMinutes(distanceKm, speedKmh);
  const wait = Math.max(0, Number(waitMinutes) || 0);
  const service = Number(avgServiceMinutes) > 0 ? Number(avgServiceMinutes) : 4;
  return round1(drive + wait + service);
}

/**
 * Evaluates candidate Station B against target Station A to determine if
 * recommending Station B is "worth it".
 *
 * @param {object} params
 * @param {object} params.targetStation - Details of original Station A
 * @param {object} params.candidateStation - Details of candidate Station B
 * @param {object} params.origin - {lat, lng} of customer
 * @param {string} params.fuelType - 'petrol' | 'diesel' | 'cng'
 * @param {number} params.requestedQty - Litres/kg requested
 * @param {number} params.minTimeSavedMinutes - Min time threshold (default: 7)
 * @param {number} params.maxDetourKm - Max allowed distance to candidate (default: 8)
 * @returns {object} Comparison outcome with `isWorthIt` boolean
 */
function compareStationWorth({
  targetStation,
  candidateStation,
  origin,
  fuelType,
  requestedQty = 10,
  minTimeSavedMinutes = DEFAULT_MIN_TIME_SAVED_MINUTES,
  maxDetourKm = DEFAULT_MAX_DETOUR_KM,
  speedKmh = DEFAULT_AVG_SPEED_KMH,
}) {
  const targetDist = Number.isFinite(targetStation.distanceKm)
    ? targetStation.distanceKm
    : origin && targetStation.coordinates
    ? geo.haversineKm(origin, targetStation.coordinates)
    : 0;

  const candDist = Number.isFinite(candidateStation.distanceKm)
    ? candidateStation.distanceKm
    : origin && candidateStation.coordinates
    ? geo.haversineKm(origin, candidateStation.coordinates)
    : 0;

  const targetDriveMin = estimateDriveTimeMinutes(targetDist, speedKmh);
  const candDriveMin = estimateDriveTimeMinutes(candDist, speedKmh);

  const targetWaitMin = Math.max(0, Number(targetStation.waitMinutes) || 0);
  const candWaitMin = Math.max(0, Number(candidateStation.waitMinutes) || 0);

  // A station's own figure when it has one, else the fuel's real service
  // duration (config/fuelDurations.js) -- not a flat 4 minutes.
  const fuelServiceMin = getServiceDurationSeconds(fuelType) / 60;
  const serviceMin = (v) => (Number(v) > 0 ? Number(v) : fuelServiceMin);
  const targetServiceMin = serviceMin(targetStation.avgServiceMinutes);
  const candServiceMin = serviceMin(candidateStation.avgServiceMinutes);

  const targetTotalTime = round1(targetDriveMin + targetWaitMin + targetServiceMin);
  const candTotalTime = round1(candDriveMin + candWaitMin + candServiceMin);

  const timeSavedMinutes = round1(targetTotalTime - candTotalTime);
  const extraDistanceKm = round2(candDist - targetDist);

  // Check inventory if candidate tracks it
  const fuel = discovery.normaliseFuel(fuelType);
  let hasInventory = true;
  let inventoryReason = null;
  if (fuel && candidateStation.inventory) {
    const stockCheck = discovery.hasSufficientInventory(candidateStation, fuel, requestedQty);
    hasInventory = stockCheck.ok;
    inventoryReason = stockCheck.reason;
  }

  // Check slot capacity
  // Set by the caller from the nozzle scheduler (can the slot be booked?).
  const cannotBook = candidateStation.canBook === false;

  // Decision rule conditions
  const meetsTimeThreshold = timeSavedMinutes >= minTimeSavedMinutes;
  const withinDistance = candDist <= maxDetourKm;
  const isAvailable = hasInventory && !cannotBook;

  const isWorthIt = meetsTimeThreshold && withinDistance && isAvailable;

  let reason;
  if (!isAvailable) {
    reason = cannotBook
      ? "Alternative station cannot take a booking at that time"
      : inventoryReason || "Insufficient fuel stock";
  } else if (!withinDistance) {
    reason = `Alternative station is too far (${candDist.toFixed(1)} km > ${maxDetourKm} km limit)`;
  } else if (!meetsTimeThreshold) {
    reason = `Time saved (${timeSavedMinutes} min) does not justify the extra drive of ${Math.max(0, extraDistanceKm).toFixed(1)} km`;
  } else {
    reason = `Saves ~${timeSavedMinutes} min overall (${Math.max(0, targetWaitMin - candWaitMin)} min less queue wait)`;
  }

  return {
    stationId: String(candidateStation._id || candidateStation.id),
    name: candidateStation.name,
    address: candidateStation.address,
    coordinates: candidateStation.coordinates || candidateStation.location,
    distanceKm: round2(candDist),
    extraDistanceKm,
    waitMinutes: candWaitMin,
    queueLength: candidateStation.queueLength || 0,
    queueStatus: candidateStation.queueStatus || "Low",
    driveTimeMinutes: round1(candDriveMin),
    totalTripTimeMinutes: candTotalTime,
    targetTotalTripTimeMinutes: targetTotalTime,
    timeSavedMinutes,
    isWorthIt,
    reason,
    price: candidateStation.prices?.[fuel] ?? null,
  };
}

/**
 * Expected wait at the pump for a booking that starts at `slotStart`.
 *
 * A bookable slot has the app nozzle reserved for it, so the only wait is a
 * line that is running late right now (services/queue/stationQueue.js): if the
 * line clears 25 min from now and the slot starts in 10, the car waits ~15.
 * For any other day there is no live line to carry over, so it is 0 -- not a
 * guess from a formula.
 */
function waitAtSlotMinutes(queue, slotStart, now) {
  if (!queue || !slotStart) return 0;
  const untilSlot = (slotStart.getTime() - now.getTime()) / 60_000;
  return Math.max(0, Math.ceil(queue.waitMinutes - Math.max(0, untilSlot)));
}

/**
 * Can `station` take this exact booking (fuel, quantity, date, slot)?
 * The same checks POST /api/bookings makes: active, priced, enough bookable
 * stock (tank less live commitments) and the nozzle free within opening hours.
 *
 * @returns {{code:string, reason:string}|null} null when it can
 */
function bookingProblem(station, slot, fuel, quantity) {
  if (station.status !== "Active") return { code: "INACTIVE", reason: "Station is not active" };
  const price = Number(station.prices?.[fuel]);
  if (!(price > 0)) return { code: "NO_PRICE", reason: "No price published for this fuel" };
  const stock = discovery.hasSufficientInventory(station, fuel, quantity);
  if (!stock.ok) return { code: "INSUFFICIENT_STOCK", reason: stock.reason };
  if (!slot) return { code: "UNKNOWN_SLOT", reason: "Not a bookable time slot" };
  if (slot.reason === "PASSED") return { code: "PASSED", reason: "This time slot has passed" };
  if (slot.reason === "CLOSED") return { code: "CLOSED", reason: "Station is closed at this time" };
  if (slot.reason === "RESERVED") return { code: "RESERVED", reason: "The nozzle is already booked at this time" };
  return null;
}

/**
 * The booking wizard's recommender: for the exact booking a customer is about
 * to make (station, fuel, quantity, date, slot), is there a station that
 * serves it better?
 *
 *   target cannot take it  -> the station that can, with the shortest total
 *                             trip (drive + wait at the slot + service)
 *   target can take it     -> only a station compareStationWorth judges
 *                             genuinely worth it (saves >= minTimeSaved min)
 *
 * Every figure is measured: bookability from the nozzle schedule, stock and
 * price; wait from today's simulated line; distance from the customer's
 * position (or the target station when the position is unknown). Candidates
 * are limited to the target's distance plus DEFAULT_MAX_DETOUR_KM, the same
 * detour rule the station finder uses.
 *
 * @param {object} p
 * @param {string} p.targetStationId
 * @param {{lat:number,lng:number}|null} p.origin
 * @param {string} p.bookingDate  "YYYY-MM-DD" (India)
 * @param {string} p.timeSlot     a booking label, e.g. "10:30 AM"
 * @param {string} p.fuelType
 * @param {number} p.quantity
 * @param {object} [p.opts]       { minTimeSavedMinutes }
 * @param {Date}   [p.now]
 */
async function findWorthItAlternatives({
  targetStationId,
  origin,
  bookingDate,
  timeSlot,
  fuelType,
  quantity,
  opts = {},
  now = new Date(),
}) {
  const fail = (status, message) => Object.assign(new Error(message), { status });

  const fuel = discovery.normaliseFuel(fuelType);
  if (!fuel) throw fail(400, "Fuel type must be Petrol, Diesel or CNG");
  const dayStart = atBusinessTime(String(bookingDate), 0, 0);
  if (!dayStart) throw fail(400, "date must be YYYY-MM-DD");

  let target;
  try {
    target = await Station.findById(targetStationId).lean();
  } catch {
    target = null;
  }
  if (!target) throw fail(404, "Target station not found");

  const minTimeSaved = opts.minTimeSavedMinutes || DEFAULT_MIN_TIME_SAVED_MINUTES;
  const serviceMinutes = getServiceDurationSeconds(fuel, quantity) / 60;
  const userCoord = geo.isCoord(origin) ? origin : toCoord(target);
  const targetCoord = toCoord(target);
  const targetDistanceKm =
    userCoord && geo.isCoord(targetCoord) ? round2(geo.haversineKm(userCoord, targetCoord)) : 0;
  const maxDetourKm = targetDistanceKm + DEFAULT_MAX_DETOUR_KM;

  const candidates = geo.isCoord(userCoord)
    ? (
        await discovery.findStationsForFuel(userCoord, { fuelType: fuel, radiusKm: maxDetourKm, limit: 20 })
      ).stations.filter((s) => String(s._id) !== String(target._id))
    : [];

  const all = [target, ...candidates];
  const ids = all.map((s) => s._id);
  const isToday = dateKey(now) === String(bookingDate);
  const [windows, queues] = await Promise.all([
    nozzleScheduler.loadActiveWindows(ids, dayStart, new Date(dayStart.getTime() + 86_400_000), { now, fuelType: fuel }),
    isToday ? stationQueue.queueSnapshots(ids, now) : Promise.resolve(new Map()),
  ]);

  const describe = (station) => {
    const slot = nozzleScheduler
      .describeLabels(windows.get(String(station._id)) || [], fuel, String(bookingDate), { station, now, quantity })
      .find((s) => s.label === String(timeSlot));
    const problem = bookingProblem(station, slot, fuel, quantity);
    return {
      station,
      problem,
      // This fuel's line only.
      waitMinutes: problem ? null : waitAtSlotMinutes(queues.get(String(station._id))?.byFuel?.[fuel], slot?.start, now),
    };
  };

  const t = describe(target);
  if (t.problem?.code === "UNKNOWN_SLOT") throw fail(400, "timeSlot is not a bookable time slot");

  const compared = candidates
    .map(describe)
    .filter((c) => c.problem === null)
    .map((c) =>
      compareStationWorth({
        targetStation: { distanceKm: targetDistanceKm, waitMinutes: t.waitMinutes ?? 0, avgServiceMinutes: serviceMinutes },
        candidateStation: {
          ...c.station,
          distanceKm: c.station.distanceKm,
          waitMinutes: c.waitMinutes,
          avgServiceMinutes: serviceMinutes,
          inventory: undefined, // stock already checked with the requested quantity
          canBook: true,
        },
        fuelType: fuel,
        minTimeSavedMinutes: minTimeSaved,
        maxDetourKm,
      }),
    )
    .filter((c) => c.distanceKm <= maxDetourKm);

  let best = null;
  let reason = null;
  if (t.problem) {
    best = [...compared].sort((a, b) => a.totalTripTimeMinutes - b.totalTripTimeMinutes)[0] || null;
    if (best) reason = `can take this booking, about ${best.totalTripTimeMinutes} min in total`;
  } else {
    best = compared.filter((c) => c.isWorthIt).sort((a, b) => b.timeSavedMinutes - a.timeSavedMinutes)[0] || null;
    if (best) reason = best.reason;
  }

  return {
    target: {
      stationId: String(target._id),
      name: target.name,
      canBook: t.problem === null,
      unavailableCode: t.problem?.code ?? null,
      unavailableReason: t.problem?.reason ?? null,
      distanceKm: targetDistanceKm,
      waitMinutes: t.waitMinutes,
      totalTripTimeMinutes: t.problem
        ? null
        : calculateTotalTripTime({ distanceKm: targetDistanceKm, waitMinutes: t.waitMinutes, avgServiceMinutes: serviceMinutes }),
    },
    alternative: best && {
      stationId: best.stationId,
      name: best.name,
      address: best.address,
      distanceKm: best.distanceKm,
      waitMinutes: best.waitMinutes,
      totalTripTimeMinutes: best.totalTripTimeMinutes,
      timeSavedMinutes: t.problem ? null : best.timeSavedMinutes,
      price: best.price,
      reason,
    },
    candidatesChecked: candidates.length,
    waitBasis: isToday ? stationQueue.BASIS : "reserved-slot",
    positionBasis: geo.isCoord(origin) ? "customer" : "target-station",
  };
}

function toCoord(s) {
  if (Array.isArray(s?.location?.coordinates)) {
    const [lng, lat] = s.location.coordinates;
    return { lat, lng };
  }
  return s?.coordinates || null;
}

const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : 0);
const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

module.exports = {
  estimateDriveTimeMinutes,
  calculateTotalTripTime,
  compareStationWorth,
  findWorthItAlternatives,
  waitAtSlotMinutes,
  bookingProblem,
  DEFAULT_AVG_SPEED_KMH,
  DEFAULT_MIN_TIME_SAVED_MINUTES,
  DEFAULT_MAX_DETOUR_KM,
  HIGH_QUEUE_THRESHOLD_MINUTES,
};
