const mongoose = require("mongoose");

/**
 * One change to a station's fuel stock, and why.
 *
 *   delivery         the vendor added stock (a tanker arrived)
 *   stock_count      the vendor recorded a physical count; quantity is the
 *                    correction (count - previous figure)
 *   sale             a booking completed and its fuel was dispensed
 *   capacity_change  the tank size was recorded or changed
 *
 * `quantity` is signed (litres, CNG kg): deliveries are positive, sales
 * negative. `stockAfter` is the station's figure right after the change, so
 * the history reads like a statement and a drift between the ledger and the
 * tank is visible.
 */
const InventoryMovementSchema = new mongoose.Schema(
  {
    station: { type: mongoose.Schema.Types.ObjectId, ref: "Station", required: true },
    fuel: { type: String, enum: ["petrol", "diesel", "cng"], required: true },
    type: { type: String, enum: ["delivery", "stock_count", "sale", "capacity_change"], required: true },
    quantity: { type: Number, default: null },
    stockAfter: { type: Number, default: null },
    capacityAfter: { type: Number, default: null },
    unit: { type: String, default: null },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, trim: true, maxlength: 200, default: null },
    // Deliveries only: the India date the order was placed, and the whole days
    // from that date to the day it was recorded -- the real lead time
    // (services/inventory/leadTime.js). null when the vendor did not give an order date.
    orderedOn: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    leadTimeDays: { type: Number, default: null, min: 0 },
  },
  { timestamps: true },
);

InventoryMovementSchema.index({ station: 1, createdAt: -1 });
InventoryMovementSchema.index({ station: 1, fuel: 1, createdAt: -1 });
// A booking's sale is recorded once.
InventoryMovementSchema.index({ booking: 1, type: 1 }, { unique: true, partialFilterExpression: { type: "sale" } });

module.exports = mongoose.model("InventoryMovement", InventoryMovementSchema);
