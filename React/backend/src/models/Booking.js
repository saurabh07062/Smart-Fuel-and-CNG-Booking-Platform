const mongoose = require("mongoose");
const { normalisePayMethod, payMethodLabel } = require("../services/payment/payMethod");
const { fuelLabel, FUEL_LABELS } = require("../config/fuels");

/**
 * Booking / Order schema.
 *
 * Full field map (requirements → schema field):
 *   order_id       → orderId        ("FM-2026-8F3A1C2B", auto-generated)
 *   user_id        → user           (ObjectId ref to User)
 *   station_id     → station        (ObjectId ref to Station)
 *   booking_date   → bookingDate    ("YYYY-MM-DD", India date)
 *   start_time     → startTime      ("HH:MM", India time, from the booking window)
 *   end_time       → endTime        ("HH:MM", India time)
 *   vehicle_number → vehiclePlate
 *   fuel_type      → fuelType       ("Petrol" | "Diesel" | "CNG", config/fuels.js)
 *   quantity       → quantity
 *   amount         → amount         (server-calculated, see services/booking/bookingCreate.js)
 *   payment_status → paymentStatus
 *   booking_status → status
 *   created_at     → createdAt      (via timestamps: true)
 */
const BookingSchema = new mongoose.Schema(
  {
    // ── Core Relations ──────────────────────────────────────────────────────
    user:    { type: mongoose.Schema.Types.ObjectId, ref: "User",    required: true },
    station: { type: mongoose.Schema.Types.ObjectId, ref: "Station" },

    // ── Admin Order ID ──────────────────────────────────────────────────────
    orderId: { type: String, sparse: true },

    // ── Fuel & Pricing ──────────────────────────────────────────────────────
    // One canonical label. Any casing a writer passes ("PETROL", "cng") is
    // normalised on assignment, so queries can match the label exactly.
    fuelType: {
      type: String,
      required: true,
      enum: Object.values(FUEL_LABELS),
      set: (v) => fuelLabel(v) || v,
    },
    quantity: { type: Number, required: true },
    price:    { type: Number, required: true },   // price per unit (₹/L or ₹/kg)
    taxes:    { type: Number, default: 0 },
    amount:   { type: Number, required: true },   // total = price x quantity + taxes

    // ── Slot ────────────────────────────────────────────────────────────────
    bookingDate: { type: String, required: true }, // "YYYY-MM-DD" (India date)
    timeSlot:    { type: String },                 // "10:00 AM"
    startTime:   { type: String, default: null },  // "10:00"
    endTime:     { type: String, default: null },  // "10:05"

    // Precise single-nozzle reservation window (services/queue/nozzleScheduler.js).
    // UTC instants; the authoritative source for overlap checking.
    bookingStartTime:      { type: Date, default: null },
    bookingEndTime:        { type: Date, default: null },
    serviceDurationSeconds: { type: Number, default: null },
    // Which of the fuel's app nozzles (booking resources) it is scheduled on,
    // 1..n (config/nozzleModes.js). Missing on bookings made before nozzles were
    // numbered: those count as nozzle 1. New bookings always carry one, so the
    // per-nozzle database guards below always apply to them.
    resource: { type: Number, default: 1, min: 1 },

    // ── Vehicle ─────────────────────────────────────────────────────────────
    vehiclePlate:     { type: String },
    // Snapshot of the vehicle chosen at booking time (services/booking/vehicleSnapshot.js).
    vehicleType:      { type: String, default: null }, // "Car" | "Bike" | "Scooter" | "Other"
    vehicleName:      { type: String, default: null }, // nickname, e.g. "My Car"
    verificationCode: { type: String },

    // ── Booking Status ──────────────────────────────────────────────────────
    // upcoming   → confirmed booking, not yet arrived
    // serving    → vehicle at the pump (occupies the nozzle)
    // waitlisted → slot was full; customer holds a priority-queue position
    // completed  → fuelled; stock deducted (services/booking/bookingCompletion.js)
    // cancelled  → cancelled by customer, vendor or admin before service
    // no_show    → slot elapsed without arrival; capacity freed
    // expired    → past date, auto-closed
    status: {
      type: String,
      enum: ["upcoming", "serving", "waitlisted", "completed", "cancelled", "no_show", "expired"],
      default: "upcoming",
      index: true,
    },

    // Who cancelled, and when. The risk engine counts only a customer's own
    // cancellations; a vendor or admin cancelling is not the customer's doing.
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, enum: ["customer", "vendor", "admin", "system"], default: undefined },
    // Why the customer cancelled, when they said.
    cancelReason: { type: String, enum: ["plans_changed", "wrong_slot", "too_far", "long_wait", "other"], default: undefined },

    // ── Queue & ETA ─────────────────────────────────────────────────────────
    waitlistPriority: { type: Number, default: null },
    arrivalTime:      { type: Date,   default: null },
    fuelingStartTime: { type: Date,   default: null },
    completionTime:   { type: Date,   default: null },
    // Set in the same write that completes the booking; the guarantee that
    // its fuel is deducted from station stock exactly once.
    inventoryDeductedAt: { type: Date, default: null },
    // True while this booking's quantity is counted in its station's
    // inventoryCommitted. Cleared in the same write that releases it (cancel,
    // expiry, no-show) or completes it -- which is what makes each release
    // happen exactly once (services/inventory/stockLedger.js).
    stockReserved:    { type: Boolean, default: false },
    etaMinutes:       { type: Number, default: null },

    // ── Payment ─────────────────────────────────────────────────────────────
    // "online"  → paid upfront via Razorpay before the slot is held
    // "station" → pay the attendant on arrival; collected when marked served
    payMethod: {
      type: String,
      enum: ["online", "station"],
      default: "station",
      set: normalisePayMethod,
    },
    // Display label the customer chose ("FuelMart Wallet", "UPI" …).
    // Never branch logic on this — use payMethod instead.
    payMethodDetail: { type: String, default: null },
    paymentStatus: {
      type: String,
      enum: ["pending", "due_at_station", "paid", "failed", "refunded"],
      default: "due_at_station",
    },
    razorpayOrderId: { type: String },
    // The Razorpay payment that settled (or arrived too late for) this booking;
    // what a refund is issued against. Set by services/payment/paymentRecording.js.
    razorpayPaymentId: { type: String, default: undefined },
    // Why the latest online attempt failed, from Razorpay's payment.failed event.
    paymentFailureReason: { type: String, default: undefined },
    // Who collected cash/card at the pump, and when.
    collectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    collectedAt: { type: Date, default: null },
    // How the attendant was paid at the pump: cash, or UPI scanned at the pump.
    collectionMethod: { type: String, enum: ["cash", "upi", null], default: null },
    invoiceUrl:  { type: String },
    qrCodeData:  { type: String },

    // ── Admin Display Snapshots ─────────────────────────────────────────────
    userName:    { type: String, default: null },
    userContact: { type: String, default: null },
    stationName: { type: String, default: null },
  },
  { timestamps: true }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
