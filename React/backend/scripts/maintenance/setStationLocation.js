/**
 * One-off: set the map location of ONE station from a latitude/longitude you
 * provide. Not a migration -- run it once for a station created before the
 * vendor form had a map pin (Step 2.1), then leave it.
 *
 *   node scripts/maintenance/setStationLocation.js --lat 18.5913 --lng 73.7389 --dry-run
 *   node scripts/maintenance/setStationLocation.js --lat 18.5913 --lng 73.7389 --apply
 *   node scripts/maintenance/setStationLocation.js --at "18.5913, 73.7389" --apply
 *       (--at takes the "lat, lng" text Google Maps copies on right-click)
 *
 * Options
 *   --station <id>          required when the database holds more than one station
 *   --dry-run               print what would change and write nothing (also the
 *                           default without --apply; wins over --apply)
 *   --apply                 write
 *   --backup-dir <dir>      where the pre-change backup goes (default backend/backups)
 *   --allow-outside-india   accept a point outside India (normally refused: it
 *                           almost always means latitude and longitude were swapped)
 *   --restore <backup.json> put back the values saved in a backup (with --apply)
 *
 * What --apply does, in order
 *   1. refuses (0, 0), out-of-range, outside-India and swapped-looking points
 *   2. writes a JSON backup of the station's current coordinates/location
 *   3. sets `coordinates` {lat, lng} and GeoJSON `location` {type: "Point",
 *      coordinates: [lng, lat]} together, only if neither changed since they
 *      were read -- no other field of the station is touched
 *   4. checks the 2dsphere index exists and that a $near query finds the station
 *
 * MONGO_URI from the environment wins over backend/.env, so the test database
 * can be used with MONGO_URI=mongodb://127.0.0.1:27017/fuelmart_test.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env"), quiet: true });
const mongoose = require("mongoose");

const INDIA = { minLat: 6, maxLat: 37.5, minLng: 68, maxLng: 97.5 };
const VALUE_OPTIONS = new Set(["lat", "lng", "at", "station", "backup-dir", "restore"]);

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument "${arg}"`);
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    if (VALUE_OPTIONS.has(key)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--${key} needs a value`);
      opts[key] = value;
    } else {
      flags.add(arg);
    }
  }
  return { opts, flags };
}

/** The target point from --lat/--lng or --at, validated. */
function targetPoint(opts, flags) {
  let rawLat = opts.lat;
  let rawLng = opts.lng;
  if (opts.at !== undefined) {
    const parts = String(opts.at).split(/[,\s]+/).filter(Boolean);
    if (parts.length !== 2) throw new UsageError('--at must look like "18.5913, 73.7389" (latitude, longitude)');
    [rawLat, rawLng] = parts;
  }
  if (rawLat === undefined || rawLng === undefined) {
    throw new UsageError("give the location with --lat <latitude> --lng <longitude> (or --at \"lat, lng\")");
  }
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new UsageError("latitude and longitude must be numbers");

  const Station = require("../../src/models/Station");
  if (!Station.isRealPosition(lat, lng)) {
    throw new UsageError(`(${lat}, ${lng}) is not a real position (out of range, or 0, 0)`);
  }

  const inIndia = (la, ln) => la >= INDIA.minLat && la <= INDIA.maxLat && ln >= INDIA.minLng && ln <= INDIA.maxLng;
  if (!inIndia(lat, lng) && !flags.has("--allow-outside-india")) {
    const swapped = inIndia(lng, lat) ? ` It looks swapped: did you mean --lat ${lng} --lng ${lat}?` : "";
    throw new UsageError(`(${lat}, ${lng}) is outside India.${swapped} Pass --allow-outside-india if it is really correct.`);
  }
  return { lat, lng };
}

const show = (v) => (v === undefined || v === null ? "none" : JSON.stringify(v));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function findStation(Station, stationId) {
  if (stationId) {
    if (!mongoose.isValidObjectId(stationId)) throw new UsageError(`--station "${stationId}" is not a valid id`);
    const doc = await Station.collection.findOne({ _id: new mongoose.Types.ObjectId(stationId) });
    if (!doc) throw new UsageError(`no station with id ${stationId}`);
    return doc;
  }
  const docs = await Station.collection.find({}, { projection: { name: 1, address: 1 } }).limit(21).toArray();
  if (docs.length === 0) throw new UsageError("the database has no stations");
  if (docs.length > 1) {
    const list = docs
      .slice(0, 20)
      .map((d) => `  ${d._id}  ${d.name}${d.address ? ` (${d.address})` : ""}`)
      .join("\n");
    throw new UsageError(`the database has more than one station; choose one with --station <id>:\n${list}`);
  }
  return Station.collection.findOne({ _id: docs[0]._id });
}

