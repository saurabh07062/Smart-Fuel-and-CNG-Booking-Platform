const mongoose = require("mongoose");
const { normalisePayMethod, payMethodLabel } = require("../services/payment/payMethod");
const { fuelLabel, FUEL_LABELS } = require("../config/fuels");
const { DATE_KEY, CLOCK, PIN, INDIAN_MOBILE, onWrite } = require("./shared/fieldValidators");

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
    user:    { type: mongoose.Schema.Types.ObjectId, ref: "User",    required: true, index: true },
    // Optional on purpose: a booking made before stations were separate rows
    // has none, and refusing to load those would hide real history. Every
    // booking the app creates today carries one (services/booking/bookingCreate.js).
    station: { type: mongoose.Schema.Types.ObjectId, ref: "Station", index: true },

    // ── Admin Order ID ──────────────────────────────────────────────────────
    // The reference a customer quotes and an invoice prints ("FM-2026-8F3A1C2B").
    // Unique: two orders with the same number is an accounting problem, not a
    // cosmetic one. Sparse, because older bookings were created without one.
    // The unique index is declared below by name (uniq_booking_order_id): the
    // collection already carries a non-unique "orderId_1" from before, and Mongo
    // refuses to change an existing index in place -- declaring `unique` here
    // would only ever log that conflict.
    orderId: { type: String, trim: true, uppercase: true },

    // ── Fuel & Pricing ──────────────────────────────────────────────────────
    // One canonical label. Any casing a writer passes ("PETROL", "cng") is
    // normalised on assignment, so queries can match the label exactly.
    fuelType: {
      type: String,
      required: true,
      enum: Object.values(FUEL_LABELS),
      set: (v) => fuelLabel(v) || v,
    },
    // Money and volume are never negative, and a booking for nothing is not a
    // booking. The figures themselves are the server's (services/booking/bookingCreate.js);
    // these bounds are the floor under them.
    quantity: { type: Number, required: true, min: 0.1 },
    /**
     * How the customer said "how much": in litres/kg, or in rupees.
     *
     * `quantity` above is what is actually booked, reserved from the tank and
     * invoiced in BOTH cases -- an amount booking is converted to a quantity
     * by the server, at the station's published price, before anything is
     * written (services/booking/fuelAmount.js). These two fields exist so the
     * receipt and the booking screens can say "booked for ₹1000 of Petrol"
     * rather than quoting a figure the customer never typed.
     */
    bookedBy: { type: String, enum: ["quantity", "amount"], default: "quantity" },
    /** The rupees asked for, when bookedBy is "amount". Null otherwise. */
    requestedAmount: { type: Number, default: null, min: 0 },
    price:    { type: Number, required: true, min: 0 },   // price per unit (₹/L or ₹/kg)
    taxes:    { type: Number, default: 0, min: 0 },
    amount:   { type: Number, required: true, min: 0 },   // total = price x quantity + taxes

    // ── Reward points ───────────────────────────────────────────────────────
    /**
     * Points spent on this booking as a discount, and what they were worth.
     *
     * Both are the server's (services/rewards/rewardService.js) and both are
     * kept even after the points are returned, because the receipt has to go
     * on saying what the customer was charged. The ledger row with this
     * booking's id is the authority on whether the points are still spent.
     *
     * `payableAmount` is what is collected at the pump: amount - rewardDiscount.
     * It is a stored field rather than a computed one so that an invoice, a
     * revenue total and a receipt printed months apart cannot disagree about
     * it after a rate change.
     */
    rewardPointsUsed: { type: Number, default: 0, min: 0 },
    rewardDiscount:   { type: Number, default: 0, min: 0 },
    payableAmount:    { type: Number, default: null, min: 0 },

    // ── Slot ────────────────────────────────────────────────────────────────
    // "YYYY-MM-DD" (India date). The shape is enforced because every query
    // that groups or filters by day compares these as strings -- one row
    // written "2026-9-5" would silently never match again.
    bookingDate: { type: String, required: true, trim: true, match: DATE_KEY },
    timeSlot:    { type: String, trim: true },      // "10:00 AM"
    startTime:   { type: String, default: null, validate: onWrite("startTime", CLOCK, "startTime must be HH:MM") },  // "10:00"
    endTime:     { type: String, default: null, validate: onWrite("endTime", CLOCK, "endTime must be HH:MM") },      // "10:05"

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

    // ── Fleet / multiple-vehicle booking ────────────────────────────────────
    // A booking made as one of several, one per vehicle, in a single request
    // (services/booking/fleetBooking.js). Null on every ordinary booking, and
    // on every booking made before the feature existed.
    //
    // The member booking is a NORMAL booking in every other way: its own slot,
    // nozzle, queue position, PIN, payment and status. The group only records
    // that they were made together, so the customer can see and manage them as
    // one -- and so each can still be cancelled on its own without touching the
    // rest (models/FleetBooking.js).
    fleetGroup: { type: mongoose.Schema.Types.ObjectId, ref: "FleetBooking", default: null, index: true },
    /** 1..n, the order shown to the customer ("Vehicle 3 of 5"). */
    fleetIndex: { type: Number, default: null, min: 1 },

    // ── Vehicle ─────────────────────────────────────────────────────────────
    vehiclePlate:     { type: String, trim: true, uppercase: true, maxlength: 20 },
    /**
     * The saved vehicle this booking is for, when it came from the customer's
     * garage (User.vehicles). Advisory: a booking for an unsaved vehicle has
     * none, and deleting the saved vehicle does not change the booking, which
     * keeps its own plate snapshot.
     */
    vehicleRef:       { type: mongoose.Schema.Types.ObjectId, default: null },
    /**
     * The plate, normalised, as the uniqueness guard below compares it.
     * Written by the booking service from vehiclePlate -- never by a client.
     */
    vehicleKey:       { type: String, trim: true, uppercase: true, maxlength: 20, default: null },
    // Snapshot of the vehicle chosen at booking time (services/booking/vehicleSnapshot.js).
    vehicleType:      { type: String, default: null }, // "Car" | "Bike" | "Scooter" | "Other"
    vehicleName:      { type: String, default: null }, // nickname, e.g. "My Car"
    // The 4 digits the customer shows at the pump. Only valid once they have
    // checked in at the station (controllers/bookingController.js).
    verificationCode: { type: String, trim: true, match: PIN },

    // ── Booked for someone else ─────────────────────────────────────────────
    // A customer may reserve a slot for another person (a family member, a
    // driver). The booking still belongs to `user` -- they own it, cancel it
    // and pay for it -- but the attendant needs the name of whoever actually
    // turns up with the vehicle, and that person's number to call.
    // Absent on a booking for oneself.
    bookedForName:  { type: String, default: null, trim: true, maxlength: 120 },
    bookedForPhone: {
      type: String,
      default: null,
      trim: true,
      validate: onWrite("bookedForPhone", INDIAN_MOBILE, (p) => `"${p.value}" is not a 10-digit mobile number`),
    },

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
    // "Check In at Petrol Pump" from the customer's app, at the station
    // (services/booking/stationArrival.js): the order people reached the
    // station in. Not the start of service -- that is the PIN (arrivalTime).
    stationCheckInAt: { type: Date, default: null },
    stationCheckInDistanceM: { type: Number, default: null },
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

