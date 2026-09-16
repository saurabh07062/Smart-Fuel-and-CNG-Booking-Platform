const mongoose = require("mongoose");
const { fuelLabel, FUEL_LABELS } = require("../config/fuels");

/**
 * A vehicle that arrived at a fuel's app nozzle without a booking, recorded by
 * the station's vendor so every customer's queue and wait estimate include it.
 *
 *   waiting    in line at the nozzle (arrivalTime set)
 *   serving    at the nozzle; fuelingStartTime + serviceDurationSeconds is
 *              when it is released (services/queue/serviceTimer.js)
 *   completed  fill finished (automatically at its release time, or the
 *              vendor marked it done early)
 *   cancelled  left the line before or during service
 *
 * It shares the nozzle with bookings of the same fuel under the same nozzle
 * lock (services/queue/nozzleService.js). The partial unique index below keeps
 * two walk-ins from being served at once; a walk-in and a booking at once is
 * prevented by that lock.
 */
const WalkInSchema = new mongoose.Schema(
  {
    station: { type: mongoose.Schema.Types.ObjectId, ref: "Station", required: true },
    fuelType: {
      type: String,
      required: true,
      enum: Object.values(FUEL_LABELS),
      set: (v) => fuelLabel(v) || v,
    },
    quantity: { type: Number, required: true, min: 0.1 },
    vehicleNumber: { type: String, trim: true, maxlength: 20, default: null },
    status: {
      type: String,
      enum: ["waiting", "serving", "completed", "cancelled"],
      default: "waiting",
    },
    // India business date the vehicle arrived ("YYYY-MM-DD", config/businessTime.js).
    businessDate: { type: String, required: true },
    arrivalTime: { type: Date, required: true },
    fuelingStartTime: { type: Date, default: null },
    completionTime: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    // Decided from the quantity when recorded (config/fuelDurations.js).
    serviceDurationSeconds: { type: Number, required: true, min: 1 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

// The live line per station and fuel.
WalkInSchema.index({ station: 1, fuelType: 1, status: 1, arrivalTime: 1 });
WalkInSchema.index({ status: 1, businessDate: 1 });

WalkInSchema.index(
  { station: 1, fuelType: 1 },
  { name: "uniq_serving_walkin_per_station_fuel", unique: true, partialFilterExpression: { status: "serving" } },
);

module.exports = mongoose.model("WalkIn", WalkInSchema);
