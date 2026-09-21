/**
 * Customer booking creation -- the ONE place a booking is created.
 *
 * Used by POST /api/bookings (controllers/bookingController.js). The former
 * second path, POST /api/v1/slots/book, bypassed the nozzle scheduler and has
 * been retired.
 *
 * Order of operations, each step before anything more expensive:
 *
 *   1. validate input               fuel, quantity, date, slot label
 *   2. record the attempt           models/BookingAttempt (for risk velocity)
 *   3. risk evaluation              services/riskEngine -- before any capacity
 *   4. station facts from MongoDB   status, fuel sold/available, price, stock
 *   5. price on the server          never from the request body
 *   6. lock user, then station      fixed order, so no deadlock
 *        - one active booking per customer
 *        - stock net of bookings already committed
 *        - nozzle interval overlap  services/nozzleScheduler
 *        - write the booking        (DB unique index is the last guard)
 *   7. release locks, record outcome
 *
 * Dates and slot labels are India time (config/businessTime.js).
 */

const crypto = require("crypto");
const mongoose = require("mongoose");
const Booking = require("../../models/Booking");
const Station = require("../../models/Station");
const User = require("../../models/User");
const BookingAttempt = require("../../models/BookingAttempt");
const SecurityEvent = require("../../models/SecurityEvent");
const lock = require("../core/lock");
const nozzleScheduler = require("../queue/nozzleScheduler");
const riskEngine = require("../security/riskEngine");
const stockLedger = require("../inventory/stockLedger");
const metrics = require("../core/metrics");
const { normaliseFuel, fuelLabel, fuelUnit } = require("../../config/fuels");
const { dateKey, parseClock, atBusinessTime, formatHHMM } = require("../../config/businessTime");
const { normaliseVehicleSnapshot } = require("./vehicleSnapshot");
const { initialPaymentStatus, normalisePayMethod } = require("../payment/payMethod");
const { onlinePaymentsEnabled, ONLINE_PAYMENT_DISABLED_MSG } = require("../../config/payments");
const { waitlist } = require("../queue/waitlist");
const {
  QUANTITY_MIN,
  QUANTITY_MAX,
  CONVENIENCE_FEE,
  BOOKABLE_SLOT_LABELS,
  isSlotElapsed,
} = require("../../config/booking");

const ACTIVE_STATUSES = ["upcoming", "serving", "waitlisted"];
const NOZZLE_STATUSES = nozzleScheduler.NOZZLE_OCCUPYING_STATUSES;
const ROUTE = "POST /api/bookings";

class BookingError extends Error {
  constructor(status, reason, message, extra = {}) {
    super(message);
    this.name = "BookingError";
    this.status = status;
    this.reason = reason;
    this.extra = extra;
  }
}

// Slot end / elapsed rules live in config/booking.js (one definition shared
// with the no-show sweep and the nozzle scheduler); isSlotElapsed is
// re-exported below for existing callers.

/**
 * Only a reservation nobody has acted on can expire. A "serving" booking has a
 * car at the pump; it is finished by completion (services/booking/bookingSweep.js
 * sweepInProgressBookings), never expired out from under the attendant.
 */
const EXPIRABLE_STATUSES = ["upcoming", "waitlisted"];

/** Mark a user's (or everyone's) elapsed reservations as expired. */
async function expireUserPastBookings(userId) {
  try {
    // A car checked in today and waiting at the pump (arrivalTime set) has not
    // lapsed, whatever its slot says; one left from an earlier day has.
    const waitingNotAtPump = { $or: [{ arrivalTime: null }, { bookingDate: { $lt: dateKey() } }] };
    const query = { status: { $in: EXPIRABLE_STATUSES }, ...waitingNotAtPump };
    if (userId) query.user = userId;
    const candidates = await Booking.find(query).select("_id bookingDate timeSlot").lean();
    const elapsed = candidates.filter((b) => isSlotElapsed(b.bookingDate, b.timeSlot)).map((b) => b._id);
    if (elapsed.length) {
      // Status re-checked in the write: one changed since the read is left alone.
      await Booking.updateMany(
        { _id: { $in: elapsed }, status: { $in: EXPIRABLE_STATUSES }, ...waitingNotAtPump },
        { $set: { status: "expired" } },
      );
      // An expired reservation's fuel is available again.
      await stockLedger.releaseStaleReservations({ _id: { $in: elapsed } });
    }
  } catch (err) {
    console.error("expireUserPastBookings error:", err);
  }
}

