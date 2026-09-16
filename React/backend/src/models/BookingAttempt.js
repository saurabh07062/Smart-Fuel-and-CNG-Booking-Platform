const mongoose = require("mongoose");

/**
 * One request to create a booking, whatever happened to it.
 *
 * Saved bookings cannot measure attempt velocity: a rejected attempt (slot
 * taken, blocked, out of stock) never becomes a Booking, so counting bookings
 * undercounts exactly the traffic the risk engine exists to notice. Every
 * validated POST /api/bookings writes one of these first, and its outcome is
 * filled in when the request finishes.
 *
 * Holds no request body -- only what the risk rules need. Rows expire after
 * 30 days; they are short-lived security telemetry, not business records.
 */
const BookingAttemptSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    station: { type: mongoose.Schema.Types.ObjectId, ref: "Station", default: null },
    bookingDate: { type: String, default: null },
    timeSlot: { type: String, default: null },
    fuelType: { type: String, default: null },
    outcome: {
      type: String,
      enum: ["pending", "confirmed", "rejected", "blocked", "error"],
      default: "pending",
    },
    reason: { type: String, default: null },
  },
  { timestamps: true },
);

BookingAttemptSchema.index({ user: 1, createdAt: -1 });
BookingAttemptSchema.index({ user: 1, station: 1, bookingDate: 1, timeSlot: 1, createdAt: -1 });
BookingAttemptSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model("BookingAttempt", BookingAttemptSchema);
