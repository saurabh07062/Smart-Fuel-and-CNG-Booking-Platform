/**
 * Slot booking + queue lifecycle.  Mounted at /api/v1/slots
 *
 * Thin HTTP layer: all the interesting logic (locking, inventory checks,
 * waitlist promotion, ETA recalculation) lives in services/booking/booking.js so it
 * can be tested without spinning up Express.
 */

const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const Booking = require("../models/Booking");
const Station = require("../models/Station");
const bookingService = require("../services/booking/booking");
const lock = require("../services/core/lock");
const upi = require("../services/payment/upi");
const smartRecommender = require("../services/station/smartRecommender");
const { rateLimit } = require("../services/security/rateLimiter");

// Cheaper than the risk engine's DB queries, so it runs first: a script
// hammering /book gets a 429 before ever touching the booking pipeline.
const bookLimiter = rateLimit({ limit: 8, windowMs: 60_000, keyPrefix: "book", keyFn: (req) => req.user?.id || req.ip });

/**
 * GET /api/v1/slots/recommend-alternative
 *
 * For the exact booking a customer is about to make, a station that serves it
 * better, or `alternative: null`. The booking wizard shows this; the decision
 * is made here (services/station/smartRecommender.js findWorthItAlternatives), not in
 * the browser.
 */
router.get("/recommend-alternative", async (req, res) => {
  const { stationId, date, timeSlot, fuelType, quantity, lat, lng, minTimeSaved } = req.query || {};

  if (!stationId || !date || !timeSlot || !fuelType) {
    return res.status(400).json({ msg: "stationId, date, timeSlot and fuelType are required query params" });
  }

  // The quantity decides whether an alternative has enough stock, so it is
  // required rather than assumed to be 10 L.
  const { QUANTITY_MIN, QUANTITY_MAX } = require("../config/booking");
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty < QUANTITY_MIN || qty > QUANTITY_MAX) {
    return res.status(400).json({ msg: `quantity is required, between ${QUANTITY_MIN} and ${QUANTITY_MAX}` });
  }

  try {
    const origin =
      Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
        ? { lat: Number(lat), lng: Number(lng) }
        : null;

    const result = await smartRecommender.findWorthItAlternatives({
      targetStationId: stationId,
      origin,
      bookingDate: String(date),
      timeSlot: String(timeSlot),
      fuelType: String(fuelType),
      quantity: qty,
      opts: {
        minTimeSavedMinutes: Number(minTimeSaved) || undefined,
      },
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("[slots] recommend-alternative failed:", err);
    res.status(status).json({ msg: err.message || "Failed to find alternatives" });
  }
});

/**
 * POST /api/v1/slots/book -- RETIRED.
 *
 * This path created bookings by counting slot capacity, without the
 * single-nozzle interval check, so it could double-book a nozzle that
 * POST /api/bookings had correctly refused. No client used it. There is now
 * exactly one way to create a booking: POST /api/bookings.
 */
router.post("/book", auth, bookLimiter, (req, res) => {
  res.status(410).json({
    status: "rejected",
    reason: "ENDPOINT_RETIRED",
    msg: "This booking endpoint has been retired. Create bookings with POST /api/bookings.",
  });
});

/** POST /api/v1/slots/:bookingId/cancel */
router.post("/:bookingId/cancel", auth, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.bookingId).select("user");
    if (!booking) return res.status(404).json({ msg: "Booking not found" });

    // A customer may only cancel their own booking.
    if (String(booking.user) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ msg: "Not your booking" });
    }

    const result = await bookingService.cancelBooking({
      bookingId: req.params.bookingId,
      io: req.app.get("io"),
      cancelledBy: req.user.role === "admin" ? "admin" : "customer",
    });
    res.status(result.status === "rejected" ? 409 : 200).json(result);
  } catch (err) {
    console.error("[slots] cancel failed:", err);
    res.status(500).json({ msg: "Cancellation failed" });
  }
});

/**
 * POST /api/v1/slots/:bookingId/serve
 * Vendor-only: marks the vehicle as served and cascades the queue update.
 */
