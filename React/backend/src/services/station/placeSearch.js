/**
 * A typed place -> coordinates ("Wagholi, Pune" -> 18.5805, 73.9753).
 *
 * The other half of services/station/reverseGeocode.js, and written to the
 * same three rules, which are Nominatim's own usage policy:
 *
 *   1. Called from the SERVER, never from every phone: one identifiable
 *      client, one cache, no key or CORS problem in the browser bundle.
 *   2. Answers are cached by the normalised query, so a customer typing
 *      "wagh", "waghol", "wagholi" does not make three requests per keystroke
 *      reach the service (the client debounces as well).
 *   3. At most one request per second leaves this process, and a failure is
 *      never fatal -- the caller is told "no matches", and the map is still
 *      there to set the point by hand.
 *
 * WHY THIS EXISTS AT ALL
 *
 * A customer who refuses location permission, or whose phone cannot get a
 * fix indoors, still has to be able to say where they are. Until now the only
 * answer was "tap the map", which is fine on a desktop and awkward on a phone
 * in a moving car. This lets them type it.
 *
 * It searches PLACES, not stations. Which pumps are near the place they chose
 * is a database question, answered by services/station/discovery.js from the
 * stations actually in the database -- nothing here invents a station.
 */

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // place names are stable for a session
const CACHE_MAX = 300;
const MIN_GAP_MS = 1100; // Nominatim asks for <= 1 request/second
const TIMEOUT_MS = 4500;
const MAX_RESULTS = 6;

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const USER_AGENT =
  process.env.GEOCODER_USER_AGENT || "FuelMart/1.0 (student project; fuel booking app)";

/**
 * Where to look.
 *
 * India by default, because that is where the stations are -- a customer
 * typing "Nagar Road" means the one in Pune, not the one in another country.
 * GEOCODER_COUNTRY_CODES overrides it (comma-separated ISO codes) without a
 * code change, and an empty value searches the whole world.
 */
const COUNTRY_CODES = process.env.GEOCODER_COUNTRY_CODES ?? "in";

/** query -> { results, at }. Bounded; this is a convenience, not a store. */
const cache = new Map();
let lastCallAt = 0;

/** The cache key: trimmed, collapsed, lower case. "  Baner  Road " -> "baner road". */
const keyFor = (query) => String(query || "").trim().replace(/\s+/g, " ").toLowerCase();

function remember(key, results) {
  cache.set(key, { results, at: Date.now() });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); // oldest out
}

/**
 * One Nominatim row as the app needs it.
 *
 * `label` is what the customer reads in the list and `name` is the short form
 * the dashboard chip shows once it is chosen; both come from the service, so
 * nothing is invented here either.
 */
function shape(row) {
  // Number(null) and Number("") are both 0, and (0, 0) is a point in the
  // Atlantic -- the exact fake coordinate this project refuses everywhere
  // else (models/Station.js isRealPosition). A row missing either value is
  // dropped rather than placed in the sea.
  const num = (v) => (v === null || v === undefined || String(v).trim() === "" ? NaN : Number(v));
  const lat = num(row?.lat);
  const lng = num(row?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;

  const full = String(row.display_name || "").trim();
  // "Wagholi, Haveli, Pune District, Maharashtra, 412207, India" is accurate
  // and unreadable in a list; the first two parts are what a person says.
  const parts = full.split(",").map((p) => p.trim()).filter(Boolean);
  const name = parts.slice(0, 2).join(", ") || full || null;

  return { name, label: full || name, lat, lng, type: row.type || row.class || null };
}

/**
 * Places matching `query`.
 *
 * @returns {Promise<{results: Array<{name, label, lat, lng, type}>, cached: boolean}>}
 *   An empty list for a query that matches nothing, AND for a failure: the
 *   caller cannot act differently on the two, and the map is the fallback in
 *   both cases. Failures are logged rather than thrown.
 */
async function searchPlaces(query) {
  const key = keyFor(query);
  // Two characters match half of India; below that it is not a search.
  if (key.length < 3) return { results: [], cached: false };

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { results: hit.results, cached: true };

  const since = Date.now() - lastCallAt;
  if (since < MIN_GAP_MS) await new Promise((r) => setTimeout(r, MIN_GAP_MS - since));
  lastCallAt = Date.now();

  const params = new URLSearchParams({
    format: "jsonv2",
    addressdetails: "0",
    limit: String(MAX_RESULTS),
    q: key,
  });
  if (COUNTRY_CODES) params.set("countrycodes", COUNTRY_CODES);

  try {
    const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    const rows = await res.json();
    const results = (Array.isArray(rows) ? rows : []).map(shape).filter(Boolean).slice(0, MAX_RESULTS);
    // A miss is cached too: a query that matches nothing will not start
    // matching something on the next keystroke, and retrying is what the
    // rate limit exists to prevent.
    remember(key, results);
    return { results, cached: false };
  } catch (err) {
    console.warn("[geo] place search failed:", err.message);
    return { results: [], cached: false };
  }
}

module.exports = { searchPlaces, shape, keyFor, MAX_RESULTS, _cache: cache };