// Slot availability check.
BookingSchema.index({ station: 1, bookingDate: 1, timeSlot: 1, status: 1 });

// Per-fuel nozzle overlap check (services/queue/nozzleScheduler.js).
BookingSchema.index({ station: 1, status: 1, bookingStartTime: 1, bookingEndTime: 1 });

/**
 * Database-level guard: two live bookings never share a start on the same
 * app nozzle (resource) of a fuel. Overlap between different starts is
 * prevented by the fuel's nozzle lock during allocation and a re-check after
 * the write (services/booking/bookingCreate.js). Replaced
 * uniq_active_nozzle_start_per_fuel, which allowed one booking per slot label
 * (services/core/schedulingIndexes.js drops it).
 */
BookingSchema.index(
  { station: 1, fuelType: 1, resource: 1, bookingStartTime: 1 },
  {
    name: "uniq_active_start_per_resource",
    unique: true,
    partialFilterExpression: {
      status: { $in: ["upcoming", "serving"] },
      bookingStartTime: { $type: "date" },
    },
  },
);

/**
 * Database-level "one live booking per customer" guard.
 *
 * services/booking/bookingCreate.js checks this under the customer's lock; the index
 * makes it hold even if a lock expired, Redis failed over, or a second code
 * path writes a booking.
 */
BookingSchema.index(
  { user: 1 },
  {
    name: "uniq_active_booking_per_user",
    unique: true,
    partialFilterExpression: { status: { $in: ["upcoming", "serving", "waitlisted"] } },
  },
);

/**
 * Database-level "one car at each app nozzle" guard, per nozzle (resource).
 *
 * services/queue/nozzleService.js starts service under that fuel's nozzle
 * lock; this index makes a second "serving" booking on the same nozzle
 * impossible to persist even if two servers, or an expired lock, race.
 */
BookingSchema.index(
  { station: 1, fuelType: 1, resource: 1 },
  {
    name: "uniq_serving_per_resource",
    unique: true,
    partialFilterExpression: { status: "serving" },
  },
);

// Finding reservations whose booking is no longer live, and summing live ones.
BookingSchema.index({ stockReserved: 1, status: 1, station: 1 });

// "My bookings" user history, newest first.
BookingSchema.index({ user: 1, createdAt: -1 });

// Vendor queue view: who is waiting at my station today.
BookingSchema.index({ station: 1, status: 1, createdAt: 1 });

// Admin orders: filter by date range, newest first.
BookingSchema.index({ bookingDate: 1, createdAt: -1 });

// Risk engine: a customer's recent self-cancellations.
BookingSchema.index({ user: 1, cancelledBy: 1, cancelledAt: -1 });

// ── Hooks ─────────────────────────────────────────────────────────────────────
BookingSchema.pre("validate", function fillPayMethodDetail() {
  if (!this.payMethodDetail) {
    this.payMethodDetail = payMethodLabel(
      this.$locals?.rawPayMethod || this.payMethod
    );
  }
});

module.exports = mongoose.model("Booking", BookingSchema);