/**
 * Server-side price for a booking. Pure.
 * @returns {{price:number, taxes:number, amount:number}|null} null when the
 *   station has no valid price for this fuel -- never a guessed price.
 */
function priceBooking(station, fuel, quantity) {
  const unitPrice = Number(station?.prices?.[fuel]);
  const qty = Number(quantity);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return null;
  if (!Number.isFinite(qty) || qty <= 0) return null;

  const taxes = round2(CONVENIENCE_FEE);
  return {
    price: round2(unitPrice),
    taxes,
    amount: round2(unitPrice * qty + taxes),
  };
}

/** Validate and normalise the request body. Throws BookingError. */
function validateInput(body = {}) {
  const fuel = normaliseFuel(body.fuelType);
  if (!fuel) {
    throw new BookingError(
      400,
      "INVALID_FUEL_TYPE",
      `Unrecognised fuel type '${body.fuelType}'. Must be Petrol, Diesel, or CNG.`,
    );
  }

  const stationId = body.stationId;
  if (!stationId || !mongoose.isValidObjectId(stationId)) {
    throw new BookingError(400, "INVALID_STATION", "A valid stationId is required.");
  }

  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity < QUANTITY_MIN || quantity > QUANTITY_MAX) {
    throw new BookingError(
      400,
      "INVALID_QUANTITY",
      `Quantity must be between ${QUANTITY_MIN} and ${QUANTITY_MAX}.`,
    );
  }

  const bookingDate = String(body.bookingDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) {
    throw new BookingError(400, "INVALID_DATE", "bookingDate must be a YYYY-MM-DD date.");
  }

  // Bookings are taken only a few days ahead (config/booking.js ADVANCE_BOOKING_DAYS).
  const bookingRules = require("../../config/booking");
  if (bookingRules.isBeyondAdvanceWindow(bookingDate)) {
    const days = bookingRules.advanceBookingDays();
    throw new BookingError(
      400,
      "DATE_TOO_FAR",
      `Bookings open only ${days} day${days === 1 ? "" : "s"} ahead. Choose a date up to ${bookingRules.lastBookableDate()}.`,
    );
  }

  const timeSlot = String(body.timeSlot || "");
  if (!BOOKABLE_SLOT_LABELS.includes(timeSlot)) {
    throw new BookingError(400, "INVALID_SLOT", "Choose one of the listed time slots.");
  }

  if (isSlotElapsed(bookingDate, timeSlot)) {
    throw new BookingError(
      400,
      "SLOT_PASSED",
      `The slot '${timeSlot}' has already passed. Please select an upcoming time slot.`,
    );
  }

  return { fuel, stationId: String(stationId), quantity, bookingDate, timeSlot };
}


/**
 * Create a booking for the authenticated customer.
 *
 * @param {{user:{id:string}, body:object}} params  user comes from the JWT,
 *   never from the body
 * @returns {Promise<import("mongoose").Document>} the saved booking
 * @throws {BookingError} for every business rejection
 */
/**
 * Record one booking attempt, before the request is validated, so a flood of
 * malformed requests counts toward the velocity rule as much as well-formed
 * ones. Stores only what the rules read -- never the request body.
 */
