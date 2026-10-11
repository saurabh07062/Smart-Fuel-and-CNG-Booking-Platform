/**
 * What the chatbot and the support threads know about the person asking.
 *
 * EVERY FIGURE HERE COMES FROM THE EXISTING SYSTEM
 *
 * Nothing in this file computes a queue position, a wait, an ETA, a price or a
 * stock level of its own. It calls the services that already own those
 * answers -- services/queue/queueInfo.js, services/queue/stationQueue.js,
 * services/booking, the Station document -- so the chatbot cannot disagree
 * with the booking screen. A second implementation would eventually say
 * something different from the app, and the one place a customer would notice
 * is while standing at a pump.
 *
 * AND NOTHING IS INVENTED
 *
 * Where a figure is genuinely unknown -- a price the vendor has not published,
 * a queue that cannot be read right now -- the field is null and the caller
 * says so in words. There is no default, no placeholder and no "about 5
 * minutes". `available: false` on a section means "this could not be read",
 * which is a different statement from "there is nothing".
 */

const { normaliseFuel, fuelUnit } = require("../../config/fuels");

const ACTIVE_BOOKING_STATUSES = ["upcoming", "serving", "waitlisted"];

/** A plain object from a document or a lean row. */
const plain = (doc) => (typeof doc?.toObject === "function" ? doc.toObject() : doc);

/**
 * The booking a customer is currently dealing with, with its live queue
 * figures -- or null when they have none.
 *
 * "Currently" means upcoming, being served, or waitlisted, soonest first: the
 * one they would ask about. A completed booking is history and is not treated
 * as active, because "where is my booking" about a finished fill is a
 * different question and gets a different answer.
 */
async function activeBookingFor(userId, { now = new Date() } = {}) {
  const Booking = require("../../models/Booking");
  const booking = await Booking.findOne({ user: userId, status: { $in: ACTIVE_BOOKING_STATUSES } })
    .populate("station", "name address contactPhone owner prices fuelAvailability status coordinates")
    .sort({ bookingStartTime: 1, createdAt: 1 });
  if (!booking) return null;

  // The five live figures the booking screen shows (vehicles ahead, position,
  // wait, start, ETA). The same call the customer's own booking list makes.
  const [withInfo] = await require("../queue/queueInfo").withQueueInfo([booking], { now });
  return withInfo;
}

/**
 * The booking summary a chatbot shows and a support thread attaches.
 *
 * Only this customer's own booking is ever read (the caller passes the
 * signed-in id and it is part of the query), and only the fields that belong
 * to them: their reference, fuel, station, slot, queue position, wait, ETA,
 * check-in and payment state. The PIN is included because it is theirs and the
 * app already shows it to them -- but only once they have checked in at the
 * pump, which is the only time it does anything
 * (controllers/bookingController.js).
 */
function bookingSummary(bookingWithInfo) {
  const b = plain(bookingWithInfo);
  if (!b) return null;

  const station = plain(b.station) || null;
  const queue = b.queueInfo || null;
  const checkedIn = Boolean(b.stationCheckInAt);

  return {
    bookingId: String(b._id),
    reference: b.orderId || null,
    status: b.status,
    fuelType: b.fuelType,
    quantity: b.quantity ?? null,
    unit: fuelUnit(normaliseFuel(b.fuelType)) || "L",
    amount: b.amount ?? null,
    pricePerUnit: b.price ?? null,
    bookingDate: b.bookingDate || null,
    timeSlot: b.timeSlot || null,
    startTime: b.startTime || null,
    endTime: b.endTime || null,
    station: station
      ? {
          stationId: String(station._id),
          name: station.name || null,
          address: station.address || null,
          // The number at the pump, when the station recorded one. Never a
          // placeholder: an empty string means "not recorded" (models/Station.js).
          phone: station.contactPhone || null,
          status: station.status || null,
        }
      : null,
    vehiclePlate: b.vehiclePlate || null,
    // Live queue figures, or null when the queue cannot be read for this
    // booking (a waitlisted booking has no nozzle window yet).
    // The field names are queueInfo's own (services/queue/queueInfo.js), passed
    // through rather than renamed: one vocabulary for the queue across the app.
    queue: queue
      ? {
          queuePosition: queue.queuePosition ?? null,
          vehicleCountAhead: queue.vehicleCountAhead ?? null,
          expectedWaitingSeconds: queue.expectedWaitingSeconds ?? null,
          expectedWaitingTime: queue.expectedWaitingTime ?? null,
          estimatedStartTime: queue.estimatedStartTime ?? null,
          estimatedStartAt: queue.estimatedStartAt ?? null,
        }
      : null,
    etaMinutes: b.etaMinutes ?? null,
    checkIn: {
      done: checkedIn,
      at: b.stationCheckInAt || null,
      distanceM: b.stationCheckInDistanceM ?? null,
    },
    payment: {
      method: b.payMethod || null,
      methodLabel: b.payMethodDetail || null,
      status: b.paymentStatus || null,
      collectedAt: b.collectedAt || null,
    },
    /**
     * The 4-digit code, and whether it will work yet.
     *
     * Shown only to its own customer (this whole object is built from their own
     * booking), and `usable` is the truth about it rather than an encouraging
     * guess: the attendant's PIN entry is refused until the customer has
     * checked in at the station.
     */
    pin: b.verificationCode
      ? { code: String(b.verificationCode), usable: checkedIn }
      : null,
    qrCodeData: b.qrCodeData || null,
  };
}

/**
 * The snapshot attached to the first message of a support thread.
 *
 * Deliberately small and deliberately frozen: enough for an admin to see what
 * the customer was looking at when they wrote, without becoming a second copy
 * of the booking. models/Message.js explains why this one thing is a snapshot
 * when everything else here is live.
 */
async function bookingSnapshot(bookingId, userId, { role = "customer" } = {}) {
  const Booking = require("../../models/Booking");
  const filter = { _id: bookingId };
  // A customer may only attach their own booking. A vendor may only attach one
  // at a station they own -- checked by the caller, which has the station list.
  if (role === "customer") filter.user = userId;

  const booking = await Booking.findOne(filter).populate("station", "name address owner").lean();
  if (!booking) return null;

  const station = booking.station || null;
  return {
    bookingId: String(booking._id),
    reference: booking.orderId || null,
    fuelType: booking.fuelType,
    quantity: booking.quantity ?? null,
    amount: booking.amount ?? null,
    bookingDate: booking.bookingDate || null,
    timeSlot: booking.timeSlot || null,
    status: booking.status,
    paymentStatus: booking.paymentStatus || null,
    checkedIn: Boolean(booking.stationCheckInAt),
    station: station ? { stationId: String(station._id), name: station.name || null, address: station.address || null } : null,
    capturedAt: new Date(),
  };
}

/** The station owner a customer may contact about a booking, or null. */
async function vendorForBooking(booking) {
  const Station = require("../../models/Station");
  const stationId = booking?.station?._id || booking?.station;
  if (!stationId) return null;
  const station = await Station.findById(stationId).select("name owner").lean();
  if (!station?.owner) return null; // an imported pump with no vendor account
  return { vendorId: String(station.owner), stationId: String(station._id), stationName: station.name || null };
}

module.exports = {
  ACTIVE_BOOKING_STATUSES,
  activeBookingFor,
  bookingSummary,
  bookingSnapshot,
  vendorForBooking,
  plain,
};
