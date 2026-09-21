/**
 * Road distance from the customer to stations -- driving distance along the
 * road network, the way Google Maps measures a route, instead of a straight
 * line (which is often less than half the real drive).
 *
 * Providers, in order:
 *   1. Google Routes API (Compute Route Matrix) when GOOGLE_MAPS_API_KEY is
 *      set -- the same road data and routing as Google Maps.
 *   2. OSRM (open-source, OpenStreetMap roads) -- the fallback when there is
 *      no Google key or Google fails (billing off, quota, network).
 *
 *   GOOGLE_MAPS_API_KEY  enables Google (server-side only; never sent to browsers)
 *   ROUTING_URL          OSRM base URL (default: the public OSRM demo server);
 *                        "off" disables road routing entirely (tests, offline)
 *
 * Never blocks a search: a slow, failing or unreachable router leaves the
 * straight-line distance in place (distanceType "straight"). Answers are
 * cached briefly, so repeated searches from the same spot do not re-ask.
 */

const DEFAULT_ROUTING_URL = "https://router.project-osrm.org";
const GOOGLE_MATRIX_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;
/** Per request; well inside both providers' limits. */
const MAX_DESTINATIONS = 50;
/** After Google refuses (billing, key, quota), use OSRM for a while instead of asking again. */
const GOOGLE_BACKOFF_MS = 10 * 60_000;

const cache = new Map(); // key -> { at, value: {distanceKm, durationMinutes, source} | null }
let googleBlockedUntil = 0;

function routingUrl(env = process.env) {
  const v = String(env.ROUTING_URL ?? "").trim();
  if (v.toLowerCase() === "off") return null;
  return (v || DEFAULT_ROUTING_URL).replace(/\/+$/, "");
}

const routingOff = (env) => String(env.ROUTING_URL ?? "").trim().toLowerCase() === "off";
const googleKey = (env) => String(env.GOOGLE_MAPS_API_KEY ?? "").trim() || null;

// ~1 m precision: the same spot searched again hits the cache.
const keyOf = (o, d) => `${o.lat.toFixed(5)},${o.lng.toFixed(5)}>${d.lat.toFixed(5)},${d.lng.toFixed(5)}`;
const valid = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);

function remember(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
}

