const mongoose = require("mongoose");

/**
 * One day's commission, moved from one vendor to FuelMart.
 *
 * Raised by the end-of-day job (services/commission/settlementJob.js): it
 * gathers that vendor's pending CommissionEntry rows for the business day,
 * totals them, and records the attempt here. The entries point back at it.
 *
 * STATES, and the rule that governs them
 *
 *   awaiting_confirmation   the transfer has been requested but NOTHING has
 *                           confirmed the money moved. This is where a
 *                           settlement sits under the manual payout mode,
 *                           which is the honest state when FuelMart has no
 *                           payout rail (config/commission.js PAYOUT_MODE).
 *   settled                 the transfer was CONFIRMED -- by the payout
 *                           provider, or by an admin recording receipt. Only
 *                           now are the entries marked settled.
 *   failed                  the attempt was made and refused. The entries go
 *                           back to pending and join the next run; `error`
 *                           says why, `attempts` counts the tries.
 *
 * There is deliberately no state meaning "the schedule fired, so assume it
 * worked". A settlement is money; it is settled when something that handles
 * money says so.
 *
 * EXACTLY ONE PER VENDOR PER DAY
 *
 * The unique index below is what stops a double transfer when the job runs
 * twice -- two servers, a restart at the settlement minute, an admin pressing
 * "run now" during the scheduled run. The second writer collides and stops.
 */
const SettlementSchema = new mongoose.Schema(
  {
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** The India business day whose sales this covers ("YYYY-MM-DD"). */
    dateKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

    /** A human reference, e.g. "STL-2026-10-02-3F7A". */
    reference: { type: String, required: true, unique: true, trim: true, uppercase: true },

    /** The sum of its entries, and how many there are. Frozen when raised. */
    amount: { type: Number, required: true, min: 0 },
    entryCount: { type: Number, required: true, min: 0 },

    status: {
      type: String,
      enum: ["awaiting_confirmation", "settled", "failed"],
      default: "awaiting_confirmation",
      index: true,
    },

    /** How the transfer was attempted (config/commission.js PAYOUT_MODE). */
    mode: { type: String, enum: ["manual", "gateway"], required: true },
    /** The provider's own id for the transfer, when there is one. */
    transferRef: { type: String, trim: true, default: null },
    /** Who confirmed receipt, for a manual settlement. */
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    confirmedAt: { type: Date, default: null },

    attempts: { type: Number, default: 1, min: 0 },
    /** Why the last attempt failed, in words an operator can act on. */
    error: { type: String, trim: true, maxlength: 300, default: null },
  },
  { timestamps: true },
);

/** One settlement per vendor per day -- the guard against a double transfer. */
SettlementSchema.index({ vendor: 1, dateKey: 1 }, { unique: true, name: "uniq_settlement_per_vendor_day" });
/** The admin's list, and a vendor's own, newest first. */
SettlementSchema.index({ createdAt: -1 });
SettlementSchema.index({ vendor: 1, createdAt: -1 });
SettlementSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("Settlement", SettlementSchema);
