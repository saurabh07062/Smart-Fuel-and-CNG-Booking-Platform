const mongoose = require("mongoose");

/**
 * What FuelMart earned on ONE booking, and whether it has been collected.
 *
 * One row per booking, created when that booking becomes revenue -- the fuel
 * was dispensed AND the money was received (services/payment/revenue.js holds
 * that definition; this model never re-decides it). The row records the split
 * as it stood at that moment:
 *
 *     gross            what the customer actually paid at the pump
 *     fuelValue        price x quantity, the dealer's goods
 *     convenienceFee   FuelMart's own charge for the booking
 *     commission       what the vendor owes FuelMart on this sale
 *     vendorPayable    gross - commission: the vendor's share, already in
 *                      their hands, since the customer paid them directly
 *
 * STATES
 *
 *   pending    accrued, not yet collected. The day's pending rows are what an
 *              end-of-day settlement sweeps up.
 *   settled    included in a settlement whose transfer was CONFIRMED.
 *   failed     a settlement attempt was made and did not go through. The row
 *              returns to pending on the next run; the failure is kept on the
 *              settlement, not here.
 *   refunded   the booking was refunded, so there is no sale to take a
 *              commission on. Reversed rather than deleted.
 *
 * WHY THE FIGURES ARE STORED AND NOT COMPUTED ON READ
 *
 * The commission rate changes. A statement of what was owed last Tuesday has
 * to keep saying what was owed last Tuesday, so the rate and every figure
 * derived from it are frozen into the row at accrual, exactly as an invoice
 * freezes its prices (models/Invoice.js).
 */
const CommissionEntrySchema = new mongoose.Schema(
  {
    /**
     * One entry per booking, forever.
     *
     * `unique` is the whole anti-double-charge mechanism: completion, the
     * sweep and a late payment record can all notice the same booking became
     * revenue, and exactly one of them may create its commission. A second
     * writer gets duplicate-key 11000, which the service reads as
     * "already accrued" rather than as a failure.
     */
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, unique: true },
    station: { type: mongoose.Schema.Types.ObjectId, ref: "Station", required: true, index: true },
    /** The station's owner at the time of the sale: who owes this. */
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    /** The India business day the sale belongs to ("YYYY-MM-DD"); what a settlement groups by. */
    dateKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },

    gross: { type: Number, required: true, min: 0 },
    fuelValue: { type: Number, required: true, min: 0 },
    convenienceFee: { type: Number, default: 0, min: 0 },
    /** The percentage applied to fuelValue, frozen at accrual. */
    rate: { type: Number, required: true, min: 0, max: 100 },
    commission: { type: Number, required: true, min: 0 },
    vendorPayable: { type: Number, required: true, min: 0 },

    status: {
      type: String,
      enum: ["pending", "settled", "failed", "refunded"],
      default: "pending",
      index: true,
    },

    /** The settlement that collected it. Null until one does. */
    settlement: { type: mongoose.Schema.Types.ObjectId, ref: "Settlement", default: null },
    settledAt: { type: Date, default: null },
    /** Why it was reversed, when it was. */
    note: { type: String, trim: true, maxlength: 200, default: null },
  },
  { timestamps: true },
);

/** The sweep: this vendor's uncollected commission for a day. */
CommissionEntrySchema.index({ vendor: 1, dateKey: 1, status: 1 });
/** A vendor's own history, newest first. */
CommissionEntrySchema.index({ vendor: 1, createdAt: -1 });
/** Everything in one settlement. */
CommissionEntrySchema.index({ settlement: 1 });

module.exports = mongoose.model("CommissionEntry", CommissionEntrySchema);
