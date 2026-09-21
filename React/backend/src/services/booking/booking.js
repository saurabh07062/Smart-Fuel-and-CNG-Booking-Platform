/**
 * Booking lifecycle after creation: serving, cancelling, waitlist promotion,
 * and live queue/ETA recalculation.
 *
 * Booking CREATION is not here. It lives in services/booking/bookingCreate.js, the
 * single path used by POST /api/bookings. Completion (status + stock
 * deduction, exactly once) lives in services/booking/bookingCompletion.js.
 */

const crypto = require("crypto");
const Booking = require("../../models/Booking");
const Station = require("../../models/Station");
const { waitlist } = require("../queue/waitlist");
const { completeBooking, COMPLETABLE_STATUSES } = require("./bookingCompletion");
const stockLedger = require("../inventory/stockLedger");
const nozzleScheduler = require("../queue/nozzleScheduler");
const lock = require("../core/lock");
const realtime = require("../notification/realtime");
const notifications = require("../notification/notifications");
const { normaliseFuel } = require("../../config/fuels");
const { isSlotElapsed } = require("../../config/booking");
const { transitionBooking, currentStatus } = require("./bookingTransitions");

/**
 * Vendor marks a customer as served.
 *
 * Completes the booking (reducing the station's stock), settles a
 * pay-at-station payment if collected, promotes the next waitlisted customer
 * and recalculates the ETA for everyone still queued behind.
 */
async function markServed({ bookingId, io, servedBy, collectPayment = true }) {
  const existing = await Booking.findById(bookingId);
  if (!existing) return reject("Booking not found");
  if (existing.status === "completed") {
    return { status: "rejected", reason: "Booking already completed" };
  }
  if (!COMPLETABLE_STATUSES.includes(existing.status)) {
    return { status: "rejected", reason: `Booking is ${existing.status} and cannot be served` };
  }

  // A pay-at-station booking settles here: the attendant took the money at
  // the pump, so serving it IS the payment event. Online bookings are already
  // 'paid' by the time they reach the pump and must not be touched.
  const set = {};
  let collected = null;
  if (existing.payMethod === "station" && existing.paymentStatus === "due_at_station") {
    if (collectPayment) {
      set.paymentStatus = "paid";
      set.collectedBy = servedBy || null;
      set.collectedAt = new Date();
      collected = { amount: existing.amount, method: "station" };
    } else {
      // Vendor explicitly served without collecting — leave it owed rather
      // than silently marking it paid.
      collected = { amount: existing.amount, method: "station", outstanding: true };
    }
  }

  const booking = await completeBooking({ bookingId, set });
  if (!booking) return { status: "rejected", reason: "Booking already completed" };

  // Low-stock alerts are raised by the completion itself (services/inventory/stockLedger.js).
  await emitBookingChange(realtime.EVENTS.BOOKING_COMPLETED, booking);
  // The car is done: the next one waiting at the pump gets the nozzle.
  await require("../queue/serviceTimer").releaseNozzle(booking.station, { refresh: false, fuelType: booking.fuelType });
  const promoted = await promoteFromWaitlist(booking.station, io);
  await recalculateQueue(booking.station, io);

  return { status: "completed", booking, promoted, collected };
}

/**
 * Waitlist promotion.
 *
 * A waitlisted booking asks for one exact nozzle window (its date and slot),
 * so "the head of the station's queue" is the wrong customer whenever the
 * freed window is a different one. The database is the source of truth:
 * waiting bookings at the station, first come first served
 * (waitlistPriority, then createdAt), and each one is promoted only if --
 * right now, under the same nozzle lock booking creation takes --
 *
 *   - its slot has not passed (a lapsed one is the sweep's to expire)
 *   - its nozzle window no longer overlaps a live booking
 *   - the station still has the stock, which is reserved as for a new booking
 *
 * Each fuel has its own nozzle, so each fuel's waitlist is promoted under
 * that fuel's lock. The DB unique indexes (models/Booking.js) stay the final
 * guard. Returns the first promoted booking, or null.
 */
async function promoteFromWaitlist(stationId, io, { now = new Date() } = {}) {
  if (!stationId) return null;
  const { nozzleKey } = require("../queue/nozzleService");
  const fuels = await Booking.distinct("fuelType", { station: stationId, status: "waitlisted" });
  const promoted = [];
  for (const fuelType of fuels) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one fuel's lock at a time
      const list = await lock.withLock(nozzleKey(stationId, fuelType), () => promoteWithinLock(stationId, fuelType, now), {
        ttlMs: 10_000,
        maxWaitMs: 3_000,
      });
      promoted.push(...list);
    } catch (err) {
      // A booking is being written for this nozzle right now. Nothing is lost:
      // the next cancellation, status change or sweep tries again.
      console.error(`[waitlist] ${fuelType} promotion skipped for station ${stationId}:`, err.message);
    }
  }

  for (const booking of promoted) await announcePromotion(booking, io);
  return promoted[0] || null;
}

