/**
 * Customer station finder: turns the geo search (services/station/discovery.js
 * findStationsForFuel) into the ranked cards on the "Nearest stations" page.
 *
 * Everything here is measured, not assumed:
 *   slots   -- the same model POST /api/bookings enforces: 30-minute labels
 *              (config/booking.js), the station's opening hours
 *              (models/Station.js) and the single app nozzle
 *              (services/queue/nozzleScheduler.js). A slot shown as free is one
 *              booking would accept.
 *   wait    -- the app nozzle's live line, simulated from today's real
 *              bookings (services/queue/stationQueue.js), the same number every
 *              other screen shows.
 *   canBook -- published price, stock, a bookable slot left today, active.
 *              When false, `unavailableReason` says which.
 *
 * Ranking (lower is better):
 *   tier 0  bookable and open now
 *   tier 1  bookable, but closed right now (a later slot today)
 *   tier 2  cannot be booked
 * Inside a tier, services/algorithms/geo.js rankStations: min-max normalised
 * distance 0.45 / wait 0.40 / price 0.15. A station that cannot take the
 * booking is never "Best match", however close or cheap it is.
 *
 * All stations' bookings are read in one query, so the cost does not grow
 * with a query per station.
 */

const Station = require("../../models/Station");
const geo = require("../algorithms/geo");
const stationQueue = require("../queue/stationQueue");
const nozzleScheduler = require("../queue/nozzleScheduler");
const smartRecommender = require("./smartRecommender");
const { normaliseFuel, fuelLabel, fuelUnit } = require("../../config/fuels");
const { getServiceDurationSeconds } = require("../../config/fuelDurations");
const { SLOT_SPACING_SECONDS } = require("../../config/booking");
const {
  dateKey,
  formatHHMM,
  startOfBusinessDay,
  endOfBusinessDay,
} = require("../../config/businessTime");

/** A bookable station whose wait exceeds this also gets an alternative. */
const HIGH_WAIT_MINUTES = 30;

const positive = (v) => (Number.isFinite(v) && v > 0 ? v : null);
const round2 = (n) => Math.round(n * 100) / 100;

/** A label in the SlotInfo shape the UI reads: arrival window, HH:MM India time. */
function toSlotInfo(slot) {
  if (!slot?.start) return null;
  const open = slot.bookable ?? slot.available;
  // The window the label names, and the capacity the scheduler worked out for
  // it (services/queue/nozzleScheduler.js): nozzles x services that fit, less
  // what is taken.
  const windowEnd = slot.windowEnd || new Date(slot.start.getTime() + SLOT_SPACING_SECONDS * 1000);
  const windowStart = new Date(windowEnd.getTime() - SLOT_SPACING_SECONDS * 1000);
  const cap = slot.capacity || { total: 0, available: 0, reserved: 0 };
  return {
    slot: slot.label,
    start: formatHHMM(windowStart),
    end: formatHHMM(windowEnd),
    // When a booking made now would start in this window.
    estimatedStart: open ? formatHHMM(slot.start) : null,
    capacity: cap.total,
    booked: cap.reserved,
    available: open ? cap.available : 0,
    status: open ? "AVAILABLE" : slot.reason === "CLOSED" ? "CLOSED" : "FULL",
  };
}

/**
 * @param {object} p
 * @param {object[]} p.stations  plain stations with distanceKm (findStationsForFuel)
 * @param {string} p.fuel        any spelling of petrol/diesel/cng
 * @param {number|null} [p.quantity]  litres/kg the customer intends to buy
 * @param {Date} [p.now]
 */