async function recordAttempt(user, body = {}) {
  const clip = (v) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, 40));
  try {
    const attempt = await BookingAttempt.create({
      user: user.id,
      station: mongoose.isValidObjectId(body.stationId) ? body.stationId : null,
      bookingDate: clip(body.bookingDate),
      timeSlot: clip(body.timeSlot),
      fuelType: normaliseFuel(body.fuelType) || clip(body.fuelType),
    });
    return attempt._id;
  } catch (err) {
    console.error("[booking] could not record attempt:", err.message);
    return null;
  }
}

/** A flagged (not blocked) risk event is logged at most once per user and rule in this window. */
const FLAG_DEDUPE_MS = 10 * 60_000;

async function flagRisk({ userId, stationId, risk }) {
  const rule = risk.reasons.map((r) => r.rule).join("+");
  try {
    // Atomic once-per-window write (models/SecurityEvent.js recordOnce):
    // concurrent requests from one account must not log the flag twice.
    const written = await SecurityEvent.recordOnce(
      {
        rule,
        reason: risk.reasons.map((r) => r.reason).join("; "),
        score: risk.score,
        threshold: risk.threshold,
        action: "flagged",
        user: userId,
        station: stationId,
        route: ROUTE,
      },
      { windowMs: FLAG_DEDUPE_MS },
    );
    if (written) metrics.inc("risk_flag_count");
  } catch (err) {
    console.error("[booking] failed to log flagged risk:", err.message);
  }
}

async function createCustomerBooking({ user, body }) {
  const started = Date.now();
  const attemptId = await recordAttempt(user, body);

  const settle = (outcome, reason) =>
    attemptId
      ? BookingAttempt.updateOne({ _id: attemptId }, { $set: { outcome, reason } }).catch(() => {})
      : null;

  try {
    const input = validateInput(body);
    const booking = await createWithinGuards({ user, input, body, attemptId });
    await settle("confirmed", null);
    metrics.inc("booking_created_count");
    metrics.observe("booking_create_ms", Date.now() - started);
    return booking;
  } catch (err) {
    if (err instanceof BookingError) {
      await settle(err.reason === "RISK_BLOCKED" ? "blocked" : "rejected", err.reason);
      metrics.inc("booking_rejected_count");
    } else {
      await settle("error", err.code || err.name || "ERROR");
    }
    throw err;
  }
}

