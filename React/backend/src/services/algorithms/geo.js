/**
 * Geospatial primitives for station discovery.
 *
 * Pipeline (cheapest filter first, most expensive last):
 *   1. $geoNear / 2dsphere radius query  -> narrows to a candidate set (DB-side)
 *   2. haversineKm                       -> exact straight-line distance
 *   3. kNearest                          -> top-k by distance
 *   4. rankStations                      -> weighted score over distance/wait/price
 *   5. (caller) road-distance API        -> only for the handful that survive
 *
 * Everything here is pure and synchronous so it can be unit-tested without a DB.
 */

const EARTH_RADIUS_KM = 6371.0088; // IUGG mean radius

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two {lat,lng} points, in kilometres.
 *
 * Uses the haversine form rather than the spherical law of cosines because
 * cos() loses precision for the small angles that dominate city-scale search.
 */
function haversineKm(a, b) {
  if (!isCoord(a) || !isCoord(b)) return null;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);

  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;

  // clamp guards against h drifting a hair above 1 from rounding
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, h)));
}

function isCoord(p) {
  return (
    p &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}

/**
 * Attach `distanceKm` to each station and drop anything outside `radiusKm`.
 * `getCoord` tells us where the lat/lng lives on the station shape.
 */
function withinRadius(origin, stations, radiusKm, getCoord = defaultGetCoord) {
  if (!isCoord(origin)) return [];

  const out = [];
  for (const s of stations || []) {
    const d = haversineKm(origin, getCoord(s));
    if (d !== null && d <= radiusKm) out.push({ ...toPlain(s), distanceKm: d });
  }
  return out;
}

/**
 * K-Nearest Neighbours by great-circle distance.
 *
 * Returns the k closest stations *with distances attached*, nearest first.
 * We return several rather than a single winner so the customer can trade
 * distance against wait time and price -- which is what rankStations is for.
 */
function kNearest(origin, stations, k = 5, getCoord = defaultGetCoord) {
  if (!isCoord(origin)) return [];

  const scored = [];
  for (const s of stations || []) {
    const d = haversineKm(origin, getCoord(s));
    if (d !== null) scored.push({ ...toPlain(s), distanceKm: d });
  }

  scored.sort((x, y) => x.distanceKm - y.distanceKm);
  return scored.slice(0, Math.max(0, k));
}

/**
 * Weighted "best station for you" ranking.
 *
 *   score = w.distance * norm(distanceKm)
 *         + w.wait     * norm(waitMinutes)
 *         + w.price     * norm(pricePerUnit)
 *
 * Lower is better. Each factor is min-max normalised across the candidate set
 * so that kilometres, minutes and rupees become comparable -- ranking on raw
 * units would let whichever factor happens to have the largest numeric spread
 * dominate the result.
 *
 * A factor where every candidate ties normalises to 0 for everyone, which
 * correctly makes it irrelevant to the ordering.
 */
const DEFAULT_WEIGHTS = { distance: 0.45, wait: 0.4, price: 0.15 };

function rankStations(candidates, weights = DEFAULT_WEIGHTS, opts = {}) {
  const list = (candidates || []).map(toPlain);
  if (list.length === 0) return [];

  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const fuel = opts.fuelType || null;

  const dist = list.map((s) => num(s.distanceKm));
  const wait = list.map((s) => num(s.waitMinutes));
  const price = list.map((s) => num(priceFor(s, fuel)));

  const nDist = minMax(dist);
  const nWait = minMax(wait);
  const nPrice = minMax(price);

  const ranked = list.map((s, i) => {
    const parts = {
      distance: w.distance * nDist[i],
      wait: w.wait * nWait[i],
      price: w.price * nPrice[i],
    };
    return {
      ...s,
      score: parts.distance + parts.wait + parts.price,
      scoreBreakdown: parts,
    };
  });

  ranked.sort((a, b) => a.score - b.score);
  return ranked;
}

/** Min-max normalise to [0,1]. All-equal (or empty spread) -> all zeros. */
function minMax(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return values.map(() => 0);

  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const span = hi - lo;

  // Every known value ties, so the factor cannot discriminate between them --
  // but an unknown value (e.g. no published price) still ranks worst.
  if (span === 0) return values.map((v) => (Number.isFinite(v) ? 0 : 1));

  return values.map((v) => (Number.isFinite(v) ? (v - lo) / span : 1));
}

/**
 * The price that matters for the ranking. For a fuel search that is that
 * fuel's price and nothing else: another fuel's price says nothing about it.
 * A missing or non-positive price is unknown (NaN), which minMax ranks worst
 * rather than cheapest.
 */
function priceFor(station, fuelType) {
  const p = station.prices || {};
  const real = (v) => Number.isFinite(v) && v > 0;
  if (fuelType) {
    const v = p[String(fuelType).toLowerCase()];
    return real(v) ? v : NaN;
  }
  const all = Object.values(p).filter(real);
  return all.length ? all.reduce((a, b) => a + b, 0) / all.length : NaN;
}

function num(v) {
  return Number.isFinite(v) ? v : NaN;
}

function defaultGetCoord(s) {
  if (!s) return null;
  // GeoJSON Point: [lng, lat]
  if (s.location && Array.isArray(s.location.coordinates)) {
    const [lng, lat] = s.location.coordinates;
    return { lat, lng };
  }
  if (s.coordinates) return s.coordinates;
  if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) {
    return { lat: s.lat, lng: s.lng };
  }
  return null;
}

/** Mongoose docs need .toObject() before spreading, plain objects pass through. */
function toPlain(s) {
  return s && typeof s.toObject === "function" ? s.toObject() : s;
}

/**
 * Build the GeoJSON Point a 2dsphere index expects. Note the [lng, lat] order
 * -- reversing it is the single most common geo bug, so it is centralised here.
 */
function toGeoPoint(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return { type: "Point", coordinates: [lng, lat] };
}

module.exports = {
  EARTH_RADIUS_KM,
  haversineKm,
  isCoord,
  withinRadius,
  kNearest,
  rankStations,
  toGeoPoint,
  minMax,
  priceFor,
  DEFAULT_WEIGHTS,
};
