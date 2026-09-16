/**
 * Reverse-geocode every Pune station that OSM did not give an address for,
 * and cache the answers on disk.
 *
 * Why it is needed: 151 of the 193 stations in the Overpass extract carry no
 * `addr:*` tags at all, and 120 of them share just 12 names -- 26 stations
 * called "Bharat Petroleum", 18 called "Shell". In a list of nearby stations
 * those are indistinguishable, and an address of "Pune, Maharashtra" tells a
 * customer nothing about which one they are booking. Reverse-geocoding turns
 * each into "Shell - Kharadi" on "Nagar Road, Kharadi, Pune 411014".
 *
 * The cache exists because Nominatim's usage policy is one request per second
 * and asks that bulk results be stored rather than re-queried. Re-running the
 * import therefore costs no requests at all; only genuinely new stations are
 * looked up.
 *
 * Usage:
 *   node scripts/import/buildGeocodeCache.js <overpass.json>
 */

const fs = require("fs");
const path = require("path");

const NOMINATIM = "https://nominatim.openstreetmap.org/reverse";
// Nominatim's policy: at most 1 request per second, and identify yourself.
const DELAY_MS = 1100;
const USER_AGENT = "FuelMart/1.0 (station data seeding; local project)";

const CACHE_PATH = path.join(__dirname, "..", "..", "data", "pune-geocode-cache.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1), "utf8");
}

/** Keep only the parts of a Nominatim answer that name a place. */
function distil(json) {
  const a = json.address || {};
  return {
    road: a.road || a.pedestrian || null,
    // Nominatim spells the neighbourhood differently depending on how the
    // area was mapped; take whichever is present, most specific first.
    suburb:
      a.neighbourhood || a.suburb || a.village || a.town || a.city_district || null,
    city: a.city || a.town || a.municipality || "Pune",
    postcode: a.postcode || null,
  };
}

async function reverse(lat, lng) {
  const url = `${NOMINATIM}?format=json&zoom=17&addressdetails=1&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  return distil(await res.json());
}

async function main() {
  const src = process.argv[2];
  if (!src) {
    console.error("usage: node scripts/import/buildGeocodeCache.js <overpass.json>");
    process.exit(1);
  }

  const elements = JSON.parse(fs.readFileSync(src, "utf8")).elements;
  const targets = [];
  for (const el of elements) {
    const tags = el.tags || {};
    if (!tags.name) continue;
    const lat = el.type === "node" ? el.lat : el.center && el.center.lat;
    const lng = el.type === "node" ? el.lon : el.center && el.center.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    targets.push({ key: `${el.type}/${el.id}`, lat, lng });
  }

  const cache = loadCache();
  const todo = targets.filter((t) => !cache[t.key]);

  console.log(`${targets.length} stations, ${Object.keys(cache).length} already cached`);
  console.log(`${todo.length} to look up (~${Math.ceil((todo.length * DELAY_MS) / 60000)} min at 1 req/s)\n`);

  let done = 0;
  let failed = 0;
  for (const t of todo) {
    try {
      cache[t.key] = await reverse(t.lat, t.lng);
      done++;
    } catch (err) {
      // One bad lookup must not lose the whole run's work; the station simply
      // keeps whatever address OSM gave it.
      cache[t.key] = { error: err.message };
      failed++;
    }
    if (done % 20 === 0 || done + failed === todo.length) {
      saveCache(cache);
      process.stdout.write(`  ${done + failed}/${todo.length}\r`);
    }
    await sleep(DELAY_MS);
  }

  saveCache(cache);
  console.log(`\nCached ${done} lookups (${failed} failed) -> ${CACHE_PATH}`);
}

main().catch((err) => {
  console.error("Geocode cache build failed:", err.message);
  process.exit(1);
});