async function buildFinderResults({ stations, fuel, quantity = null, now = new Date() }) {
  const fuelKey = normaliseFuel(fuel);
  if (!fuelKey) throw new Error(`buildFinderResults: unknown fuel "${fuel}"`);

  const list = stations || [];
  const today = dateKey(now);
  // The customer's own fill when the quantity is known, else a typical one.
  const serviceMinutes = getServiceDurationSeconds(fuelKey, quantity) / 60;
  // Only this fuel's nozzle and line: other fuels have their own.
  const windowsByStation = await nozzleScheduler.loadActiveWindows(
    list.map((s) => s._id),
    startOfBusinessDay(now),
    endOfBusinessDay(now),
    { now, fuelType: fuelKey },
  );
  const queues = await stationQueue.queueSnapshots(list.map((s) => s._id), now);

  const rows = list.map((plain) =>
    describeStation(plain, {
      fuelKey,
      quantity,
      now,
      today,
      serviceMinutes,
      windows: windowsByStation.get(String(plain._id)) || [],
      queue: queues.get(String(plain._id)).byFuel[fuelKey],
    }),
  );

  for (const row of rows) {
    if (row.canBook && row.estimatedWaitingTime <= HIGH_WAIT_MINUTES) continue;
    row.recommendedAlternative = pickAlternative(row, rows, { fuelKey, serviceMinutes });
  }

  return {
    stations: rank(rows, fuelKey),
    serviceMinutes: round2(serviceMinutes),
    weights: geo.DEFAULT_WEIGHTS,
  };
}

function describeStation(plain, { fuelKey, quantity, now, today, windows, queue }) {
  const doc = Station.hydrate(plain);
  const label = fuelLabel(fuelKey);
  const unit = fuelUnit(fuelKey);

  const price = positive(plain.prices?.[fuelKey]);
  // Bookable stock: what is in the tank less what live bookings already hold.
  const stock = Number(plain.inventory?.[fuelKey]) - (Number(plain.inventoryCommitted?.[fuelKey]) || 0);

  // Labels still ahead today, judged on the nozzle and the station's hours.
  const slots = nozzleScheduler
    .describeLabels(windows, fuelKey, today, { station: plain, now, quantity: quantity ?? undefined })
    .filter((s) => !s.elapsed);
  const free = slots.filter((s) => s.bookable);

  let unavailable = null;
  const nozzleModes = require("../../config/nozzleModes");
  if (plain.status !== "Active") unavailable = ["INACTIVE", "Station is not active"];
  else if (!nozzleModes.acceptsOnline(plain, fuelKey)) unavailable = ["WALK_IN_ONLY", "Walk-in only (no app booking)"];
  else if (price === null) unavailable = ["NO_PRICE", `No ${label} price published`];
  else if (!(stock > 0)) unavailable = ["OUT_OF_STOCK", `No ${label} left to book`];
  else if (quantity !== null && stock < quantity) {
    unavailable = ["INSUFFICIENT_STOCK", `Only ${stock} ${unit} of ${label} left to book`];
  } else if (free.length === 0) unavailable = ["NO_SLOT_TODAY", "No booking slot left today"];

  const schedule = doc.isOpenNow(now);
  const position = doc.latLng();
  const sells = (key) => (plain.fuelTypes || []).some((f) => normaliseFuel(f) === key);

  return {
    stationId: plain._id,
    stationName: plain.name,
    address: plain.address,
    latitude: position?.lat ?? null,
    longitude: position?.lng ?? null,
    distance: round2(plain.distanceKm),
    // "road" = driving distance along the roads (services/station/roadDistance.js),
    // "straight" = straight line, when no route was available.
    distanceType: plain.distanceType || "straight",
    distanceSource: plain.distanceSource || null,
    straightLineKm: Number.isFinite(plain.straightLineKm) ? round2(plain.straightLineKm) : round2(plain.distanceKm),
    driveTimeMinutes: Number.isFinite(plain.driveTimeMinutes) ? Math.round(plain.driveTimeMinutes) : null,
    fuelType: fuelKey.toUpperCase(),
    fuelTypes: plain.fuelTypes || [],
    // Only for fuels the station actually sells.
    petrolPrice: sells("petrol") ? positive(plain.prices?.petrol) : null,
    dieselPrice: sells("diesel") ? positive(plain.prices?.diesel) : null,
    cngPrice: sells("cng") ? positive(plain.prices?.cng) : null,
    _fuelPriceForDisplay: price,
    currentQueue: queue.queueLength,
    estimatedWaitingTime: queue.waitMinutes,
    waitBasis: queue.basis,
    currentSlot: toSlotInfo(slots[0]),
    nextAvailableSlot: toSlotInfo(free[0]),
    recommendedSlots: free.slice(0, 3).map(toSlotInfo),
    preferredSlot: toSlotInfo(free[0]),
    isOpen: schedule.isOpen,
    nextOpenTime: schedule.nextOpenTime,
    canBook: unavailable === null,
    unavailableCode: unavailable?.[0] ?? null,
    unavailableReason: unavailable?.[1] ?? null,
    recommendedAlternative: null,
  };
}

