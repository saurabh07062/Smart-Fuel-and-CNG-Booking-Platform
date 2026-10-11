const express = require("express");
const router = express.Router();
const bookingController = require("../controllers/bookingController");
const auth = require("../middleware/auth");
const vendorAuth = require("../middleware/vendor");

// ---- booking request ceiling ------------------------------------------------
// Checked after auth (so it is per account) and before any database work.
// Refused requests write no attempt row; the first refusal in 10 minutes is
// logged as a `booking-rate` security event for the admin report.
const { rateLimit } = require("../services/security/rateLimiter");
const { BOOKING_REQUESTS_PER_MINUTE } = require("../config/booking");

const RATE_EVENT_DEDUPE_MS = 10 * 60_000;

async function logBookingRateLimited(userId) {
  if (!userId) return;
  const SecurityEvent = require("../models/SecurityEvent");
  require("../services/core/metrics").inc("booking_rate_limited_count");
  // Atomic once-per-window write: refusals arrive in bursts, and a
  // check-then-insert would log the same burst several times.
  await SecurityEvent.recordOnce(
    {
      rule: "booking-rate",
      reason: `More than ${BOOKING_REQUESTS_PER_MINUTE} booking requests in a minute`,
      score: 100,
      threshold: 100,
      action: "blocked",
      user: userId,
      route: "POST /api/bookings",
    },
    { windowMs: RATE_EVENT_DEDUPE_MS },
  );
}

const bookingRequestLimiter = rateLimit({
  limit: BOOKING_REQUESTS_PER_MINUTE,
  windowMs: 60_000,
  keyPrefix: "booking-create",
  keyFn: (req) => req.user?.id || req.ip,
  onLimited: (req) => logBookingRateLimited(req.user?.id),
});

router.post("/", auth, bookingRequestLimiter, bookingController.createBooking);
router.get("/", auth, bookingController.getUserBookings);
router.get("/availability", bookingController.getAvailability);

/**
 * Fleet booking -- several vehicles in one go (controllers/fleetController.js).
 *
 * Mounted BEFORE "/:id" on purpose: Express matches in order, and "/fleet"
 * would otherwise be read as a booking id and answered with "not found".
 *
 * Confirming writes several bookings at once, so it is limited harder than a
 * single booking: a group is a deliberate, occasional action, and this is the
 * one endpoint where a script could create ten bookings per request.
 */
const fleetController = require("../controllers/fleetController");
const fleetPlanLimiter = rateLimit({
  limit: Number(process.env.FLEET_PLANS_PER_MINUTE) || 20,
  windowMs: 60_000,
  keyPrefix: "fleet-plan",
  keyFn: (req) => req.user?.id || req.ip,
});
const fleetCreateLimiter = rateLimit({
  limit: Number(process.env.FLEET_BOOKINGS_PER_HOUR) || 10,
  windowMs: 60 * 60_000,
  keyPrefix: "fleet-create",
  keyFn: (req) => req.user?.id || req.ip,
});

router.post("/fleet/plan", auth, fleetPlanLimiter, fleetController.plan);
router.post("/fleet/plan-vehicle", auth, fleetPlanLimiter, fleetController.planVehicle);
router.post("/fleet", auth, fleetCreateLimiter, fleetController.create);
router.get("/fleet", auth, fleetController.list);
router.get("/fleet/:id", auth, fleetController.get);

router.get("/:id", auth, bookingController.getBookingById);
// Completing a booking at the pump: an activated vendor (for their own
// stations) or an admin. Never anonymous -- see verifyBooking.
router.post("/verify", vendorAuth, bookingController.verifyBooking);
router.patch("/:id/cancel", auth, bookingController.cancelBooking);
// The customer, at the pump, marks their arrival (services/booking/stationArrival.js).
router.post("/:id/station-check-in", auth, bookingController.stationCheckIn);

module.exports = router;
