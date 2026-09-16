/**
 * Notifications.
 *
 * This model did not exist. customerController.notifications was written as
 *
 *     try { Notification = require('./Notification'); } catch (e) {}
 *     ...
 *     if (!Notification) return res.json([]);
 *
 * so the require always threw, the variable stayed null, and
 * GET /api/customer/notifications returned an empty array to everyone,
 * permanently. The endpoint has never returned anything.
 */

const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema(
  {
    // Who this is for. Notifications are always addressed -- there is no
    // broadcast notification, because "everyone" is not a person who can
    // mark something read.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    type: {
      type: String,
      required: true,
      enum: [
        "vendor_approved",
        "vendor_rejected",
        "vendor_suspended",
        "booking_created",
        "booking_accepted",
        "booking_rejected",
        "booking_cancelled",
        "booking_completed",
        "booking_waitlisted",
        "booking_promoted",
        "fuel_price_updated",
        "fuel_unavailable",
        "low_stock",
        "nearest_station_changed",
        "system",
      ],
      index: true,
    },

    title: { type: String, required: true, trim: true },
    body: { type: String, trim: true, default: "" },

    // Where tapping it should go, e.g. "booking" or "vendor-panel". Kept as a
    // route name rather than a URL so the client owns its own routing.
    link: { type: String, default: null },

    // Related documents, for de-duplication and for rendering context.
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null },
    station: { type: mongoose.Schema.Types.ObjectId, ref: "Station", default: null },

    read: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },

    /**
     * De-duplication key.
     *
     * The same real-world event can be reached by more than one path -- a
     * booking is completed by the 5-second sweep, and a vendor may also press
     * "Mark complete" a moment later. Both would notify. Callers pass a key
     * describing the event rather than the moment ("booking:<id>:completed"),
     * and the unique index below makes the second write a no-op.
     *
     * Sparse: notifications that genuinely can repeat (a price change on the
     * same station next week) simply omit it.
     */
    dedupeKey: { type: String, default: null },
  },
  { timestamps: true },
);

// The list query is always "my notifications, newest first".
NotificationSchema.index({ user: 1, createdAt: -1 });

// The unread badge count.
NotificationSchema.index({ user: 1, read: 1 });

// One notification per (user, event). Sparse so the many rows without a key
// do not all collide on null.
NotificationSchema.index({ user: 1, dedupeKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Notification", NotificationSchema);
