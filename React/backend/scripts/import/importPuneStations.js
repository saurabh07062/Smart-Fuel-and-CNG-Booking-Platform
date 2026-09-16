/**
 * Import every fuel station in the Pune region into the Station collection.
 *
 * Where the data comes from
 * -------------------------
 * OpenStreetMap, via the Overpass API, filtered to `amenity=fuel` inside the
 * Pune metropolitan bounding box. That matters more than convenience: OSM
 * positions are surveyed on the ground, so a station's coordinates actually
 * land on its forecourt. Hand-typed coordinates are how this project ended up
 * routing a customer to a scrap yard in Wagholi, and how six of the CNG
 * stations already in this database got coordinates in Model Colony while
 * their addresses say Kothrud, Bavdhan and Dhankawadi.
 *
 * OSM data is © OpenStreetMap contributors, ODbL 1.0. Attribution is stored
 * on each row (`source: "osm"`, `osmId`) and belongs in any UI that shows a
 * map built from it.
 *
 * What is real and what is a default
 * ----------------------------------
 * Real, from OSM:  name, brand/operator, coordinates, address parts, and the
 *                  fuel types wherever the station is tagged with them.
 * Real, from Nominatim: the road and locality for the 151 stations OSM gives
 *                  no address for at all, reverse-geocoded once and cached in
 *                  data/pune-geocode-cache.json. Without this, 120 of the 193
 *                  stations share just 12 names -- twenty-six of them called
 *                  "Bharat Petroleum" at "Pune, Maharashtra" -- which is not
 *                  something a customer can choose between.
 * Seeded defaults: prices, inventory, pump counts, slot capacity, amenities
 *                  and the operating schedule. OSM does not carry any of
 *                  those. Prices are one city-wide figure (see PRICES) and
 *                  are meant to be overwritten by each vendor from their own
 *                  panel -- they are a starting point, not a live rate.
 *
 * Re-running
 * ----------
 * Idempotent. Rows are keyed on `osmId`, so a second run updates rather than
 * duplicates. Vendor-owned edits are preserved: once a station has an
 * `owner`, the import refreshes only its position and leaves prices,
 * inventory and hours alone -- re-importing must never overwrite a real
 * vendor's real prices.
 *
 * Usage:
 *   node scripts/import/importPuneStations.js              # fetch + import
 *   node scripts/import/importPuneStations.js --dry-run    # report, write nothing
 *   node scripts/import/importPuneStations.js --cache f.json  # use a saved response
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Station = require("../../src/models/Station");

// Pune metropolitan region: PCMC and Hinjewadi in the north-west through
// Wagholi and Hadapsar in the east, Katraj in the south.
const BBOX = { south: 18.35, west: 73.65, north: 18.72, east: 74.12 };

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// Built by scripts/buildGeocodeCache.js. Absent is fine -- stations then keep
// whatever address OSM tagged them with.
const GEOCODE_CACHE_PATH = path.join(__dirname, "..", "..", "data", "pune-geocode-cache.json");
let GEOCODE = {};
try {
  GEOCODE = JSON.parse(fs.readFileSync(GEOCODE_CACHE_PATH, "utf8"));
} catch {
  console.warn("  (no geocode cache — run scripts/buildGeocodeCache.js for real addresses)");
}

// Pune retail rates used as the seeded starting point. One figure for the
// whole city because Indian pump prices are set by the OMCs per city and vary
// only by a few paise of dealer commission -- inventing per-station variation
// would be fiction. Vendors change these from their own panel.
const PRICES = { petrol: 105.4, diesel: 91.9, cng: 88.5 };
const PRICES_AS_OF = "2026-09-08";

const DEFAULT_SLOTS = [
  "6:00 AM", "7:00 AM", "8:00 AM", "9:00 AM", "10:00 AM", "11:00 AM",
  "12:00 PM", "1:00 PM", "2:00 PM", "3:00 PM", "4:00 PM", "5:00 PM",
  "6:00 PM", "7:00 PM", "8:00 PM", "9:00 PM",
];

// Two stations closer than this with a comparable name are the same forecourt
// mapped twice. 150m is wider than a forecourt and narrower than the gap
// between two real neighbouring pumps on the same road.
const DEDUPE_METRES = 150;

// ---------------------------------------------------------------- helpers

function haversineMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Lowercase alphanumerics only, so "HP Petrol Pump" ~ "hp petrol pump". */
function nameKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Do two station names plausibly refer to the same place? */
function namesOverlap(a, b) {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

const BRAND_CANON = [
  [/hindustan|hpcl|^hp$|\bhp\b/i, "HPCL"],
  [/bharat|bpcl|pure for sure/i, "BPCL"],
  [/indian\s*oil|indianoil|iocl/i, "Indian Oil"],
  [/shell/i, "Shell"],
  [/reliance|jio/i, "Reliance"],
  [/nayara|essar/i, "Nayara Energy"],
  [/mngl|maharashtra natural gas/i, "MNGL"],
  [/torrent/i, "Torrent Gas"],
  [/petrom/i, "Petrom"],
];

function canonicalBrand(tags) {
  const raw = tags.brand || tags.operator || tags.name || "";
  for (const [re, label] of BRAND_CANON) if (re.test(raw)) return label;
  return tags.brand ? String(tags.brand).trim() : null;
}

/**
 * Work out what a station actually sells.
 *
 * OSM tags fuel types inconsistently -- `fuel:petrol`, `fuel:octane_91/95/98`
 * and `fuel:Petrol` all mean petrol. Where a station carries no fuel tags at
 * all, an `amenity=fuel` node in India is a petrol pump selling petrol and
 * diesel; that is the safe assumption, because listing a fuel the station
 * does not have is worse than omitting one it does. A station whose name says
 * CNG and which has no liquid-fuel tag is treated as CNG-only for the same
 * reason.
 */
function resolveFuelTypes(tags) {
  const yes = (k) => String(tags[k] || "").toLowerCase() === "yes";
  const types = [];

  const hasPetrol =
    yes("fuel:petrol") || yes("fuel:Petrol") ||
    Object.keys(tags).some((k) => /^fuel:octane_\d+$/.test(k) && yes(k));
  const hasDiesel = yes("fuel:diesel") || yes("fuel:HGV_diesel") || yes("fuel:GTL_diesel");
  const hasCng = yes("fuel:cng");

  if (hasPetrol) types.push("Petrol");
  if (hasDiesel) types.push("Diesel");
  if (hasCng) types.push("CNG");

  if (types.length) return types;

  // Nothing tagged: fall back on the name.
  const name = String(tags.name || "");
  const cngOnly = /\bcng\b/i.test(name) && !/petrol|diesel/i.test(name);
  if (cngOnly) return ["CNG"];
  return ["Petrol", "Diesel"];
}

/**
 * Names that identify a chain rather than a station.
 *
 * Twenty-six stations in this extract are called "Bharat Petroleum" and
 * eighteen are called "Shell". Shown in a list of nearby stations they are
 * indistinguishable, and picking the wrong one is exactly the failure this
 * data is supposed to prevent. Any name that is only a brand gets its
 * locality appended.
 */
// The chains that appear in this extract. A station named after nothing but
// one of these is not identifiable on its own.
const CHAINS = [
  "hp", "hpcl", "bpcl", "iocl", "mngl", "shell", "reliance", "nayara", "essar",
  "hindustan petroleum", "bharat petroleum", "indian oil", "indianoil",
  "torrent gas", "petrol pump", "fuel station", "petrol station", "cng",
];
// ...optionally followed by a generic noun: "Indian Oil Petrol Pump".
const CHAIN_SUFFIX = /\s*(petrol|fuel|gas|cng)?\s*(pump|station|centre|center)?$/i;

function isGenericName(name, brand) {
  const n = String(name || "").trim();
  // Strip a trailing "Petrol Pump" / "Fuel Station" and see if a chain name
  // is all that is left.
  const stem = nameKey(n.replace(CHAIN_SUFFIX, ""));
  if (!stem) return true;
  if (CHAINS.some((c) => nameKey(c) === stem)) return true;
  // "Indian Oil" where the brand is also "Indian Oil" says nothing extra.
  return Boolean(brand) && nameKey(n) === nameKey(brand);
}

// Nominatim sometimes answers with an administrative unit rather than a
// place people use ("Ward 3"). Naming a station after one helps nobody.
const USELESS_LOCALITY = /^(ward\s*\d+|zone\s*\d+|block\s*[a-z0-9]+)$/i;

function localityFor(tags, geo, preferRoad) {
  const suburb =
    tags["addr:suburb"] ||
    tags["addr:province"] ||
    tags["addr:neighbourhood"] ||
    (geo && geo.suburb);
  const road = tags["addr:street"] || (geo && geo.road);
  const order = preferRoad ? [road, suburb] : [suburb, road];
  return order.find((v) => v && !USELESS_LOCALITY.test(String(v).trim())) || null;
}

/** Append the locality to a name that does not identify one station. */
function qualifyName(name, tags, geo, preferRoad) {
  if (!isGenericName(name, canonicalBrand(tags))) return name;
  const locality = localityFor(tags, geo, preferRoad);
  if (!locality) return name;
  // Do not produce "Shell - Shell" or repeat a locality already in the name.
  if (nameKey(name).includes(nameKey(locality))) return name;
  return `${name} - ${locality}`;
}

function buildAddress(tags, geo) {
  const parts = [
    tags["addr:housenumber"],
    tags["addr:street"] || (geo && geo.road),
    tags["addr:suburb"] || tags["addr:province"] || tags["addr:neighbourhood"] ||
      (geo && geo.suburb),
    tags["addr:city"] || (geo && geo.city) || "Pune",
    tags["addr:postcode"] || (geo && geo.postcode),
  ].filter(Boolean);

  // De-duplicate repeated locality names ("Pune, Pune").
  const seen = new Set();
  const clean = parts.filter((p) => {
    const k = nameKey(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (clean.length <= 1) return "Pune, Maharashtra";
  return clean.join(", ");
}

/**
 * Map OSM `opening_hours` onto the model's day-wise schedule.
 *
 * Only the two forms that actually appear in this dataset are interpreted:
 * "24/7" and a plain "HH:MM-HH:MM". Anything more exotic falls back to 24h
 * rather than being half-parsed into a schedule that quietly closes a station
 * that is really open.
 */
function buildSchedule(openingHours) {
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  let day = { open: "06:00", close: "22:00", is24h: true, isClosed: false };

  const oh = String(openingHours || "").trim();
  const range = oh.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (range) {
    const pad = (t) => (t.length === 4 ? "0" + t : t);
    day = { open: pad(range[1]), close: pad(range[2]), is24h: false, isClosed: false };
  }

  const schedule = {};
  for (const d of days) schedule[d] = { ...day };
  return schedule;
}

/** Pump counts scale with what the station sells, not with a flat guess. */
function pumpCountsFor(fuelTypes) {
  return {
    petrol: fuelTypes.includes("Petrol") ? 2 : 0,
    diesel: fuelTypes.includes("Diesel") ? 2 : 0,
    cng: fuelTypes.includes("CNG") ? 2 : 0,
  };
}

function pricesFor(fuelTypes) {
  return {
    petrol: fuelTypes.includes("Petrol") ? PRICES.petrol : 0,
    diesel: fuelTypes.includes("Diesel") ? PRICES.diesel : 0,
    cng: fuelTypes.includes("CNG") ? PRICES.cng : 0,
  };
}

function inventoryFor(fuelTypes) {
  return {
    petrol: fuelTypes.includes("Petrol") ? 20000 : 0,
    diesel: fuelTypes.includes("Diesel") ? 20000 : 0,
    cng: fuelTypes.includes("CNG") ? 8000 : 0,
  };
}

// ------------------------------------------------------------------ fetch

async function fetchOverpass() {
  const query = `[out:json][timeout:90];
(
  node["amenity"="fuel"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  way["amenity"="fuel"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
);
out center tags;`;

  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(query),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
  return res.json();
}

/** OSM elements -> the shape this project stores. */
function normalise(elements) {
  const out = [];
  const seenOsm = new Set();

  for (const el of elements) {
    const tags = el.tags || {};
    // An unnamed pump cannot be shown to a customer or searched for, so it is
    // not useful as a bookable station.
    if (!tags.name) continue;

    const lat = el.type === "node" ? el.lat : el.center && el.center.lat;
    const lng = el.type === "node" ? el.lon : el.center && el.center.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const osmId = `${el.type}/${el.id}`;
    if (seenOsm.has(osmId)) continue;
    seenOsm.add(osmId);

    const geo = GEOCODE[osmId] && !GEOCODE[osmId].error ? GEOCODE[osmId] : null;
    const fuelTypes = resolveFuelTypes(tags);
    const brand = canonicalBrand(tags);
    const name = qualifyName(String(tags.name).trim(), tags, geo);
    const rawName = String(tags.name).trim();

    out.push({
      osmId,
      name,
      brand,
      address: buildAddress(tags, geo),
      city: tags["addr:city"] || (geo && geo.city) || "Pune",
      state: "Maharashtra",
      coordinates: { lat, lng },
      fuelTypes,
      openingHours: tags.opening_hours === "24/7" ? "24 Hours" : tags.opening_hours || "24 Hours",
      operatingSchedule: buildSchedule(tags.opening_hours),
      prices: pricesFor(fuelTypes),
      inventory: inventoryFor(fuelTypes),
      pumpCounts: pumpCountsFor(fuelTypes),
      nozzles: Math.max(
        2,
        Object.values(pumpCountsFor(fuelTypes)).reduce((a, b) => a + b, 0),
      ),
      slotCapacity: 4,
      availableTimeSlots: DEFAULT_SLOTS,
      amenities: ["Air", "Water", "Restroom"],
      status: "Active",
      source: "osm",
      sourceUpdatedAt: new Date(),
      _tagCount: Object.keys(tags).length,
      _tags: tags,
      _geo: geo,
      _rawName: rawName,
    });
  }
  return disambiguate(dedupeCandidates(out));
}

/**
 * Second naming pass: three different Indian Oil pumps really do sit in
 * Dattawadi, so qualifying by suburb alone still leaves them identical in a
 * list. Anything still sharing a name is re-qualified by its road, and what
 * remains after that gets a numeric suffix so no two rows are ever the same
 * string -- a customer must always be able to tell which one they picked.
 */
function disambiguate(list) {
  const byName = new Map();
  for (const c of list) {
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c);
  }

  for (const [, group] of byName) {
    if (group.length < 2) continue;
    for (const c of group) {
      c.name = qualifyName(c._rawName, c._tags, c._geo, true);
    }
  }

  // Anything still colliding after the road pass.
  const seen = new Map();
  for (const c of list) {
    const n = seen.get(c.name) || 0;
    seen.set(c.name, n + 1);
    if (n > 0) c.name = `${c.name} (${n + 1})`;
  }

  for (const c of list) {
    delete c._tags;
    delete c._geo;
    delete c._rawName;
  }
  return list;
}

/**
 * Collapse one forecourt mapped more than once in OSM.
 *
 * A station is frequently present as both a node and a way (the building
 * outline), a few metres apart -- fifteen such pairs in this extract, some
 * only 3m apart. Importing both puts the same pump in the customer's list
 * twice, which reads as a bug. The richer record wins: more tags means more
 * of the fuel types, hours and address are real rather than defaulted.
 */
function dedupeCandidates(list) {
  const kept = [];
  const dropped = [];

  const sorted = list.slice().sort((a, b) => b._tagCount - a._tagCount);
  for (const c of sorted) {
    const twin = kept.find(
      (k) =>
        haversineMetres(
          k.coordinates.lat, k.coordinates.lng,
          c.coordinates.lat, c.coordinates.lng,
        ) <= DEDUPE_METRES && namesOverlap(k.name, c.name),
    );
    if (twin) dropped.push(`${c.osmId} (${c.name}) -> ${twin.osmId}`);
    else kept.push(c);
  }

  if (dropped.length) {
    console.log(`  ${dropped.length} duplicate OSM entries collapsed into their twin`);
  }
  for (const k of kept) delete k._tagCount;
  return kept;
}

// ----------------------------------------------------------------- import

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const cacheIdx = argv.indexOf("--cache");
  const cachePath = cacheIdx >= 0 ? argv[cacheIdx + 1] : null;

  console.log(`Pune station import${dryRun ? " (DRY RUN — nothing will be written)" : ""}`);
  console.log(`  bbox ${BBOX.south},${BBOX.west} .. ${BBOX.north},${BBOX.east}`);

  const raw = cachePath
    ? JSON.parse(fs.readFileSync(path.resolve(cachePath), "utf8"))
    : await fetchOverpass();
  console.log(`  ${raw.elements.length} OSM elements returned`);

  const candidates = normalise(raw.elements);
  console.log(`  ${candidates.length} named, positioned stations after normalisation`);

  await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/fuelmart");

  const existing = await Station.find({}).select(
    "name coordinates osmId owner source",
  );
  console.log(`  ${existing.length} stations already in the database\n`);

  const stats = { created: 0, updated: 0, matched: 0, skipped: 0, pruned: 0, keptStale: 0 };

  for (const c of candidates) {
    // 1. Same OSM id -> the same row, always.
    let doc = existing.find((e) => e.osmId === c.osmId);

    // 2. Otherwise, a manually-created station on the same forecourt with a
    //    comparable name. Adopting it rather than inserting a second row is
    //    what stops the import duplicating the twelve stations that are
    //    already here.
    if (!doc) {
      doc = existing.find((e) => {
        if (e.osmId) return false;
        const lat = e.coordinates && e.coordinates.lat;
        const lng = e.coordinates && e.coordinates.lng;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
        const d = haversineMetres(lat, lng, c.coordinates.lat, c.coordinates.lng);
        return d <= DEDUPE_METRES && namesOverlap(e.name, c.name);
      });
      if (doc) stats.matched++;
    }

    if (dryRun) {
      if (!doc) stats.created++;
      else stats.updated++;
      continue;
    }

    if (!doc) {
      await Station.create(c);
      stats.created++;
      continue;
    }

    // A vendor owns this station: they are the authority on their own prices,
    // stock and hours. Refresh only what OSM is actually better at.
    const vendorOwned = Boolean(doc.owner);
    const update = vendorOwned
      ? {
          coordinates: c.coordinates,
          osmId: c.osmId,
          brand: doc.brand || c.brand,
          sourceUpdatedAt: c.sourceUpdatedAt,
        }
      : { ...c };

    Object.assign(doc, update);
    await doc.save(); // save(), not updateOne(): the pre-save hook syncs GeoJSON
    stats.updated++;
    if (vendorOwned) stats.skipped++;
  }

  // Rows imported by an earlier run whose OSM id is no longer in the extract:
  // either the duplicate-collapsing above now folds them into a twin, or the
  // station was removed from OSM. They are import artefacts, so they go --
  // but never one a vendor has claimed or a customer has booked, which would
  // orphan real records.
  if (!dryRun) {
    const liveIds = new Set(candidates.map((c) => c.osmId));
    const stale = await Station.find({
      source: "osm",
      osmId: { $nin: [...liveIds] },
      owner: { $in: [null, undefined] },
    }).select("_id name osmId");

    if (stale.length) {
      const Booking = require("../../src/models/Booking");
      for (const st of stale) {
        const booked = await Booking.countDocuments({ station: st._id });
        if (booked > 0) {
          console.log(`  kept ${st.name} (${st.osmId}) — has ${booked} booking(s)`);
          stats.keptStale++;
          continue;
        }
        await Station.deleteOne({ _id: st._id });
        stats.pruned++;
      }
    }
  }

  console.log("Result");
  console.log(`  created            ${stats.created}`);
  console.log(`  updated            ${stats.updated}`);
  console.log(`    of which matched to an existing manual station: ${stats.matched}`);
  console.log(`    of which vendor-owned (position only):          ${stats.skipped}`);
  console.log(`  pruned (stale osm rows) ${stats.pruned}`);

  if (!dryRun) {
    const total = await Station.countDocuments({});
    const active = await Station.countDocuments({ status: "Active" });
    const withGeo = await Station.countDocuments({ "location.coordinates.0": { $exists: true } });
    console.log(`\n  ${total} stations total, ${active} active, ${withGeo} with a GeoJSON position`);
    console.log(`  prices seeded at Pune rates as of ${PRICES_AS_OF} — vendors override these`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Import failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
