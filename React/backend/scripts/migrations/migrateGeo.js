/**
 * Backfill GeoJSON `location` from the legacy `coordinates` field and build
 * the 2dsphere index.
 *
 * Safe to re-run: it only writes stations whose `location` is missing or
 * disagrees with `coordinates`, and index creation is idempotent.
 *
 *   node scripts/migrations/migrateGeo.js
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const Station = require("../../src/models/Station");

(async () => {
  const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/fuelmart";
  await mongoose.connect(uri);
  console.log(`Connected to ${uri.replace(/\/\/[^@]*@/, "//<credentials>@")}`);

  const stations = await Station.find({}).select(
    "name coordinates location nozzles avgServiceMinutes slotCapacity availableTimeSlots",
  );
  console.log(`Found ${stations.length} station(s)\n`);

  let geoFixed = 0;
  let defaultsFilled = 0;
  let skipped = 0;

  for (const s of stations) {
    let touched = false;

    const lat = s.coordinates?.lat;
    const lng = s.coordinates?.lng;
    const hasLegacy = Number.isFinite(lat) && Number.isFinite(lng);
    const existing = s.location?.coordinates;
    const hasGeo = Array.isArray(existing) && existing.length === 2;

    if (hasLegacy && (!hasGeo || existing[0] !== lng || existing[1] !== lat)) {
      s.location = { type: "Point", coordinates: [lng, lat] };
      geoFixed++;
      touched = true;
      console.log(`  geo   ${s.name}: [${lng}, ${lat}]`);
    } else if (!hasLegacy && !hasGeo) {
      console.log(`  SKIP  ${s.name}: no coordinates — will not appear in radius search`);
      skipped++;
    }

    // Queueing parameters the M/M/c model needs. Older stations predate these
    // fields entirely, and an undefined nozzle count would model the station
    // as a single-server queue and badly over-estimate the wait.
    if (!Number.isFinite(s.nozzles)) {
      s.nozzles = 4;
      touched = true;
      defaultsFilled++;
    }
    if (!Number.isFinite(s.avgServiceMinutes)) {
      s.avgServiceMinutes = 5;
      touched = true;
    }
    if (!Number.isFinite(s.slotCapacity)) {
      s.slotCapacity = 4;
      touched = true;
    }
    if (!s.availableTimeSlots?.length) {
      s.availableTimeSlots = defaultSlots();
      touched = true;
    }

    if (touched) await s.save();
  }

  console.log("\nBuilding indexes...");
  await ensureIndex({ location: "2dsphere" }, { sparse: true }, "location_2dsphere");
  await ensureIndex({ status: 1, updatedAt: -1 }, {}, "status_1_updatedAt_-1");
  console.log("Indexes ready.");

  const indexes = await Station.collection.indexes();
  console.log("\nStation indexes:");
  indexes.forEach((i) => console.log(`  ${i.name}  ${JSON.stringify(i.key)}`));

  console.log(
    `\nDone. geo backfilled: ${geoFixed}, defaults filled: ${defaultsFilled}, skipped (no coords): ${skipped}`,
  );

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

/**
 * Create an index, tolerating one that already exists under the same name but
 * with different options. Mongo raises IndexKeySpecsConflict (86) rather than
 * silently reconciling, so the only way to change options is drop-then-create.
 */
async function ensureIndex(keys, options, name) {
  try {
    await Station.collection.createIndex(keys, options);
    console.log(`  created ${name}`);
  } catch (err) {
    if (err.code !== 86) throw err;
    console.log(`  ${name} exists with different options - recreating`);
    await Station.collection.dropIndex(name);
    await Station.collection.createIndex(keys, options);
    console.log(`  recreated ${name}`);
  }
}

/** 6:00 AM to 9:30 PM in 30-minute increments. */
function defaultSlots() {
  const slots = [];
  for (let h = 6; h <= 21; h++) {
    for (const m of ["00", "30"]) {
      const hour12 = h % 12 === 0 ? 12 : h % 12;
      slots.push(`${hour12}:${m} ${h < 12 ? "AM" : "PM"}`);
    }
  }
  return slots;
}
