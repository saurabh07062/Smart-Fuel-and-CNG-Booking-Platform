/**
 * One app nozzle per fuel: replace the station-wide nozzle indexes on
 * bookings with per-fuel ones, and build the walk-in indexes.
 *
 *   node scripts/migrations/perFuelNozzleIndexes.js           dry run (default)
 *   node scripts/migrations/perFuelNozzleIndexes.js --apply   build, then drop
 *
 * Changes indexes only -- no document is modified or deleted.
 *
 *   uniq_active_nozzle_start  (station, bookingStartTime)   -> dropped
 *   uniq_serving_per_station  (station)                     -> dropped
 *   uniq_active_nozzle_start_per_fuel (station, fuelType, bookingStartTime)  built
 *   uniq_serving_per_station_fuel     (station, fuelType)                    built
 *
 * The new indexes are built BEFORE the old ones are dropped, so the database
 * is never without a double-booking guard; if a new index cannot be built
 * (existing data conflicts), nothing is dropped. MONGO_URI from the
 * environment wins over backend/.env, so the test database can be migrated
 * with MONGO_URI=mongodb://127.0.0.1:27017/fuelmart_test.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const OLD_INDEXES = ["uniq_active_nozzle_start", "uniq_serving_per_station"];
const NEW_INDEXES = ["uniq_active_nozzle_start_per_fuel", "uniq_serving_per_station_fuel"];
const apply = process.argv.includes("--apply");

async function main() {
  const uri = process.env.MONGO_URI || "mongodb://localhost:27017/fuelmart";
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const Booking = require("../../src/models/Booking");
  const WalkIn = require("../../src/models/WalkIn");
  const db = mongoose.connection.db;
  console.log(`database: ${db.databaseName}  mode: ${apply ? "APPLY" : "dry run"}`);

  const names = async () => (await Booking.collection.indexes().catch(() => [])).map((i) => i.name);
  const before = await names();
  console.log("booking indexes now:", before.join(", "));

  const conflicts = await Booking.aggregate([
    { $match: { status: { $in: ["upcoming", "serving"] }, bookingStartTime: { $type: "date" } } },
    { $group: { _id: { station: "$station", fuelType: "$fuelType", start: "$bookingStartTime" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  const servingConflicts = await Booking.aggregate([
    { $match: { status: "serving" } },
    { $group: { _id: { station: "$station", fuelType: "$fuelType" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  console.log(`rows that would block the new indexes: ${conflicts.length + servingConflicts.length}`);

  if (!apply) {
    console.log(`would build: ${NEW_INDEXES.filter((n) => !before.includes(n)).join(", ") || "(already built)"}`);
    console.log(`would drop:  ${OLD_INDEXES.filter((n) => before.includes(n)).join(", ") || "(already dropped)"}`);
    console.log("dry run: nothing changed. Re-run with --apply.");
    return;
  }
  if (conflicts.length + servingConflicts.length > 0) {
    throw new Error("existing bookings conflict with the per-fuel indexes; nothing was changed");
  }

  // Builds every index the schemas declare that is missing (the new ones).
  await Booking.createIndexes();
  await WalkIn.createIndexes();
  const built = await names();
  const missing = NEW_INDEXES.filter((n) => !built.includes(n));
  if (missing.length) throw new Error(`new indexes not present after build: ${missing.join(", ")}; nothing was dropped`);
  console.log("built:", NEW_INDEXES.join(", "));

  for (const name of OLD_INDEXES) {
    if (!built.includes(name)) continue;
    await Booking.collection.dropIndex(name);
    console.log("dropped:", name);
  }
  console.log("booking indexes now:", (await names()).join(", "));
}

main()
  .catch((err) => {
    console.error("Migration failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
