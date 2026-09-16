/**
 * Audit every station's coordinates against the address it claims, and
 * quarantine the ones that disagree.
 *
 * Why this exists
 * ---------------
 * A station row can carry a perfectly good address and a coordinate pair that
 * points somewhere else entirely. Nothing in the app notices: the address is
 * only ever displayed, while the coordinates are what the map, the distance
 * ranking and the "Navigate" link all use. The customer is then routed to a
 * completely different place -- which is exactly how a booking at the Wagholi
 * HP pump ended up navigating to a scrap yard.
 *
 * Six of the CNG stations seeded into this database had this defect. Their
 * addresses read Kothrud, Bavdhan, Dhankawadi, Mundhwa, Dhayari and Manjri;
 * their coordinates all landed within about a kilometre of each other in
 * central Pune (Model Colony, Navi Peth, Mukund Nagar, Erandwane). Verified by
 * reverse-geocoding each stored coordinate against Nominatim.
 *
 * What this script does about it
 * ------------------------------
 * All six are taken offline (status Inactive), for one of two reasons:
 *
 *   - DUPLICATE: the same forecourt is already in the database, imported from
 *     OpenStreetMap with a surveyed position. Keeping the broken row would
 *     mean two rows for one station, one of them wrong.
 *   - UNVERIFIED: the real position could not be established from any source.
 *     Guessing a forecourt's coordinates is what caused this problem in the
 *     first place, so nothing is guessed here. An offline station is a visible
 *     gap; a mis-located one sends a customer to the wrong side of the city.
 *
 * Nothing is deleted. Reversing a quarantine is a one-line status change once
 * someone confirms the real position (the vendor panel's map picker is the
 * intended way to set it).
 *
 * Usage:
 *   node scripts/maintenance/auditStationCoordinates.js --dry-run
 *   node scripts/maintenance/auditStationCoordinates.js
 *   node scripts/maintenance/auditStationCoordinates.js --restore   # undo the quarantine
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Station = require("../../src/models/Station");

// Locality centres from Nominatim, used to state how far off each stored
// coordinate is. Not used to reposition anything -- a locality centre is not
// a forecourt.
const LOCALITIES = {
  "Dhayari Phata": [18.4589198, 73.8093956],
  Kothrud: [18.5072618, 73.8056676],
  Bavdhan: [18.5209541, 73.777087],
  Mundhwa: [18.5343218, 73.9298264],
  Dhankawadi: [18.4654198, 73.850152],
  Manjri: [18.5055914, 73.962205],
};

/**
 * The stations found to be mis-located, each with the reason it is taken
 * offline and what was actually established about it. The `note` is the
 * evidence -- so anyone reversing one of these can see what would have to be
 * confirmed first.
 */
const FINDINGS = [
  {
    match: /Rathi CNG/i,
    locality: "Dhankawadi",
    reason: "DUPLICATE",
    // The imported OSM row "Rathi Cng gas Station" (way/360256873) carries the
    // same business name, the same road and the same 411046 pincode, and sells
    // CNG. Same forecourt, correctly positioned -- so this row is redundant
    // rather than repairable.
    note: 'already in the database as "Rathi Cng gas Station" (osm way/360256873) at 18.45399, 73.85349',
  },
  {
    match: /SAI SAYAJI CNG PUMP MNGL/i,
    locality: "Kothrud",
    reason: "UNVERIFIED",
    note: 'nearest Kothrud candidate is an OSM node named only "MNGL" - brand matches, business name does not',
  },
  {
    match: /LONKAR CNG STATION/i,
    locality: "Mundhwa",
    reason: "UNVERIFIED",
    note: 'nearest Mundhwa CNG station in OSM is "Gaikwad CNG station" - a different business',
  },
  {
    match: /Natural Gas Ltd CNG Station$/i,
    address: /Bavdhan/i,
    locality: "Bavdhan",
    reason: "UNVERIFIED",
    note: 'nearest Bavdhan CNG station in OSM is "LMD CNG" - a different business',
  },
  {
    match: /Maharashtra Natural Gas Ltd CNG Station$/i,
    address: /Dhayari|Narhe|Mokarwadi/i,
    locality: "Dhayari Phata",
    reason: "UNVERIFIED",
    note: "no CNG station within 2 km of Dhayari Phata in OSM",
  },
  {
    match: /Maharashtra Natural Gas Ltd CNG Station$/i,
    address: /Manjri|Hadapsar/i,
    locality: "Manjri",
    reason: "UNVERIFIED",
    note: "no CNG station within 2 km of Manjri in OSM",
  },
];

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const restore = argv.includes("--restore");

  await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/fuelmart");

  if (restore) {
    const names = [];
    for (const f of FINDINGS) {
      const q = { name: f.match, source: { $ne: "osm" } };
      if (f.address) q.address = f.address;
      const docs = await Station.find(q);
      for (const d of docs) {
        d.status = "Active";
        await d.save();
        names.push(d.name);
      }
    }
    console.log(`Reactivated ${names.length} station(s):`);
    names.forEach((n) => console.log(`  - ${n}`));
    await mongoose.disconnect();
    return;
  }

  console.log(`Station coordinate audit${dryRun ? " (DRY RUN — nothing will be written)" : ""}\n`);

  let duplicates = 0;
  let unverified = 0;

  for (const f of FINDINGS) {
    const q = { name: f.match, source: { $ne: "osm" } };
    if (f.address) q.address = f.address;
    const docs = await Station.find(q);

    if (docs.length === 0) {
      console.log(`  (no match for ${f.match} — already handled?)`);
      continue;
    }

    for (const doc of docs) {
      const centre = LOCALITIES[f.locality];
      const off =
        centre && doc.coordinates && Number.isFinite(doc.coordinates.lat)
          ? haversineKm(doc.coordinates.lat, doc.coordinates.lng, centre[0], centre[1])
          : null;

      console.log(`  ${doc.name}`);
      console.log(`    address says   ${f.locality}`);
      console.log(
        `    stored coords  ${doc.coordinates.lat}, ${doc.coordinates.lng}` +
          (off !== null ? `  (${off.toFixed(1)} km away)` : ""),
      );

      console.log(`    -> OFFLINE (${f.reason}) — ${f.note}`);
      if (!dryRun) {
        doc.status = "Inactive";
        await doc.save();
      }
      if (f.reason === "DUPLICATE") duplicates++;
      else unverified++;
      console.log("");
    }
  }

  console.log(`Taken offline as duplicates:            ${duplicates}`);
  console.log(`Taken offline with unverified position: ${unverified}`);
  console.log(`Reverse either with --restore.`);

  if (!dryRun) {
    const active = await Station.countDocuments({ status: "Active" });
    console.log(`\n${active} stations active and bookable.`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Audit failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