async function createWithinGuards({ user, input, body, attemptId }) {
  const { fuel, stationId, quantity, bookingDate, timeSlot } = input;

  // ---- 1. risk, before any capacity is examined --------------------------
  let risk = null;
  try {
    risk = await riskEngine.evaluateBookingRisk({
      userId: user.id,
      stationId,
      bookingDate,
      timeSlot,
      fuelType: fuel,
      excludeAttemptId: attemptId,
    });
  } catch (err) {
    // A failing risk query must not take booking down; the capacity guards
    // below still protect the station. Counted so it is visible.
    console.error("[booking] risk evaluation failed, continuing without it:", err.message);
    metrics.inc("risk_evaluation_error_count");
  }

  if (risk?.blocked) {
    metrics.inc("risk_block_count");
    await SecurityEvent.create({
      rule: risk.reasons.map((r) => r.rule).join("+"),
      reason: risk.reasons.map((r) => r.reason).join("; "),
      score: risk.score,
      threshold: risk.threshold,
      action: "blocked",
      user: user.id,
      station: stationId,
      route: ROUTE,
    }).catch((err) => console.error("[booking] failed to log security event:", err.message));

    const minutes = Math.max(1, Math.ceil(risk.retryAfterSeconds / 60));
    throw new BookingError(
      429,
      "RISK_BLOCKED",
      `Too many booking attempts in a short time. Please try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      { reasons: risk.reasons.map((r) => r.reason), retryAfterSeconds: risk.retryAfterSeconds },
    );
  }

  // Suspicious but not blocking (one rule tripped): visible to admins,
  // invisible to the customer.
  if (risk && risk.score > 0) {
    await flagRisk({ userId: user.id, stationId, risk });
  }

  // ---- 2. station facts, from the database --------------------------------
  const [station, customer] = await Promise.all([
    Station.findById(stationId)
      .select("name status fuelTypes fuelAvailability nozzleConfig prices inventory owner operatingSchedule openingHours")
      .lean(),
    User.findById(user.id).select("name email phone").lean(),
  ]);

  if (!customer) throw new BookingError(401, "ACCOUNT_NOT_FOUND", "Your account could not be found.");
  if (!station) throw new BookingError(404, "STATION_NOT_FOUND", "Station not found.");
  if (station.status !== "Active") {
    throw new BookingError(409, "STATION_INACTIVE", "This station is not accepting bookings right now.");
  }

  const label = fuelLabel(fuel);
  const sellsFuel = (station.fuelTypes || []).some((f) => normaliseFuel(f) === fuel);
  if (!sellsFuel) {
    throw new BookingError(409, "FUEL_NOT_SOLD", `This station does not sell ${label}.`);
  }
  if (station.fuelAvailability?.[fuel] === false) {
    throw new BookingError(409, "FUEL_UNAVAILABLE", `${label} is currently unavailable at this station.`);
  }
  // The vendor set this fuel's nozzle to walk-ins only (config/nozzleModes.js).
  const nozzleModes = require("../../config/nozzleModes");
  if (!nozzleModes.acceptsOnline(station, fuel)) {
    throw new BookingError(409, "NOZZLE_OFFLINE_ONLY", nozzleModes.walkInOnlyMessage(fuel));
  }
  // The station's own opening hours for that day (models/Station.js).
  if (!Station.scheduleAllowsSlot(station, bookingDate, timeSlot)) {
    throw new BookingError(
      409,
      "STATION_CLOSED_AT_SLOT",
      `This station is closed at ${timeSlot} on ${bookingDate}. Please choose a time within its opening hours.`,
    );
  }

  const pricing = priceBooking(station, fuel, quantity);
  if (!pricing) {
    throw new BookingError(409, "PRICE_UNAVAILABLE", `This station has not published a ${label} price.`);
  }

  const stock = Number(station.inventory?.[fuel]);
  if (!Number.isFinite(stock)) {
    throw new BookingError(409, "INVENTORY_UNAVAILABLE", `${label} stock is not tracked at this station.`);
  }

  // ---- 3. the booking window ----------------------------------------------
  // The label is a 30-minute window; the booking's exact start and nozzle are
  // allocated inside it under the fuel's lock (services/queue/nozzleScheduler.js).
  // Its length is THIS fill's service time: the quantity decides it.
  const start = nozzleScheduler.parseStartDateTime(bookingDate, timeSlot);
  const window = start ? nozzleScheduler.computeWindow(fuel, start, quantity) : null;
  if (!window) {
    throw new BookingError(400, "INVALID_SLOT", `Could not understand the requested time slot '${timeSlot}'.`);
  }

  // Joining the waitlist for a full slot (body.joinWaitlist). Nothing is
  // charged for a slot the customer may never get, so a waitlist booking is
  // pay-at-station; if the slot turns out to be free, it is simply booked.
  const joinWaitlist = body.joinWaitlist === true;
  if (joinWaitlist && normalisePayMethod(body.payMethod) !== "station") {
    throw new BookingError(
      400,
      "WAITLIST_PAY_AT_STATION",
      "A waitlist booking is paid at the station, once the slot is yours.",
    );
  }

  // Pay at the petrol pump only, while online payment is switched off
  // (config/payments.js). Refused before anything is reserved.
  if (normalisePayMethod(body.payMethod) === "online" && !onlinePaymentsEnabled()) {
    throw new BookingError(400, "ONLINE_PAYMENT_DISABLED", ONLINE_PAYMENT_DISABLED_MSG);
  }

  await expireUserPastBookings(user.id);

  // ---- 4. the critical section --------------------------------------------
  const writeBooking = async (guards = []) => {
    const active = await Booking.exists({ user: user.id, status: { $in: ACTIVE_STATUSES } });
    if (active) {
      throw new BookingError(
        400,
        "ACTIVE_BOOKING_EXISTS",
        "You already have an active booking. Please complete or cancel it before booking a new slot.",
      );
    }

    // The earliest free position in the window on any of this fuel's app
    // nozzles, around every reservation and the nozzles' live use. Only this
    // fuel: Petrol, Diesel and CNG have separate nozzles.
    await require("../core/schedulingIndexes").ensureSchedulingIndexes();
    const position = await nozzleScheduler.allocateInWindow(stationId, fuel, bookingDate, timeSlot, { quantity, station });
    if (!position && !joinWaitlist) {
      metrics.inc("booking_conflict_count");
      throw new BookingError(400, "SLOT_FULL", "Every nozzle is fully booked in this time window.");
    }
    const waitlisted = !position && joinWaitlist;
    // A waitlisted booking keeps the window's own start until it is promoted.
    const placed = position || { start: window.start, end: window.end, resource: null };

    const doc = new Booking({
      user: user.id,
      station: stationId,
      stationName: station.name || null,
      userName: customer.name || null,
      userContact: customer.phone || customer.email || null,
      fuelType: label,
      quantity,
      price: pricing.price,
      taxes: pricing.taxes,
      amount: pricing.amount,
      bookingDate,
      timeSlot,
      startTime: formatHHMM(placed.start),
      endTime: formatHHMM(placed.end),
      bookingStartTime: placed.start,
      bookingEndTime: placed.end,
      resource: placed.resource,
      serviceDurationSeconds: window.durationSeconds,
      vehiclePlate: body.vehiclePlate ? String(body.vehiclePlate).trim().slice(0, 20) : undefined,
      ...normaliseVehicleSnapshot(body),
      payMethod: body.payMethod, // normalised to 'online' | 'station' by the schema setter
      paymentStatus: initialPaymentStatus(body.payMethod),
      // A waitlisted booking gets its PIN when it is promoted into a real slot.
      verificationCode: waitlisted ? undefined : String(crypto.randomInt(1000, 10000)),
      qrCodeData: crypto.randomBytes(16).toString("hex"),
      orderId: generateOrderId(),
      status: waitlisted ? "waitlisted" : "upcoming",
      waitlistPriority: waitlisted ? Date.now() : null,
    });
    // Keep the label the customer chose ("UPI", "FuelMart Wallet") for the receipt.
    doc.$locals.rawPayMethod = body.payMethod;

    // Every check above was made under these locks; do not write if either
    // has run out in the meantime, since another request may now hold it.
    for (const guard of guards) guard.assertHeld();

    const noStock = () =>
      new BookingError(
        409,
        "INSUFFICIENT_STOCK",
        `This station does not have enough ${label} left for ${quantity} ${fuelUnit(fuel)}.`,
      );

    if (waitlisted) {
      // No reservation while waiting (stock is reserved on promotion), but no
      // point waiting for fuel the station does not have to sell either.
      const fresh = await Station.findById(stationId).select("inventory inventoryCommitted").lean();
      const available = Number(fresh?.inventory?.[fuel]) - (Number(fresh?.inventoryCommitted?.[fuel]) || 0);
      if (!(available >= quantity)) throw noStock();
    } else {
      // Stock: one conditional increment of the station's committed quantity,
      // matched only while available stock (inventory - committed) covers this
      // booking. This is the database guard behind the station lock -- two
      // requests for the last litres cannot both succeed (services/inventory/stockLedger.js).
      if (!(await stockLedger.reserveStock(stationId, fuel, quantity))) throw noStock();
      doc.stockReserved = true;
    }

    try {
      await doc.save();
      // The lock serialised this fuel's bookings; if it was lost mid-way,
      // another server may have placed an overlapping booking on the same
      // nozzle. Check after the write and back out rather than double-book.
      if (!waitlisted) {
        const clash = await nozzleScheduler.hasOverlap(stationId, placed.start, placed.end, doc._id, {
          fuelType: fuel,
          resource: placed.resource,
        });
        if (clash) {
          await Booking.deleteOne({ _id: doc._id });
          metrics.inc("booking_db_guard_count");
          const e = new Error("overlap after write");
          e.code = 11000;
          throw e;
        }
      }
      if (waitlisted) {
        waitlist.enqueue(stationId, { bookingId: String(doc._id), user: String(user.id) }, doc.waitlistPriority);
        metrics.inc("booking_waitlisted_count");
      }
    } catch (err) {
      // The booking was not written, so its reservation must not stand.
      if (doc.stockReserved) {
        await stockLedger
          .unreserveStock(stationId, fuel, quantity)
          .catch((e) => console.error("[booking] failed to give back a reservation:", e.message));
      }
      // The database guards (models/Booking.js), reachable only if a lock
      // was bypassed or lost.
      if (err?.code === 11000) {
        metrics.inc("booking_db_guard_count");
        const byUser = Boolean(err.keyPattern?.user) || /uniq_active_booking_per_user/.test(err.message);
        if (byUser) {
          throw new BookingError(
            400,
            "ACTIVE_BOOKING_EXISTS",
            "You already have an active booking. Please complete or cancel it before booking a new slot.",
          );
        }
        throw new BookingError(400, "SLOT_FULL", "This slot was just taken.");
      }
      throw err;
    }
    return doc;
  };

  try {
    return await lock.withLock(
      `lock:user:${user.id}`,
      (userGuard) =>
        lock.withLock(require("../queue/nozzleService").nozzleKey(stationId, fuel), (nozzleGuard) => writeBooking([userGuard, nozzleGuard]), {
          ttlMs: 10_000,
          maxWaitMs: 3_000,
        }),
      { ttlMs: 15_000, maxWaitMs: 3_000 },
    );
  } catch (err) {
    if (err instanceof BookingError && err.reason === "SLOT_FULL") {
      // Worked out after the locks are released: it walks the day's labels
      // and must not stretch the critical section for everyone else.
      const suggested = await nozzleScheduler
        .findNextAvailableStart(stationId, fuel, bookingDate, timeSlot, { station, quantity })
        .catch(() => null);
      throw new BookingError(
        400,
        "SLOT_FULL",
        `${err.message} ${suggested ? `Next available: ${suggested}.` : "No later slot is free that day."}`,
        { requestedSlot: timeSlot, suggestedSlot: suggested || null, remainingSlots: 0 },
      );
    }
    if (err.code === "LOCK_TIMEOUT") {
      throw new BookingError(
        409,
        "NOZZLE_BUSY",
        `Another ${label} booking is being confirmed at this station right now. Please try again in a moment.`,
      );
    }
    if (err.code === "LOCK_EXPIRED") {
      throw new BookingError(
        409,
        "BOOKING_TIMEOUT",
        "Confirming your booking took too long, so nothing was saved. Please try again.",
      );
    }
    if (err.code === "LOCK_UNAVAILABLE") {
      throw new BookingError(503, "BOOKING_UNAVAILABLE", "Bookings are temporarily unavailable. Please try again shortly.");
    }
    throw err;
  }
}

/** Human-readable order reference, e.g. FM-2026-8F3A1C2B. */
function generateOrderId() {
  return `FM-${dateKey().slice(0, 4)}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

const round2 = (n) => Math.round(n * 100) / 100;

module.exports = {
  createCustomerBooking,
  priceBooking,
  validateInput,
  isSlotElapsed,
  expireUserPastBookings,
  BookingError,
  ACTIVE_STATUSES,
};
