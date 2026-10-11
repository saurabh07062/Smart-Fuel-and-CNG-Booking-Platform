const mongoose = require("mongoose");

/**
 * A group of bookings made together, one per vehicle.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * It is the thing a customer with five vans thinks of as "the booking I made
 * this morning": one reference, one station, one fuel, one day. It is NOT a
 * booking -- every vehicle still gets its own Booking document, with its own
 * slot, queue position, PIN, payment and status, and every existing screen
 * (the vendor's queue, the admin's orders, check-in at the pump) keeps working
 * on those exactly as before. This document only groups them.
 *
 * WHY THE STATUS IS NOT STORED HERE
 *
 * A group's state is whatever its members are doing -- three completed, one
 * cancelled, one still waiting. Storing a summary would mean writing this
 * document on every member's every transition, and the first missed write
 * would leave the customer looking at a group that says "confirmed" over a
 * cancelled booking. `statusOf()` below reads the members instead, the same
 * way revenue is read from bookings rather than kept in a counter
 * (services/payment/revenue.js).
 *
 * What IS stored is what was true when the group was made and cannot be
 * recomputed later: the reference the customer quotes, what they asked for,
 * and how many vehicles they asked for it with.
 */
const FleetBookingSchema = new mongoose.Schema(
  {
    /** The reference a customer quotes: "FM-FLEET-2026-8F3A1C2B". */
    reference: { type: String, required: true, unique: true, trim: true, uppercase: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    station: { type: mongoose.Schema.Types.ObjectId, ref: "Station", required: true, index: true },

    /** One fuel per group: the vehicles queue on that fuel's nozzles. */
    fuelType: { type: String, required: true },
    /** "YYYY-MM-DD", India date -- the same key every booking uses. */
    bookingDate: { type: String, required: true, trim: true, match: /^\d{4}-\d{2}-\d{2}$/ },

    /** The time the customer asked to start from, before any suggestion. */
    preferredSlot: { type: String, trim: true, default: null },

    /** How many vehicles were booked. The members are the truth; this is the ask. */
    vehicleCount: { type: Number, required: true, min: 1 },

    /** Totals at the moment of booking. Not maintained afterwards -- a
        cancellation changes what is owed, and that is read from the members. */
    quantityTotal: { type: Number, default: 0, min: 0 },
    amountTotal: { type: Number, default: 0, min: 0 },

    /** Who made it (the customer themselves today; an admin could later). */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

// "My fleet bookings, newest first" -- the customer's list and the admin's.
FleetBookingSchema.index({ user: 1, createdAt: -1 });
// A station's fleet groups on a day (the vendor's view of what is coming).
FleetBookingSchema.index({ station: 1, bookingDate: 1 });

/**
 * The group's state, worked out from its member bookings.
 *
 * `bookings` is the member list (lean rows or documents). The rule reads the
 * way a person would describe it: if anything is still live the group is
 * active; otherwise it is completed, cancelled, or -- when the members
 * disagree -- partially completed.
 */
FleetBookingSchema.statics.statusOf = function statusOf(bookings = []) {
  const counts = bookings.reduce((acc, b) => {
    acc[b.status] = (acc[b.status] || 0) + 1;
    return acc;
  }, {});
  const total = bookings.length;
  const live = (counts.upcoming || 0) + (counts.serving || 0) + (counts.waitlisted || 0);
  const completed = counts.completed || 0;
  const cancelled = (counts.cancelled || 0) + (counts.no_show || 0) + (counts.expired || 0);

  let state = "active";
  if (total === 0) state = "empty";
  else if (live > 0) state = "active";
  else if (completed === total) state = "completed";
  else if (cancelled === total) state = "cancelled";
  else state = "partial";

  return { state, total, live, completed, cancelled, counts };
};

module.exports = mongoose.model("FleetBooking", FleetBookingSchema);