/** Google Routes API: { index -> {distanceKm, durationMinutes} } for the destinations routed. */
async function viaGoogle(origin, points, { fetchImpl, env }) {
  const key = googleKey(env);
  if (!key || Date.now() < googleBlockedUntil) return null;
  const ll = (p) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
  let res;
  try {
    res = await fetchImpl(GOOGLE_MATRIX_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "originIndex,destinationIndex,distanceMeters,duration,condition",
      },
      body: JSON.stringify({
        origins: [ll(origin)],
        destinations: points.map(ll),
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_UNAWARE",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null; // network / timeout: OSRM next
  }
  if (!res.ok) {
    // 403 billing / key restrictions, 429 quota: stop asking for a while.
    if (res.status === 400 || res.status === 403 || res.status === 429) {
      googleBlockedUntil = Date.now() + GOOGLE_BACKOFF_MS;
      const body = await res.json().catch(() => null);
      const reason = (Array.isArray(body) ? body[0] : body)?.error?.status || res.status;
      console.warn(`[roadDistance] Google Routes API refused (${reason}); using OSRM for ${GOOGLE_BACKOFF_MS / 60000} min`);
    }
    return null;
  }
  const rows = await res.json().catch(() => null);
  if (!Array.isArray(rows)) return null;
  const out = new Map();
  for (const r of rows) {
    if (r?.condition !== "ROUTE_EXISTS" || !Number.isFinite(r.distanceMeters)) continue;
    const seconds = parseFloat(String(r.duration ?? "").replace(/s$/, ""));
    out.set(r.destinationIndex ?? 0, {
      distanceKm: r.distanceMeters / 1000,
      durationMinutes: Number.isFinite(seconds) ? seconds / 60 : null,
      source: "google",
    });
  }
  return out;
}

/** OSRM table: { index -> {distanceKm, durationMinutes} } for the destinations routed. */
async function viaOsrm(origin, points, { fetchImpl, env }) {
  const base = routingUrl(env);
  if (!base) return null;
  // OSRM takes lng,lat; the origin is index 0.
  const coords = [origin, ...points].map((p) => `${p.lng},${p.lat}`).join(";");
  try {
    const res = await fetchImpl(`${base}/table/v1/driving/${coords}?sources=0&annotations=distance,duration`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.code !== "Ok") return null;
    const dist = body.distances?.[0] ?? [];
    const dur = body.durations?.[0] ?? [];
    const out = new Map();
    points.forEach((_, k) => {
      const meters = dist[k + 1];
      const seconds = dur[k + 1];
      if (Number.isFinite(meters)) {
        out.set(k, { distanceKm: meters / 1000, durationMinutes: Number.isFinite(seconds) ? seconds / 60 : null, source: "osrm" });
      }
    });
    return out;
  } catch {
    return null; // timeout / network / bad JSON
  }
}

/**
 * Driving distance and time from `origin` to each destination.
 * @param {{lat:number,lng:number}} origin
 * @param {Array<{lat:number,lng:number}|null>} destinations
 * @returns {Promise<Array<{distanceKm:number, durationMinutes:number|null, source:string}|null>>}
 *   one entry per destination; null where no road route is known
 */
async function roadDistances(origin, destinations, { fetchImpl = fetch, env = process.env } = {}) {
  const out = destinations.map(() => null);
  if (routingOff(env) || !valid(origin) || !destinations.length) return out;

  const now = Date.now();
  const todo = [];
  destinations.forEach((d, i) => {
    if (!valid(d)) return;
    const hit = cache.get(keyOf(origin, d));
    if (hit && now - hit.at < CACHE_TTL_MS) out[i] = hit.value;
    else if (todo.length < MAX_DESTINATIONS) todo.push(i);
  });
  if (!todo.length) return out;

  const points = todo.map((i) => destinations[i]);
  let routed = await viaGoogle(origin, points, { fetchImpl, env });
  // Google off or failed, or left some destinations unrouted: OSRM for the rest.
  const missing = points.map((_, k) => k).filter((k) => !routed?.has(k));
  if (missing.length) {
    const osrm = await viaOsrm(origin, missing.map((k) => points[k]), { fetchImpl, env });
    routed = routed || new Map();
    missing.forEach((k, j) => {
      const v = osrm?.get(j);
      if (v) routed.set(k, v);
    });
  }

  todo.forEach((i, k) => {
    const value = routed.get(k) ?? null;
    // Only real answers are cached: a failure is retried next time.
    if (value) remember(keyOf(origin, destinations[i]), value);
    out[i] = value;
  });
  return out;
}

/**
 * Stations from findStationsForFuel with `distanceKm` replaced by the road
 * distance where one is known. The straight line is kept as
 * `straightLineKm`; `distanceType` says which one `distanceKm` is, and
 * `distanceSource` which router measured it ("google" / "osrm").
 */
async function withRoadDistance(origin, stations, opts) {
  if (!stations?.length) return stations;
  const points = stations.map((s) => {
    const c = Array.isArray(s?.location?.coordinates) ? { lat: s.location.coordinates[1], lng: s.location.coordinates[0] } : s?.coordinates;
    return valid(c) ? { lat: Number(c.lat), lng: Number(c.lng) } : null;
  });
  const roads = await roadDistances(origin, points, opts);
  return stations.map((s, i) => {
    const road = roads[i];
    if (!road) return { ...s, straightLineKm: s.distanceKm, distanceType: "straight" };
    return {
      ...s,
      straightLineKm: s.distanceKm,
      distanceKm: road.distanceKm,
      driveTimeMinutes: road.durationMinutes,
      distanceType: "road",
      distanceSource: road.source,
    };
  });
}

/** Tests: forget cached answers and any Google back-off. */
function _reset() {
  cache.clear();
  googleBlockedUntil = 0;
}

module.exports = { roadDistances, withRoadDistance, routingUrl, _cache: cache, _reset };
