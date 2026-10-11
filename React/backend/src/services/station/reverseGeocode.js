/**
 * Coordinates -> a place a person recognises ("Wagholi, Pune").
 *
 * The customer app shows where it is searching from. Two decimals mean
 * nothing to the person reading them, so the point is named -- through
 * OpenStreetMap's Nominatim, the same data behind the map tiles the app
 * already draws.
 *
 * Three things matter here, and all three are Nominatim's own usage policy:
 *
 *   1. It is called from the SERVER, not from every phone. One identifiable
 *      client, one place to cache, and no CORS or key in the bundle.
 *   2. Results are cached, and coordinates are rounded to ~100 m first
 *      (4 decimal places is finer than any place name changes), so a
 *      customer nudging the map pin does not make a request per pixel.
 *   3. At most one request per second leaves this process, and a failure is
 *      never fatal -- the caller falls back to showing the coordinates.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // a place name does not change
const CACHE_MAX = 500;
const MIN_GAP_MS = 1100; // Nominatim asks for <= 1 request/second
const TIMEOUT_MS = 4000;

const ENDPOINT = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT =
  process.env.GEOCODER_USER_AGENT || "FuelMart/1.0 (student project; fuel booking app)";

/** key -> { name, at }. Small and bounded: this is a convenience, not a store. */
const cache = new Map();
let lastCallAt = 0;

/** ~11 m of precision: enough to name a place, coarse enough to cache well. */
const keyFor = (lat, lng) => `${lat.toFixed(4)},${lng.toFixed(4)}`;

/**
 * The shortest name that still says where you are: the road the pin is on,
 * then the locality around it -- "Nagar Road, Ramwadi".
 *
 * Nominatim's display_name is a full postal address, far too long for a chip
 * on a dashboard, and the city alone is useless to someone standing in it:
 * a pin dropped on Nagar Road read "Pune", which is true and tells them
 * nothing. Administrative ward names ("Ward 12") are skipped for the same
 * reason -- nobody says they are in Ward 12.
 */
function shortName(address = {}) {
  const road = address.road || address.pedestrian || address.footway || null;

  // "Ward 12", "Zone 3": an administrative label, not a place anyone names.
  // The word boundary matters -- Wardha is a real town.
  const isWard = (v) => typeof v === "string" && /^(ward|zone)\b/i.test(v.trim());
  const locality =
    [
      address.neighbourhood,
      address.village,
      address.hamlet,
      address.suburb,
      address.town,
      address.locality,
      address.city_district,
    ].find((v) => v && !isWard(v)) || null;

  const city = [address.city, address.town, address.county, address.state_district].find(
    (v) => v && !isWard(v),
  ) || null;

  // Road plus the smallest real place around it; without a road, the place
  // and its city. Never the same word twice.
  const parts = [];
  if (road) parts.push(road);
  const place = locality || city;
  if (place && place !== road) parts.push(place);
  if (!road && city && city !== place) parts.push(city);

  if (parts.length === 0 && address.state) parts.push(address.state);
  return parts.join(", ") || null;
}

function remember(key, name) {
  cache.set(key, { name, at: Date.now() });
  // Oldest out first; Map keeps insertion order.
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/**
 * @returns {Promise<{name: string|null, cached: boolean}>} the place name, or
 *   null when it cannot be resolved (offline, rate-limited, sea).
 */
async function reverseGeocode(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { name: null, cached: false };

  const key = keyFor(lat, lng);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { name: hit.name, cached: true };

  // Politeness gap. A burst of pin drags waits rather than hammering a free
  // service that would (rightly) block us.
  const since = Date.now() - lastCallAt;
  if (since < MIN_GAP_MS) await new Promise((r) => setTimeout(r, MIN_GAP_MS - since));
  lastCallAt = Date.now();

  const url = `${ENDPOINT}?format=jsonv2&zoom=18&addressdetails=1&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    const data = await res.json();
    const name = shortName(data.address || {});
    // A miss is cached too: the sea does not acquire a name on a retry, and
    // retrying every pin drag is what the rate limit is there to stop.
    remember(key, name);
    return { name, cached: false };
  } catch (err) {
    console.warn("[geo] reverse geocode failed:", err.message);
    return { name: null, cached: false };
  }
}

module.exports = { reverseGeocode, shortName, keyFor, _cache: cache };