/** Set the pair only if it is still what was read; unset a field whose target is null. */
async function writeLocation(Station, doc, next) {
  const filter = { _id: doc._id };
  for (const field of ["coordinates", "location"]) {
    filter[field] = doc[field] === undefined || doc[field] === null ? { $exists: false } : doc[field];
  }
  const $set = { updatedAt: new Date() };
  const $unset = {};
  for (const field of ["coordinates", "location"]) {
    if (next[field] === null) $unset[field] = "";
    else $set[field] = next[field];
  }
  const update = Object.keys($unset).length ? { $set, $unset } : { $set };
  const result = await Station.collection.updateOne(filter, update);
  if (!result.modifiedCount) {
    throw new Error("the station's location changed after it was read; nothing was written");
  }
}

async function verify(Station, stationId, point) {
  const indexes = await Station.collection.indexes().catch(() => []);
  if (!indexes.some((i) => i.key && i.key.location === "2dsphere")) {
    console.log("WARNING: no 2dsphere index on stations.location, so nearest-station search cannot use it.");
    console.log("         The app builds it at startup; nothing else was changed by this script.");
    return;
  }
  // find(), not countDocuments(): $near is not allowed inside the aggregation countDocuments runs.
  const found = await Station.collection
    .find({
      _id: stationId,
      location: { $near: { $geometry: { type: "Point", coordinates: [point.lng, point.lat] }, $maxDistance: 50 } },
    })
    .limit(1)
    .hasNext();
  console.log(found ?"verified: a nearest-station ($near) query finds it at this point." : "WARNING: $near did not find the station.");
}

async function main() {
  const { opts, flags } = parseArgs(process.argv.slice(2));
  const apply = flags.has("--apply") && !flags.has("--dry-run");

  let restore = null;
  let point = null;
  if (opts.restore) {
    restore = JSON.parse(fs.readFileSync(path.resolve(opts.restore), "utf8"));
    if (!restore?.stationId || !restore.previous) throw new UsageError(`${opts.restore} is not a backup written by this script`);
    opts.station = opts.station || restore.stationId;
    if (String(opts.station) !== String(restore.stationId)) throw new UsageError("--station does not match the backup's station");
  } else {
    point = targetPoint(opts, flags);
  }

  const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/fuelmart";
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const Station = require("../../src/models/Station");
  const dbName = mongoose.connection.db.databaseName;
  console.log(`database: ${dbName}  mode: ${apply ? "APPLY" : "dry run"}`);

  const doc = await findStation(Station, opts.station);
  console.log(`station:  ${doc._id}  ${doc.name}${doc.address ? `  (${doc.address})` : ""}`);
  console.log(`now:      coordinates=${show(doc.coordinates)}  location=${show(doc.location)}`);

  const next = restore
    ? { coordinates: restore.previous.coordinates ?? null, location: restore.previous.location ?? null }
    : { coordinates: { lat: point.lat, lng: point.lng }, location: { type: "Point", coordinates: [point.lng, point.lat] } };
  console.log(`${restore ? "restore:" : "set:     "} coordinates=${show(next.coordinates)}  location=${show(next.location)}`);

  if (same(doc.coordinates, next.coordinates) && same(doc.location, next.location)) {
    console.log("already at this location: nothing to change.");
    return;
  }
  if (!apply) {
    console.log("dry run: nothing was written. Re-run with --apply to make this change.");
    return;
  }

  const backupDir = path.resolve(opts["backup-dir"] || path.join(__dirname, "..", "..", "backups"));
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(backupDir, `station-location-${doc._id}-${stamp}.json`);
  fs.writeFileSync(
    backupFile,
    `${JSON.stringify(
      {
        stationId: String(doc._id),
        stationName: doc.name,
        database: dbName,
        takenAt: new Date().toISOString(),
        previous: { coordinates: doc.coordinates ?? null, location: doc.location ?? null },
        undo: `node scripts/maintenance/setStationLocation.js --restore "${backupFile}" --apply`,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`backup:   ${backupFile}`);

  await writeLocation(Station, doc, next);
  console.log("written:  coordinates and location updated (no other field changed).");
  if (next.location) await verify(Station, doc._id, { lat: next.coordinates.lat, lng: next.coordinates.lng });
}

main()
  .catch((err) => {
    console.error(`${err instanceof UsageError ? "Refused" : "Failed"}: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
