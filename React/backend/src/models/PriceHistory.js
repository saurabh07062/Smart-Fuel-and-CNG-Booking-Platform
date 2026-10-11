const mongoose = require("mongoose");

/**
 * One price change on one fuel at one station: what it was, what it became,
 * who changed it and when.
 *
 * Append-only -- a row is never edited, because it is the record of what the
 * price WAS while bookings were being priced against it. Station.prices holds
 * the current figure; this is how it got there.
 */
const PriceHistorySchema = new mongoose.Schema({
  station: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Station",
    required: true,
    index: true,
  },
  fuelType: {
    type: String,
    enum: ["Petrol", "Diesel", "CNG"],
    required: true,
  },
  // 0 is a real value here: it is how "was not published" is recorded, so a
  // fuel's first published price still leaves a row. Negative is not.
  oldPrice: { type: Number, required: true, min: 0 },
  newPrice: { type: Number, required: true, min: 0 },
  effectiveDate: { type: Date, default: Date.now, index: true },
  changedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  note: { type: String, trim: true, maxlength: 200 },
}, { timestamps: true });

// A station's price history, newest first -- and one fuel's line on a chart.
PriceHistorySchema.index({ station: 1, effectiveDate: -1 });
PriceHistorySchema.index({ station: 1, fuelType: 1, effectiveDate: -1 });

module.exports = mongoose.model("PriceHistory", PriceHistorySchema);