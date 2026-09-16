const mongoose = require("mongoose");

const PriceHistorySchema = new mongoose.Schema({
  station: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Station",
    required: true,
  },
  fuelType: {
    type: String,
    enum: ["Petrol", "Diesel", "CNG"],
    required: true,
  },
  oldPrice: { type: Number, required: true },
  newPrice: { type: Number, required: true },
  effectiveDate: { type: Date, default: Date.now },
  changedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  note: { type: String },
}, { timestamps: true });

module.exports = mongoose.model("PriceHistory", PriceHistorySchema);