/**
 * Station discovery: turn "where am I" into "here are your best options".
 *
 * The pipeline is ordered cheapest-filter-first so the expensive steps only
 * ever see a handful of rows:
 *
 *   $geoNear (2dsphere, DB-side)  -> candidates inside the radius
 *   predictWait per candidate     -> live ETA from the M/M/c model
 *   kNearest                      -> trim to the top-k by distance
 *   rankStations                  -> weighted score over distance/wait/price
 *
 * Road distance (Google/OSRM) is deliberately NOT called here. It is a paid,
 * rate-limited, network-latency-bound call, so it belongs after this function
 * has cut the field to 3-5 stations -- see enrichWithRoadDistance().
 */

const Station = require("../../models/Station");
const geo = require("../algorithms/geo");
const { predictWait } = require("../algorithms/queue");
const stationQueue = require("../queue/stationQueue");

const DEFAULT_RADIUS_KM = 5;
const DEFAULT_LIMIT = 5;
const MAX_CANDIDATES = 100;

/**
 * Find and rank stations near a point.
 *
 * @param {{lat:number,lng:number}} origin
 * @param {object} opts
 * @param {number} opts.radiusKm      search radius (default 5)
 * @param {number} opts.limit         how many to return (default 5)
 * @param {string} opts.fuelType      'petrol' | 'diesel' | 'cng'
 * @param {number} opts.minQuantity   reject stations without this much stock
 * @param {object} opts.weights       override the ranking weights
 */
async function findNearbyStations(origin, opts = {}) {
  if (!geo.isCoord(origin)) {
    const err = new Error("Valid lat/lng required");
    err.status = 400;
    throw err;
  }

  const radiusKm = clampNum(opts.radiusKm, DEFAULT_RADIUS_KM, 0.1, 200);
  const limit = clampNum(opts.limit, DEFAULT_LIMIT, 1, 50);
  const fuelType = normaliseFuel(opts.fuelType);

  const match = { status: "Active" };
  if (fuelType) match.fuelTypes = fuelMatch(fuelType);
  if (Number.isFinite(opts.minQuantity) && fuelType) {
    // Available stock -- in the tank and not already promised to bookings.
    match.$expr = {
      $gte: [
        {
          $subtract: [
            { $ifNull: [`$inventory.${fuelType}`, 0] },
            { $ifNull: [`$inventoryCommitted.${fuelType}`, 0] },
          ],
        },
        opts.minQuantity,
      ],
    };
  }

  const candidates = await geoCandidates(origin, match, radiusKm);

  // Attach the live wait to each candidate before ranking, since wait time
  // is one of the three ranking factors -- the same queue model as every
  // other screen (services/queue/stationQueue.js), from real bookings.
  const queues = await stationQueue.queueSnapshots(candidates.map((s) => s._id));

  const withEta = candidates.map((s) => {
    // A search for one fuel ranks by that fuel's own line.
    const snapshot = queues.get(String(s._id));
    const prediction = (fuelType && snapshot.byFuel[fuelType]) || snapshot;
    return {
      ...s,
      waitMinutes: prediction.waitMinutes,
      queueStatus: prediction.queueStatus,
      etaBasis: prediction.basis,
    };
  });

  const nearest = geo.kNearest(origin, withEta, limit);
  return geo.rankStations(nearest, opts.weights, { fuelType });
}

// ---------------------------------------------------------------------------
// The one geo candidate search. Every "stations near me" path goes through
// geoCandidates(): the customer finder (GET /api/stations/nearby), the
// nearest-station endpoint, findNearbyStations() and so the alternative
// recommender.
// ---------------------------------------------------------------------------

/** Radii the finder widens through when the caller gives none. */
const SEARCH_RADII_KM = [5, 10, 15, 25, 50];
const MAX_SEARCH_RADIUS_KM = SEARCH_RADII_KM[SEARCH_RADII_KM.length - 1];
const MAX_FINDER_RESULTS = 50;

// MongoDB measures $geoNear on a 6378.1 km sphere; the authoritative distance
// here is Haversine on the 6371 km mean radius, about 0.1% shorter. The DB
// radius is widened slightly so a station just inside the Haversine radius is
// never dropped by the index before Haversine gets to measure it.
const GEO_NEAR_SLACK = 1.01;

/** fuelTypes holds labels ("Petrol"); match any casing of one known key. */
function fuelMatch(fuelKey) {
  return { $elemMatch: { $regex: `^${fuelKey}$`, $options: "i" } };
}

/**
 * Active-or-not stations matching `match` within `radiusKm` of `origin`,
 * nearest first, each with `distanceKm` (Haversine, unrounded).
 *
 * A station with no position, or the (0, 0) placeholder, is never a
 * candidate: it has no distance, and a made-up one would put it on the list.
 */