/**
 * One order reference, one booking. Two orders sharing a number is an
 * accounting problem, not a cosmetic one; services/booking/bookingCreate.js
 * retries with a fresh id if it ever loses this race.
 *
 * Partial rather than sparse, so bookings created before order ids existed
 * (which have none) do not all collide with each other on null.
 */
BookingSchema.index(
  { orderId: 1 },
  {
    name: "uniq_booking_order_id",
    unique: true,
    partialFilterExpression: { orderId: { $type: "string" } },
  },
);

/**
 * Check-in at the pump: the attendant types 4 digits and the booking has to be
 * found by code, for today, among the live ones. Without this index that read
 * was a collection scan on every check-in -- the one query that happens with a
 * customer standing at the window.
 */
BookingSchema.index({ verificationCode: 1, bookingDate: 1, status: 1 });

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
 * Database-level "one live ORDINARY booking per customer" guard.
 *
 * services/booking/bookingCreate.js checks this under the customer's lock; the
 * index makes it hold even if a lock expired, Redis failed over, or a second
 * code path writes a booking.
 *
 * `fleetGroup: null` is what makes fleet booking possible without giving up
 * the rule: a customer fuelling five vans holds five live bookings, and they
 * are excluded here because each carries a group. Everything else -- including
 * every booking written before fleet booking existed, which has no such field
 * at all -- is still held to one at a time. (A partial filter on a null field
 * matches both an explicit null and a missing field; verified against MongoDB
 * before this was written.)
 *
 * The rule a fleet is held to instead is the next index: one live booking per
 * vehicle. Five vans are five bookings; the same van twice is not.
 */
BookingSchema.index(
  { user: 1 },
  {
    name: "uniq_active_solo_booking_per_user",
    unique: true,
    partialFilterExpression: { status: { $in: ["upcoming", "serving", "waitlisted"] }, fleetGroup: null },
  },
);

/**
 * One live booking per vehicle, per customer.
 *
 * The same van cannot hold two slots at once -- by accident (a double tap on
 * Confirm), by a retried request, or by two servers racing. Scoped to the
 * customer because a plate is not proof of ownership: two accounts entering
 * the same plate is a support question, not something to refuse at 2 a.m.
 *
 * Only bookings that actually name a vehicle are covered; a booking made
 * without a plate (which the single-booking flow still allows) is not.
 */
BookingSchema.index(
  { user: 1, vehicleKey: 1 },
  {
    name: "uniq_active_booking_per_vehicle",
    unique: true,
    partialFilterExpression: {
      status: { $in: ["upcoming", "serving", "waitlisted"] },
      vehicleKey: { $type: "string" },
    },
  },
);

/** A group's member bookings, in the order the customer sees them. */
BookingSchema.index({ fleetGroup: 1, fleetIndex: 1 });

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

// Revenue: completed, paid bookings of a station within a period
// (services/payment/revenue.js), and the same query across all stations.
BookingSchema.index({ station: 1, status: 1, paymentStatus: 1, completionTime: -1 });

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