router.post("/:bookingId/serve", auth, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.bookingId).select("station");
    if (!booking) return res.status(404).json({ msg: "Booking not found" });

    const station = await Station.findById(booking.station).select("owner");
    const isOwner = station && String(station.owner) === String(req.user.id);
    if (!isOwner && req.user.role !== "admin") {
      return res.status(403).json({ msg: "Only the station owner can mark a booking served" });
    }

    const result = await bookingService.markServed({
      bookingId: req.params.bookingId,
      io: req.app.get("io"),
      servedBy: req.user.id,
      // Lets the attendant record "served but not paid" instead of being
      // forced to mark cash collected that they did not receive.
      collectPayment: req.body?.collectPayment !== false,
    });
    res.status(result.status === "rejected" ? 409 : 200).json(result);
  } catch (err) {
    console.error("[slots] serve failed:", err);
    res.status(500).json({ msg: "Failed to mark served" });
  }
});

/**
 * GET /api/v1/slots/availability -- RETIRED.
 *
 * Counted bookings against a per-station slotCapacity and availableTimeSlots
 * list, a capacity model booking never enforced, so it could show a slot as
 * open that POST /api/bookings refuses. No client used it. Real availability
 * is GET /api/bookings/availability.
 */
router.get("/availability", (req, res) => {
  res.status(410).json({
    reason: "ENDPOINT_RETIRED",
    msg: "This endpoint has been retired. Use GET /api/bookings/availability?stationId=&fuelType=&date=.",
  });
});

/**
 * GET /api/v1/slots/:bookingId/upi
 *
 * The UPI intent for a pay-at-station booking, so the customer can scan and
 * pay the exact amount at the pump. The QR itself is rendered client-side from
 * `uri` — encoding an image here would be larger and no more useful.
 */
router.get("/:bookingId/upi", auth, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.bookingId);
    if (!booking) return res.status(404).json({ msg: "Booking not found" });

    // Payment details are per-customer; do not let one user pull another's.
    const isOwner = String(booking.user) === String(req.user.id);
    if (!isOwner && !["admin", "vendor"].includes(req.user.role)) {
      return res.status(403).json({ msg: "Not your booking" });
    }

    if (booking.paymentStatus === "paid") {
      return res.status(409).json({ msg: "This booking is already paid", paid: true });
    }
    if (booking.payMethod !== "station") {
      return res.status(409).json({ msg: "This booking is not a pay-at-station booking" });
    }

    const station = await Station.findById(booking.station).select(
      "name upiId upiName acceptsUpi",
    );
    if (!station) return res.status(404).json({ msg: "Station not found" });

    if (station.acceptsUpi === false) {
      return res.status(409).json({
        msg: "This station is not accepting UPI. Please pay the attendant by cash or card.",
        code: "UPI_DISABLED",
      });
    }

    const payment = await upi.buildBookingPayment(booking, station);
    if (payment.error) {
      return res.status(503).json({ msg: payment.error, code: "UPI_NOT_CONFIGURED" });
    }

    res.json({
      bookingId: String(booking._id),
      stationName: station.name,
      verificationCode: booking.verificationCode,
      ...payment,
    });
  } catch (err) {
    console.error("[slots] upi failed:", err);
    res.status(500).json({ msg: "Could not build the payment link" });
  }
});

/**
 * GET /api/v1/slots/waitlist/:stationId -- who is waiting at a station, in
 * the order they will be promoted. The station's owner or an admin only:
 * entries carry customers' names and plates. Read from the bookings
 * themselves, the source of truth.
 */
router.get("/waitlist/:stationId", auth, async (req, res) => {
  try {
    const station = await Station.findById(req.params.stationId).select("owner").lean();
    if (!station) return res.status(404).json({ msg: "Station not found" });
    if (req.user.role !== "admin" && String(station.owner) !== String(req.user.id)) {
      return res.status(403).json({ msg: "Not your station" });
    }
    const entries = await Booking.find({ station: station._id, status: "waitlisted" })
      .sort({ waitlistPriority: 1, createdAt: 1 })
      .select("_id bookingDate timeSlot fuelType quantity vehiclePlate userName createdAt")
      .lean();
    res.json({ stationId: String(station._id), length: entries.length, entries });
  } catch (err) {
    if (err.name === "CastError") return res.status(404).json({ msg: "Station not found" });
    console.error("[slots] waitlist failed:", err);
    res.status(500).json({ msg: "Could not load the waitlist" });
  }
});

/** GET /api/v1/slots/health — surfaces whether locking is truly distributed. */
router.get("/health", async (_req, res) => {
  await lock.init();
  res.json({
    lockMode: lock.getMode(),
    distributed: lock.isDistributed(),
    warning: lock.isDistributed()
      ? null
      : "In-process locking active. Safe for a single server only — set REDIS_URL before running multiple instances.",
  });
});

module.exports = router;