async function geoCandidates(origin, match, radiusKm) {
  let rows;
  try {
    // $geoNear uses the 2dsphere index, so only nearby documents are read.
    rows = await Station.aggregate([
      {
        $geoNear: {
          near: { type: "Point", coordinates: [origin.lng, origin.lat] },
          distanceField: "distanceMeters",
          maxDistance: radiusKm * 1000 * GEO_NEAR_SLACK,
          spherical: true,
          query: match,
        },
      },
      { $limit: MAX_CANDIDATES },
    ]);
  } catch (err) {
    // No 2dsphere index (a fresh database): degrade to a bounded scan rather
    // than failing the search.
    console.warn(`[discovery] $geoNear unavailable (${err.message}); falling back to a scan`);
    rows = await Station.find(match).limit(500).lean();
  }

  const out = [];
  for (const s of rows) {
    const at = toLatLng(s);
    if (!at || !Station.isRealPosition(at.lat, at.lng)) continue;
    const distanceKm = geo.haversineKm(origin, at);
    if (distanceKm !== null && distanceKm <= radiusKm) out.push({ ...s, distanceKm });
  }
  out.sort((a, b) => a.distanceKm - b.distanceKm);
  return out;
}

/**
 * Active stations selling `fuelType` near `origin`, for the customer finder.
 *
 * With no radius, the search widens 5 -> 10 -> 15 -> 25 -> 50 km and stops at
 * the first radius that has any station, using one index query at 50 km.
 *
 * @returns {Promise<{radiusKm:number, expanded:boolean, total:number,
 *   stations:object[]}>} stations are plain objects, nearest first
 */
async function findStationsForFuel(origin, { fuelType, radiusKm, limit } = {}) {
  if (!geo.isCoord(origin)) throw badRequest("A valid latitude and longitude are required");
  const fuel = normaliseFuel(fuelType);
  if (!fuel) throw badRequest("Fuel type must be Petrol, Diesel or CNG");

  let radii = SEARCH_RADII_KM;
  if (radiusKm !== undefined && radiusKm !== null && radiusKm !== "") {
    const r = Number(radiusKm);
    if (!Number.isFinite(r) || r <= 0) throw badRequest("radius must be a positive number of km");
    radii = [Math.min(r, MAX_SEARCH_RADIUS_KM)];
  }
  const max = clampNum(limit, 20, 1, MAX_FINDER_RESULTS);

  const widest = radii[radii.length - 1];
  const all = await geoCandidates(origin, { status: "Active", fuelTypes: fuelMatch(fuel) }, widest);
  const used = radii.find((r) => all.some((s) => s.distanceKm <= r)) ?? widest;
  const inside = all.filter((s) => s.distanceKm <= used);

  return {
    radiusKm: used,
    expanded: radii.length > 1 && used > radii[0],
    total: inside.length,
    stations: inside.slice(0, max),
  };
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/**
 * Does this station have enough fuel to honour one more booking?
 *
 * Checked against available stock: the tank less what live bookings have
 * already been promised (Station.inventoryCommitted, kept by
 * services/inventory/stockLedger.js) -- not an estimate of bookings times a fill size.
 */
function hasSufficientInventory(station, fuelType, requestedQty) {
  const fuel = normaliseFuel(fuelType);
  if (!fuel) return { ok: false, reason: "Unknown fuel type" };

  const stock = Number(station?.inventory?.[fuel]);
  if (!Number.isFinite(stock)) {
    return { ok: false, reason: "Inventory not tracked for this fuel" };
  }

  const qty = Number(requestedQty);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, reason: "Invalid quantity" };
  }

  const committed = Math.max(0, Number(station?.inventoryCommitted?.[fuel]) || 0);
  const available = stock - committed;
  const ok = available >= qty;

  return {
    ok,
    stock,
    committed,
    available: round2(available),
    requested: qty,
    reason: ok ? null : `Only ${round2(Math.max(0, available))} units available to book`,
  };
}

/**
 * Second-pass enrichment with real road distance / drive time.
 *
 * Left as an injectable function rather than a hard dependency on Google
 * Maps: the caller supplies `routeProvider`, which keeps this module testable
 * and lets you swap Google for OSRM without touching discovery logic.
 *
 * Failures are non-fatal -- straight-line distance is a usable answer.
 */
async function enrichWithRoadDistance(origin, stations, routeProvider) {
  if (typeof routeProvider !== "function" || !stations?.length) return stations;

  const results = await Promise.allSettled(
    stations.map((s) => routeProvider(origin, toLatLng(s))),
  );

  return stations.map((s, i) => {
    const r = results[i];
    if (r.status !== "fulfilled" || !r.value) return s;
    return {
      ...s,
      roadDistanceKm: r.value.distanceKm ?? null,
      driveTimeMinutes: r.value.durationMinutes ?? null,
    };
  });
}

// The one fuel definition lives in config/fuels.js; re-exported here because
// existing callers import normaliseFuel from this module.
const fuels = require("../../config/fuels");
function normaliseFuel(fuelType) {
  return fuels.normaliseFuel(fuelType);
}

function toLatLng(s) {
  if (Array.isArray(s?.location?.coordinates)) {
    const [lng, lat] = s.location.coordinates;
    return { lat, lng };
  }
  return s?.coordinates || null;
}

function clampNum(v, fallback, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : n);

module.exports = {
  findNearbyStations,
  findStationsForFuel,
  geoCandidates,
  SEARCH_RADII_KM,
  MAX_SEARCH_RADIUS_KM,
  hasSufficientInventory,
  enrichWithRoadDistance,
  normaliseFuel,
  DEFAULT_RADIUS_KM,
  DEFAULT_LIMIT,
};