/**
 * A better station from the same result set, or null.
 *
 * - Target cannot be booked: the bookable station with the shortest total
 *   trip (drive + wait + service), within the detour limit.
 * - Target bookable but slow: only an alternative smartRecommender judges
 *   genuinely worth it (saves enough time overall).
 * The detour limit is extra distance beyond the target, not absolute distance.
 */
function pickAlternative(target, rows, { fuelKey, serviceMinutes }) {
  const maxDetourKm = target.distance + smartRecommender.DEFAULT_MAX_DETOUR_KM;
  const compared = rows
    .filter((r) => r !== target && r.canBook)
    .map((c) =>
      smartRecommender.compareStationWorth({
        targetStation: {
          distanceKm: target.distance,
          waitMinutes: target.estimatedWaitingTime,
          avgServiceMinutes: serviceMinutes,
        },
        candidateStation: {
          _id: c.stationId,
          name: c.stationName,
          address: c.address,
          distanceKm: c.distance,
          waitMinutes: c.estimatedWaitingTime,
          avgServiceMinutes: serviceMinutes,
          canBook: true,
        },
        fuelType: fuelKey,
        maxDetourKm,
      }),
    )
    .filter((c) => c.distanceKm <= maxDetourKm);
  if (compared.length === 0) return null;

  const view = (c, reason) => ({
    stationId: c.stationId,
    name: c.name,
    distanceKm: c.distanceKm,
    waitMinutes: c.waitMinutes,
    totalTripTimeMinutes: c.totalTripTimeMinutes,
    timeSavedMinutes: target.canBook ? c.timeSavedMinutes : null,
    reason,
  });

  if (!target.canBook) {
    const best = compared.sort((a, b) => a.totalTripTimeMinutes - b.totalTripTimeMinutes)[0];
    return view(best, `can take your booking, about ${best.totalTripTimeMinutes} min in total`);
  }

  const worth = compared.filter((c) => c.isWorthIt).sort((a, b) => b.timeSavedMinutes - a.timeSavedMinutes)[0];
  return worth ? view(worth, worth.reason) : null;
}

function rank(rows, fuelKey) {
  const tierOf = (r) => (r.canBook ? (r.isOpen ? 0 : 1) : 2);
  return [0, 1, 2].flatMap((tier) => {
    const subset = rows.filter((r) => tierOf(r) === tier);
    return geo
      .rankStations(
        subset.map((s, i) => ({
          _idx: i,
          distanceKm: s.distance,
          waitMinutes: s.estimatedWaitingTime,
          prices: { [fuelKey]: s._fuelPriceForDisplay },
        })),
        undefined,
        { fuelType: fuelKey },
      )
      .map((r) => ({
        ...subset[r._idx],
        rankTier: tier,
        matchScore: Math.round(r.score * 10000) / 10000,
        matchBreakdown: r.scoreBreakdown,
      }));
  });
}

module.exports = { buildFinderResults, pickAlternative, toSlotInfo, HIGH_WAIT_MINUTES };
