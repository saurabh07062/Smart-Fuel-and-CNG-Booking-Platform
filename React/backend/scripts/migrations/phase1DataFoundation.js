/**
 * Phase 1 data foundation migration.
 *
 *   node scripts/migrations/phase1DataFoundation.js           dry run (default)
 *   node scripts/migrations/phase1DataFoundation.js --apply   write changes
 *
 * Only corrects representation; it never invents values.
 *   1. Booking.fuelType -> canonical label ("PETROL" -> "Petrol").
 *   2. Station.fuelTypes -> canonical labels, de-duplicated.
 *   3. Stations stored at exactly (0, 0) -- a placeholder, not a place --
 *      have that position removed.
 * Reported, not changed (a person has to supply the real value):
 *   - stations with no tank capacity recorded
 *   - stations with no price for a fuel they list
 *   - bookings whose status is outside the current enum
 *   - active bookings already completed (safety check, should be 0)
 *
 * Uses the native driver so model setters and hooks cannot hide what the
 * stored data actually looks like. Idempotent: a second run changes nothing.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const { FUEL_KEYS, fuelLabel, normaliseFuel } = require("../../src/config/fuels");

const APPLY = process.argv.includes("--apply");
const MONGO = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/fuelmart";
const BOOKING_STATUSES = ["upcoming", "serving", "waitlisted", "completed", "cancelled", "no_show", "expired"];

async function main() {
  await mongoose.connect(MONGO);
  const db = mongoose.connection.db;
  const bookings = db.collection("bookings");
  const stations = db.collection("stations");
  const report = { mode: APPLY ? "apply" : "dry-run" };

  // 1. Booking fuel types.
  const fuelRows = await bookings.aggregate([{ $group: { _id: "$fuelType", n: { $sum: 1 } } }]).toArray();
  report.bookingFuelTypesBefore = Object.fromEntries(fuelRows.map((r) => [String(r._id), r.n]));
  report.bookingFuelFixes = [];
  report.bookingFuelUnrecognised = [];
  for (const { _id: stored, n } of fuelRows) {
    const label = fuelLabel(stored);
    if (!label) {
      report.bookingFuelUnrecognised.push({ stored, count: n });
      continue;
    }
    if (label === stored) continue;
    report.bookingFuelFixes.push({ from: stored, to: label, count: n });
    if (APPLY) await bookings.updateMany({ fuelType: stored }, { $set: { fuelType: label } });
  }

  // 2 + 3. Stations.
  report.stationFuelTypeFixes = [];
  report.stationPlaceholderPositionsRemoved = [];
  report.stationsWithoutTankCapacity = [];
  report.stationsMissingPrices = [];

  const all = await stations
    .find({}, { projection: { name: 1, fuelTypes: 1, coordinates: 1, location: 1, tankCapacity: 1, prices: 1 } })
    .toArray();
  report.stationCount = all.length;

  for (const s of all) {
    const listed = Array.isArray(s.fuelTypes) ? s.fuelTypes : [];
    const canonical = [...new Set(listed.map((f) => fuelLabel(f) || f))];
    if (JSON.stringify(canonical) !== JSON.stringify(listed)) {
      report.stationFuelTypeFixes.push({ station: s.name, from: listed, to: canonical });
      if (APPLY) await stations.updateOne({ _id: s._id }, { $set: { fuelTypes: canonical } });
    }

    const legacyZero = s.coordinates && s.coordinates.lat === 0 && s.coordinates.lng === 0;
    const geo = s.location?.coordinates;
    const geoZero = Array.isArray(geo) && geo.length === 2 && geo[0] === 0 && geo[1] === 0;
    if (legacyZero || geoZero) {
      report.stationPlaceholderPositionsRemoved.push(s.name);
      if (APPLY) {
        const unset = {};
        if (legacyZero) unset.coordinates = "";
        if (geoZero) unset.location = "";
        await stations.updateOne({ _id: s._id }, { $unset: unset });
      }
    }

    const sold = canonical.map(normaliseFuel).filter(Boolean);
    const noCapacity = sold.filter((f) => !(Number(s.tankCapacity?.[f]) > 0));
    if (noCapacity.length) report.stationsWithoutTankCapacity.push({ station: s.name, fuels: noCapacity });
    const noPrice = sold.filter((f) => !(Number(s.prices?.[f]) > 0));
    if (noPrice.length) report.stationsMissingPrices.push({ station: s.name, fuels: noPrice });
  }

  // Reports only.
  report.bookingsWithUnknownStatus = await bookings
    .aggregate([{ $match: { status: { $nin: BOOKING_STATUSES } } }, { $group: { _id: "$status", n: { $sum: 1 } } }])
    .toArray();
  report.completedWithoutDeductionStamp = await bookings.countDocuments({
    status: "completed",
    inventoryDeductedAt: { $exists: false },
  });
  report.note =
    "completedWithoutDeductionStamp are historical completions from before stock deduction existed; " +
    "they are intentionally NOT back-deducted (current stock figures were entered by vendors after them).";

  if (APPLY) {
    const after = await bookings.aggregate([{ $group: { _id: "$fuelType", n: { $sum: 1 } } }]).toArray();
    report.bookingFuelTypesAfter = Object.fromEntries(after.map((r) => [String(r._id), r.n]));
  }
  report.knownFuelKeys = FUEL_KEYS;

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Migration failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