async function promoteWithinLock(stationId, fuelType, now) {
  const waiting = await Booking.find({ station: stationId, fuelType, status: "waitlisted" })
    .sort({ waitlistPriority: 1, createdAt: 1 })
    .select("_id station fuelType quantity bookingDate timeSlot bookingStartTime bookingEndTime")
    .lean();

  const promoted = [];
  for (const w of waiting) {
    if (isSlotElapsed(w.bookingDate, w.timeSlot, now)) continue;
    // The earliest free position left in its window (a cancellation or a
    // finished fill frees one), on any of the fuel's app nozzles.
    const position = await nozzleScheduler.allocateInWindow(w.station, w.fuelType, w.bookingDate, w.timeSlot, {
      quantity: w.quantity,
      now,
    });
    if (!position) continue;

    const fuel = normaliseFuel(w.fuelType);
    // A promoted booking takes stock like a new one does, or is not promoted.
    if (!(await stockLedger.reserveStock(w.station, fuel, w.quantity))) continue;

    // Conditional: only a booking still waitlisted is promoted. null also
    // covers a promotion the nozzle or one-active-booking index refuses.
    const booking = await transitionBooking({
      bookingId: w._id,
      to: "upcoming",
      from: ["waitlisted"],
      set: {
        verificationCode: generateCode(),
        waitlistPriority: null,
        stockReserved: true,
        bookingStartTime: position.start,
        bookingEndTime: position.end,
        resource: position.resource,
      },
    });
    if (!booking) {
      await stockLedger.unreserveStock(w.station, fuel, w.quantity);
      continue;
    }
    waitlist.cancel(stationId, String(w._id));
    promoted.push(booking);
  }
  return promoted;
}

/** A booking change to its customer, its station's vendor and admins -- never broadcast. */
async function emitBookingChange(event, booking) {
  try {
    const station = await Station.findById(booking.station).select("owner").lean();
    realtime.bookingChanged(event, booking, { stationOwner: station?.owner });
  } catch (err) {
    console.error(`[booking] ${event} emit failed for ${booking?._id}:`, err.message);
  }
}

/** Tell the customer (live and in their bell) and the station's owner. */
async function announcePromotion(booking, io) {
  try {
    const station = await Station.findById(booking.station).select("owner name").lean();
    realtime.bookingChanged(realtime.EVENTS.BOOKING_UPDATED, booking, { stationOwner: station?.owner });
    await notifications.notify({
      user: booking.user,
      type: "booking_promoted",
      title: "You got your slot",
      body: `${station?.name || "The station"} · ${booking.bookingDate} ${booking.timeSlot}. Show your PIN at the pump.`,
      link: "booking",
      booking: booking._id,
      station: booking.station,
      dedupeKey: `booking:${booking._id}:promoted`,
    });
  } catch (err) {
    console.error(`[waitlist] announcing promotion of ${booking._id} failed:`, err.message);
  }
  emit(io, `user:${booking.user}`, "booking_promoted", {
    bookingId: String(booking._id),
    station: String(booking.station),
    slot: booking.timeSlot,
  });
}

/**
 * A waitlisted booking's place in line for its own slot: 1 + the bookings
 * waiting for the same nozzle start that joined earlier. Returns plain
 * objects with `waitlistPosition` set on the waitlisted ones.
 */
async function attachWaitlistPositions(bookings = []) {
  const plain = bookings.map((b) => (b && typeof b.toObject === "function" ? b.toObject() : b));
  for (const b of plain) {
    if (!b || b.status !== "waitlisted" || !b.bookingStartTime) continue;
    const ahead = await Booking.countDocuments({
      station: b.station?._id || b.station,
      status: "waitlisted",
      bookingStartTime: b.bookingStartTime,
      _id: { $ne: b._id },
      $or: [
        { waitlistPriority: { $lt: b.waitlistPriority } },
        { waitlistPriority: b.waitlistPriority, createdAt: { $lt: b.createdAt } },
      ],
    });
    b.waitlistPosition = ahead + 1;
  }
  return plain;
}

/**
 * Recompute the station's wait time and push it to everyone watching.
 *
 * Called after any event that changes the queue, which is what makes the
 * customer's ETA live rather than a number frozen at booking time.
 */
async function recalculateQueue(stationId, _io) {
  // The one queue model (services/queue/stationQueue.js): today's real bookings on
  // the app nozzle, not every active booking on any date with an assumed
  // 5-minute service. It also sends the addressed ETA and queue events.
  return require("../queue/stationQueue").refreshStationQueue(stationId);
}

async function cancelBooking({ bookingId, io, cancelledBy = null }) {
  const existing = await Booking.findById(bookingId).select("status").lean();
  if (!existing) return reject("Booking not found");

  const wasWaitlisted = existing.status === "waitlisted";
  const booking = await transitionBooking({
    bookingId,
    to: "cancelled",
    set: { cancelledAt: new Date(), cancelledBy },
  });
  if (!booking) {
    const now = await currentStatus(bookingId);
    return { status: "rejected", reason: `Booking is ${now || "gone"} and cannot be cancelled` };
  }

  await emitBookingChange(realtime.EVENTS.BOOKING_CANCELLED, booking);

  if (wasWaitlisted) {
    waitlist.cancel(booking.station, String(booking._id));
  } else {
    // A confirmed booking freeing up means someone on the waitlist moves in.
    await promoteFromWaitlist(booking.station, io);
  }

  await recalculateQueue(booking.station, io);
  return { status: "cancelled", booking };
}

/** Rebuild in-memory waitlists from the DB after a restart. */
async function restoreWaitlists() {
  const pending = await Booking.find({ status: "waitlisted" })
    .sort({ createdAt: 1 })
    .select("_id station user timeSlot bookingDate createdAt")
    .lean();

  waitlist.rebuildFrom(
    pending.map((b) => ({ ...b, slot: b.timeSlot, date: b.bookingDate })),
  );
  return pending.length;
}

function emit(io, room, event, payload) {
  if (!io) return;
  try {
    if (room) io.to(room).emit(event, payload);
    else io.emit(event, payload);
  } catch (err) {
    console.error(`[booking] emit ${event} failed:`, err.message);
  }
}

function reject(reason) {
  return { status: "rejected", reason };
}

/** 4-digit attendant code, from a cryptographic source. */
function generateCode() {
  return String(crypto.randomInt(1000, 10000));
}

module.exports = {
  markServed,
  cancelBooking,
  recalculateQueue,
  promoteFromWaitlist,
  attachWaitlistPositions,
  restoreWaitlists,
};
