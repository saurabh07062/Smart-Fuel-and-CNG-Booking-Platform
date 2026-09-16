/**
 * Phase 8: start tracking committed stock and stock history.
 *
 *   node scripts/migrations/phase8StockCommitments.js           dry run (default)
 *   node scripts/migrations/phase8StockCommitments.js --apply   write changes
 *
 * Bookings created before this change never reserved stock, so:
 *   1. live bookings (upcoming / serving) without a reservation are marked
 *      stockReserved, since their fuel is genuinely promised
 *   2. every station's inventoryCommitted is set to the sum of its live,
 *      reserved bookings (services/inventory/stockLedger.js reconcileCommitments)
 * Stations that had stock before the stock history existed have nothing
 * explaining that figure, so:
 *   3. each fuel with stock and no movement gets one opening-balance
 *      stock_count movement for its current figure (recordOpeningStock)
 * Then the ledger is checked against the tanks (ledgerDrift, read-only).
 *
 * Idempotent. Reports what it would change before changing anything.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");
const MONGO = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/fuelmart";
const OPENING_NOTE = "Opening balance (stock history began)";

async function main() {
  await mongoose.connect(MONGO);
  const Booking = require("../../src/models/Booking");
  const Station = require("../../src/models/Station");
  const {
    reconcileCommitments,
    recordOpeningStock,
    ledgerDrift,
    LIVE_STATUSES,
  } = require("../../src/services/inventory/stockLedger");

  // 1 + 2. reservations and commitments
  const unreserved = await Booking.find({ status: { $in: LIVE_STATUSES }, stockReserved: { $ne: true } })
    .select("_id station fuelType quantity status bookingDate")
    .lean();

  let marked = 0;
  if (APPLY && unreserved.length) {
    const res = await Booking.updateMany(
      { _id: { $in: unreserved.map((b) => b._id) }, status: { $in: LIVE_STATUSES }, stockReserved: { $ne: true } },
      { $set: { stockReserved: true } },
    );
    marked = res.modifiedCount;
  }
  const commitments = await reconcileCommitments({ apply: APPLY, quietMs: 0 });

  // 3. opening balances
  const before = await ledgerDrift();
  const noHistory = before.filter((d) => d.reason === "NO_HISTORY");
  let openingRecorded = 0;
  if (APPLY && noHistory.length) {
    const stationIds = [...new Set(noHistory.map((d) => d.stationId))];
    const stations = await Station.find({ _id: { $in: stationIds } }).select("_id inventory").lean();
    for (const station of stations) {
      // eslint-disable-next-line no-await-in-loop
      openingRecorded += await recordOpeningStock({ station, note: OPENING_NOTE });
    }
  }
  const after = APPLY ? await ledgerDrift() : null;

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "apply" : "dry-run",
        liveBookingsWithoutReservation: unreserved.length,
        marked,
        stationsChecked: commitments.checked,
        commitmentDrift: commitments.drift,
        repaired: commitments.repaired,
        skipped: commitments.skipped,
        fuelsWithoutStockHistory: noHistory.map((d) => ({ station: d.station, fuel: d.fuel, stock: d.stock })),
        ledgerMismatches: before.filter((d) => d.reason === "MISMATCH"),
        openingBalancesRecorded: openingRecorded,
        ledgerDriftAfter: after,
      },
      null,
      2,
    ),
  );
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Migration failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
