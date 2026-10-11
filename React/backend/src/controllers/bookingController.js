const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Station = require("../models/Station");
const User = require("../models/User");
const SecurityEvent = require("../models/SecurityEvent");
const emailService = require("../services/notification/emailService");
const nozzleScheduler = require("../services/queue/nozzleScheduler");
const realtime = require("../services/notification/realtime");
const notifications = require("../services/notification/notifications");
const rateLimiter = require("../services/security/rateLimiter");
const metrics = require("../services/core/metrics");
const { completeBooking } = require("../services/booking/bookingCompletion");
const { transitionBooking, currentStatus } = require("../services/booking/bookingTransitions");
const { refreshStationQueue } = require("../services/queue/stationQueue");
const bookingService = require("../services/booking/booking");
const nozzleService = require("../services/queue/nozzleService");
const { dateKey } = require("../config/businessTime");
const {
  createCustomerBooking,
  expireUserPastBookings,
  BookingError,
} = require("../services/booking/bookingCreate");

/**
 * Publish a station change to the people it concerns.
 *
 * realtime.stationChanged sends a trimmed public view to the customers
 * watching that station, and the full record only to its owner and to admins.
 */
function emitStationEvent(req, event, payload) {
  try {
    realtime.stationChanged(event, payload);
  } catch (e) {
    console.error("Socket emit error:", e);
  }
}

/** A booking change to its customer, its station's vendor and admins -- never broadcast. */
async function emitBookingChange(event, booking) {
  try {
    const station = await Station.findById(booking.station).select("owner").lean();
    realtime.bookingChanged(event, booking, { stationOwner: station && station.owner });
  } catch (e) {
    console.error(`[Booking] ${event} emit failed:`, e.message);
  }
}

/**
 * POST /api/bookings
 *
 * All business rules (validation, risk, server-side pricing, locking, nozzle
 * overlap, the database guard) live in services/booking/bookingCreate.js. This
 * handler maps its result to HTTP and runs the post-commit side effects.
 */
exports.createBooking = async (req, res) => {
  let booking;
  try {
    booking = await createCustomerBooking({ user: req.user, body: req.body });
  } catch (err) {
    if (err instanceof BookingError) {
      if (err.extra?.retryAfterSeconds) res.set("Retry-After", String(err.extra.retryAfterSeconds));
      return res.status(err.status).json({ success: false, reason: err.reason, msg: err.message, ...err.extra });
    }
    // A missing required field is the caller's mistake, not a server fault.
    if (err.name === "ValidationError") {
      const fields = Object.keys(err.errors || {});
      console.warn(`[Booking] validation failed: ${fields.join(", ")}`);
      return res.status(400).json({ msg: `Missing or invalid: ${fields.join(", ")}`, fields });
    }
    if (err.name === "CastError") {
      return res.status(400).json({ msg: `Invalid ${err.path}: ${err.value}` });
    }
    console.error("[Booking] create failed:", err);
    return res.status(500).json({ msg: "Could not create booking" });
  }

  // ---- post-commit side effects --------------------------------------------
  // The booking is saved. Nothing below may turn that into an error response.
  const stationId = String(booking.station);

  // On the waitlist: not a booking the station has to prepare for yet, so no
  // vendor alert, confirmation email or queue change -- just the customer's
  // own record of where they stand.
  if (booking.status === "waitlisted") {
    let withPosition = booking;
    try {
      [withPosition] = await bookingService.attachWaitlistPositions([booking]);
      await notifications.notify({
        user: booking.user,
        type: "booking_waitlisted",
        title: "You're on the waitlist",
        body: `${booking.stationName || "Station"} · ${booking.bookingDate} ${booking.timeSlot} · #${withPosition.waitlistPosition} in line`,
        link: "booking",
        booking: booking._id,
        station: stationId,
        dedupeKey: `booking:${booking._id}:waitlisted`,
      });
    } catch (e) {
      console.error("[Booking] waitlist post-commit failed:", e.message);
    }
    return res.json({ msg: "Added to the waitlist", booking: withPosition });
  }

  try {
    // Addressed, not broadcast: a booking payload carries the customer's name,
    // plate and amount.
    const stationOwnerDoc = await Station.findById(stationId).select("owner").lean();
    realtime.bookingChanged(realtime.EVENTS.BOOKING_CREATED, booking, {
      stationOwner: stationOwnerDoc && stationOwnerDoc.owner,
    });

    /**
     * The customer's own record that the booking was confirmed.
     *
     * Written HERE, after the booking has been saved and its slot, nozzle and
     * stock reservation are all committed -- so a notification exists only for
     * a booking the backend actually confirmed. A booking that was refused
     * (no slot, no stock, a lost lock) throws long before this line and
     * notifies nobody; a waitlisted one took the branch above and is told it
     * is waiting, not that it is booked.
     *
     * Every value comes from the saved row: the station's stored name, the
     * date and slot the server allocated, the fuel and the amount it priced.
     * Nothing here is composed from what the client asked for.
     */
    await notifications.notify({
      user: booking.user,
      type: "booking_created",
      title: "Booking confirmed",
      body: [
        booking.stationName,
        `${booking.fuelType} ${booking.quantity} ${require("../config/fuels").fuelUnit(booking.fuelType) || "L"}`,
        `${booking.bookingDate} ${booking.timeSlot}`,
        booking.verificationCode ? `PIN ${booking.verificationCode}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      link: "booking",
      booking: booking._id,
      station: stationId,
      // One per booking, however many times this path is reached.
      dedupeKey: `booking:${booking._id}:confirmed`,
    });

    // The vendor's notification bell, so a booking placed while their
    // dashboard was shut is still waiting for them.
    if (stationOwnerDoc && stationOwnerDoc.owner) {
      await notifications.notify({
        user: stationOwnerDoc.owner,
        type: "booking_created",
        title: "New booking received",
        body: `${booking.fuelType || "Fuel"} · ${booking.timeSlot || ""} · ₹${booking.amount || 0}`,
        link: "vendor-panel",
        booking: booking._id,
        station: stationId,
        dedupeKey: `booking:${booking._id}:created`,
      });
    }
  } catch (e) {
    console.error("[Booking] post-commit notify failed:", e.message);
  }

  // Live queue and ETAs from the one queue model (services/queue/stationQueue.js),
  // which also sends the queue event.
  try {
    const refreshed = await refreshStationQueue(stationId);
    if (refreshed?.station) emitStationEvent(req, realtime.EVENTS.STATION_UPDATED, refreshed.station);
  } catch (e) {
    console.error("Failed to refresh station queue on booking:", e);
  }

  res.json({ msg: "Booking created", booking });

  // Confirmation email, after the response: an SMTP round trip took several
  // seconds and the customer was waiting on it for a booking already saved.
  User.findById(req.user.id)
    .select("email name")
    .then((userDoc) => (userDoc?.email ? emailService.sendBookingConfirmation(userDoc, booking) : null))
    .catch((mailErr) => console.error("[Booking] ⚠️ Email failed (booking still saved):", mailErr.message));
};

// GET /api/bookings/availability?stationId=&fuelType=&date=
// Every bookable label for one station/fuel/day, each with `bookable` and a
// `reason` when not (PASSED, CLOSED, RESERVED) -- the same rules
// POST /api/bookings applies (services/queue/nozzleScheduler.js generateAvailability).
exports.getAvailability = async (req, res) => {
  try {
    const { stationId, fuelType, date } = req.query;
    const { normaliseFuel } = require("../config/fuels");
    const { parseDateKey } = require("../config/businessTime");

    if (!stationId || !mongoose.isValidObjectId(stationId)) {
      return res.status(400).json({ msg: "A valid stationId is required" });
    }
    const fuel = normaliseFuel(fuelType);
    if (!fuel) return res.status(400).json({ msg: "fuelType must be Petrol, Diesel or CNG" });
    if (!parseDateKey(date)) return res.status(400).json({ msg: "date must be a YYYY-MM-DD date" });
    const bookingRules = require("../config/booking");
    if (bookingRules.isBeyondAdvanceWindow(date)) {
      return res.status(400).json({
        msg: `Bookings open only ${bookingRules.advanceBookingDays()} days ahead.`,
        reason: "DATE_TOO_FAR",
        lastBookableDate: bookingRules.lastBookableDate(),
      });
    }

    const station = await Station.findById(stationId).select("status operatingSchedule openingHours").lean();
    if (!station) return res.status(404).json({ msg: "Station not found" });

    // Optional quantity: the window of that exact fill instead of a typical one.
    const { QUANTITY_MIN, QUANTITY_MAX } = require("../config/booking");
    const qty = Number(req.query.quantity);
    const quantity = Number.isFinite(qty) && qty >= QUANTITY_MIN && qty <= QUANTITY_MAX ? qty : undefined;
    const slots = await nozzleScheduler.generateAvailability(stationId, fuel, date, { station, quantity });
    // fuelType is echoed as sent: the booking page matches its cached response on it.
    res.json({ stationId, fuelType, date, stationActive: station.status === "Active", slots });
  } catch (err) {
    console.error("[Booking] availability failed:", err);
    res.status(500).json({ msg: "Server error fetching availability" });
  }
};

exports.getUserBookings = async (req, res) => {
  try {
    await expireUserPastBookings(req.user.id);

    const bookings = await Booking.find({ user: req.user.id })
      .populate("station", "name address images coordinates location")
      .sort({ createdAt: -1 });
    // Vehicles ahead, position, wait and start (services/queue/queueInfo.js).
    res.json(await require("../services/queue/queueInfo").withQueueInfo(await bookingService.attachWaitlistPositions(bookings)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error" });
  }
};

// GET /api/bookings/:id - get single booking details
exports.getBookingById = async (req, res) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.id, user: req.user.id }).populate("station", "name address coordinates location");
    if (!booking) return res.status(404).json({ msg: "Booking not found" });
    const [withInfo] = await require("../services/queue/queueInfo").withQueueInfo([booking]);
    res.json(withInfo);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
};

/** Attempts one attendant/admin account may make in the window below. */
const VERIFY_ATTEMPT_LIMIT = 30;
const VERIFY_WINDOW_MS = 15 * 60_000;

/**
 * POST /api/bookings/verify   (vendor or admin; see routes/bookingRoutes.js)
 *
 * Completes a booking at the pump from its QR (bookingId) or 4-digit code.
 *
 * A short code is only safe with context, so:
 *   - the caller must be an activated vendor (or an admin)
 *   - a vendor can only reach bookings at stations they own
 *   - a code alone only matches TODAY's (India date) live bookings at those
 *     stations
 *   - an ambiguous code (two bookings share it today) is refused
 *   - attempts are rate-limited per account, and exceeding the limit is
 *     recorded as a security event
 *
 * Completion goes through services/booking/bookingCompletion.js, which also deducts
 * the dispensed fuel from the station's stock.
 */
/** "This booking is for tomorrow (Fri, 18 Sep) at 6:00 AM. Ask the customer to come back then." */
function comeBackMessage(booking, today) {
  const at = new Date(`${booking.bookingDate}T12:00:00Z`);
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const label = at.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const when = booking.bookingDate === tomorrow.toISOString().slice(0, 10) ? `tomorrow (${label})` : label;
  const come = booking.bookingDate === tomorrow.toISOString().slice(0, 10) ? "come back tomorrow" : "come back on that day";
  return `This booking is for ${when} at ${booking.timeSlot}. Ask the customer to ${come} at ${booking.timeSlot}.`;
}

exports.verifyBooking = async (req, res) => {
  const route = "POST /api/bookings/verify";
  try {
    const limit = await rateLimiter.check(`verify:${req.user.id}`, VERIFY_ATTEMPT_LIMIT, VERIFY_WINDOW_MS);
    if (!limit.allowed) {
      metrics.inc("verification_rate_limited_count");
      await SecurityEvent.create({
        rule: "verification-rate",
        reason: `More than ${VERIFY_ATTEMPT_LIMIT} verification attempts in 15 minutes`,
        score: 100,
        threshold: 100,
        action: "blocked",
        user: req.user.id,
        route,
      }).catch(() => {});
      return res.status(429).json({
        success: false,
        msg: "Too many verification attempts. Please wait a few minutes and try again.",
      });
    }

    const { bookingId } = req.body || {};
    const code = req.body?.verificationCode != null ? String(req.body.verificationCode).trim() : "";

    if (!bookingId && !code) {
      return res.status(400).json({ success: false, msg: "Scan the booking QR or enter its 4-digit code." });
    }
    if (code && !/^\d{4}$/.test(code)) {
      return res.status(400).json({ success: false, msg: "The verification code must be 4 digits." });
    }
    if (bookingId && !mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, msg: "That QR code is not a FuelMart booking." });
    }

    const isAdmin = req.user.role === "admin";
    const scope = {};
    if (!isAdmin) {
      const owned = await Station.find({ owner: req.user.id }).select("_id").lean();
      scope.station = { $in: owned.map((s) => s._id) };
    }

    const today = dateKey();
    const notFound = () => {
      metrics.inc("verification_failed_count");
      return res.status(404).json({ success: false, msg: "No booking at your station(s) uses this code. Check the 4 digits with the customer." });
    };

    let matches;
    if (bookingId) {
      matches = await Booking.find({ _id: bookingId, ...scope }).limit(1);
      if (matches.length && code && matches[0].verificationCode !== code) return notFound();
    } else {
      matches = await Booking.find({
        verificationCode: code,
        bookingDate: today,
        status: { $in: ["upcoming", "serving"] },
        ...scope,
      })
        // More than two, because a fleet booking shares ONE code across its
        // vehicles (services/booking/fleetBooking.js) and all of them are a
        // legitimate match. The limit is only a bound on a hostile query.
        .limit(20);
    }

    // No booking today with this code: it may be a valid booking for another
    // day (e.g. booked late at night for tomorrow's first slot). Say so instead
    // of "no matching booking", which reads as a wrong code.
    if (matches.length === 0 && !bookingId) {
      const other = await Booking.findOne({
        verificationCode: code,
        status: { $in: ["upcoming", "serving"] },
        ...scope,
      })
        .sort({ bookingDate: 1 })
        .select("bookingDate timeSlot")
        .lean();
      if (other) {
        metrics.inc("verification_failed_count");
        return res.status(409).json({
          success: false,
          reason: other.bookingDate > today ? "NOT_TODAY" : "DATE_PASSED",
          bookingDate: other.bookingDate,
          timeSlot: other.timeSlot,
          msg: other.bookingDate > today ? comeBackMessage(other, today) : "This booking's date has passed.",
        });
      }
    }
    if (matches.length === 0) return notFound();
    if (matches.length > 1) {
      // A fleet booking's vehicles share one code on purpose, so several
      // matches is the normal case for a group -- but only when they really
      // are ONE group. Two unrelated bookings that happen to share four
      // digits is the old ambiguity, and is still refused.
      const groups = new Set(matches.map((b) => (b.fleetGroup ? String(b.fleetGroup) : null)));
      if (groups.size === 1 && !groups.has(null)) {
        return verifyFleetGroup({ req, res, matches, isAdmin, today });
      }
      return res.status(409).json({
        success: false,
        msg: "More than one booking today uses this code. Scan the customer's QR code instead.",
      });
    }

    const booking = matches[0];
    if (booking.status === "completed") {
      return res.status(409).json({ success: false, msg: "Booking already completed" });
    }
    if (!["upcoming", "serving"].includes(booking.status)) {
      return res.status(409).json({ success: false, msg: `This booking is ${booking.status} and cannot be verified.` });
    }
    if (booking.bookingDate !== today) {
      return res.status(409).json({
        success: false,
        msg:
          booking.bookingDate > today
            ? `This booking is for ${booking.bookingDate}, not today.`
            : "This booking's date has passed.",
      });
    }
    // A station booking is legitimately unpaid until the attendant collects,
    // so only online bookings must already be settled to be checked in.
    if (booking.paymentStatus !== "paid" && booking.payMethod !== "station") {
      return res.status(400).json({ success: false, msg: "Payment not completed" });
    }
    if (booking.status === "serving") {
      return res.status(409).json({ success: false, msg: "This booking is already checked in and fueling." });
    }

    // The PIN only works once the customer has arrived and tapped "Check In
    // at Petrol Pump" in their app (services/booking/stationArrival.js).
    //
    // Without this the code is a number that works from anywhere: someone
    // could read it out over the phone and have their fill started while they
    // are still driving, which takes the nozzle away from whoever is actually
    // standing at the pump and makes the arrival order -- the whole point of
    // check-in -- meaningless.
    //
    // An admin can still override, because support exists for the case where
    // the customer's own app cannot check in (no signal, dead battery).
    const supportOverride = isAdmin && req.body?.override === true;
    if (!booking.stationCheckInAt && !supportOverride) {
      return res.status(409).json({
        success: false,
        reason: "NOT_CHECKED_IN",
        msg: "Ask the customer to tap \"Check In at Petrol Pump\" in their app first. The code works once they have checked in here.",
      });
    }

    // Scanning the QR / entering the code at the pump is the CHECK-IN, through
    // the nozzle lock (services/queue/nozzleService.js): nozzle free -> fueling
    // starts now; nozzle busy -> the car waits at the pump and starts by
    // itself the moment the car ahead finishes. The booking completes when its
    // fuel's service time has run, and that completion is when stock is
    // deducted (services/booking/bookingCompletion.js).
    // First come, first served: a customer who checked in at the station
    // earlier ("Check In at Petrol Pump") and is still waiting would be
    // jumped. Tell the attendant; they can still go ahead (override), e.g.
    // when that customer has left.
    if (req.body?.override !== true) {
      const earlier = await require("../services/booking/stationArrival").earlierArrivals(booking);
      if (earlier.length > 0) {
        const first = earlier[0];
        const at = new Date(first.stationCheckInAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
        return res.status(409).json({
          success: false,
          reason: "EARLIER_ARRIVAL",
          msg: `${first.user?.name || "Another customer"}${first.vehiclePlate ? ` (${first.vehiclePlate})` : ""} checked in at the pump first, at ${at}. Serve them first, or continue anyway.`,
          earlier: earlier.map((e) => ({
            bookingId: String(e._id),
            orderId: e.orderId || null,
            customer: e.user?.name || null,
            vehiclePlate: e.vehiclePlate || null,
            stationCheckInAt: e.stationCheckInAt,
            timeSlot: e.timeSlot,
          })),
        });
      }
    }

    const now = new Date();
    // Check-in does not record the payment: a pay-at-station booking stays
    // owed until the attendant says how it was paid (cash or UPI at the pump)
    // through "Collect payment" (vendorPanelController.collectBookingPayment).
    let result;
    try {
      result = await nozzleService.checkIn({ bookingId: booking._id, now });
    } catch (lockErr) {
      if (lockErr.code === "LOCK_TIMEOUT" || lockErr.code === "LOCK_EXPIRED") {
        return res
          .status(409)
          .json({ success: false, msg: "The pump is being updated for another car right now. Scan again in a moment." });
      }
      if (lockErr.code === "LOCK_UNAVAILABLE") {
        return res.status(503).json({ success: false, msg: "Check-in is temporarily unavailable. Please try again shortly." });
      }
      throw lockErr;
    }
    if (result.outcome === "already_serving") {
      return res.status(409).json({ success: false, msg: "This booking is already checked in and fueling." });
    }
    if (!result.booking) {
      return res
        .status(409)
        .json({ success: false, msg: "This booking was just changed by someone else. Refresh and try again." });
    }
    const checkedIn = result.booking;
    await checkedIn.populate([
      { path: "user", select: "name" },
      { path: "station", select: "name owner" },
    ]);

    metrics.inc("verification_success_count");
    // The customer's booking screen switches to its fueling countdown live.
    try {
      realtime.bookingChanged(realtime.EVENTS.BOOKING_UPDATED, checkedIn, {
        stationOwner: checkedIn.station?.owner,
      });
    } catch (e) {
      console.error("[Booking] check-in emit failed:", e.message);
    }
    await refreshStationQueue(checkedIn.station._id || checkedIn.station).catch((e) =>
      console.error("Failed to refresh station queue after check-in:", e.message),
    );
    if (result.outcome === "started") {
      return res.json({
        success: true,
        started: true,
        msg: "Checked in. Fueling has started.",
        booking: checkedIn,
        completesAt: result.releaseAt,
      });
    }
    const freeInSeconds = result.nozzleFreeAt ? Math.max(0, Math.ceil((new Date(result.nozzleFreeAt) - now) / 1000)) : null;
    res.json({
      success: true,
      queued: true,
      msg:
        result.outcome === "already_waiting"
          ? "Already checked in. Waiting for the nozzle -- fueling starts automatically."
          : `Checked in. The nozzle is busy${freeInSeconds !== null ? ` (free in about ${freeInSeconds} s)` : ""} -- fueling starts automatically when it is released.`,
      booking: checkedIn,
      nozzleFreeAt: result.nozzleFreeAt,
    });
  } catch (err) {
    console.error("[Booking] verify failed:", err);
    res.status(500).json({ success: false, msg: "Server Error" });
  }
};

/**
 * One code, a whole fleet: the attendant typed the group's PIN.
 *
 * Reached from verifyBooking when a code matches several bookings that are all
 * members of ONE group. Every rule a single check-in is held to still applies,
 * per vehicle, inside services/booking/fleetCheckIn.js -- this function is the
 * HTTP shape around it: confirm the group really is one group at this station,
 * run the check-in, announce what changed, and answer with what happened to
 * each vehicle.
 *
 * Nothing about slots, durations or queue order is decided here.
 */
async function verifyFleetGroup({ req, res, matches, isAdmin, today }) {
  const fleetCheckIn = require("../services/booking/fleetCheckIn");
  const groupId = matches[0].fleetGroup;

  // Today only, as for a single booking.
  const wrongDay = matches.find((b) => b.bookingDate !== today);
  if (wrongDay) {
    return res.status(409).json({
      success: false,
      msg:
        wrongDay.bookingDate > today
          ? `This fleet booking is for ${wrongDay.bookingDate}, not today.`
          : "This fleet booking's date has passed.",
    });
  }

  // Everything still live in the group, read fresh as documents.
  const members = await fleetCheckIn.liveMembers(groupId);
  if (members.length === 0) return res.status(409).json({ success: false, msg: "This fleet booking has nothing left to check in." });

  // The attendant may only check in vehicles at their OWN station: the scope
  // that found `matches` already enforced that, and every member of a group
  // shares one station, but it is asserted rather than assumed.
  const stationIds = new Set(members.map((m) => String(m.station)));
  const allowed = new Set(matches.map((m) => String(m.station)));
  if (stationIds.size !== 1 || !allowed.has([...stationIds][0])) {
    return res.status(404).json({ success: false, msg: "No booking at your station(s) uses this code." });
  }

  // Nobody has arrived yet: the same refusal, and the same admin override, a
  // single booking gets.
  const supportOverride = isAdmin && req.body?.override === true;
  if (!supportOverride && !members.some((m) => m.stationCheckInAt)) {
    metrics.inc("verification_failed_count");
    return res.status(409).json({
      success: false,
      reason: "NOT_CHECKED_IN",
      msg: 'Ask the customer to tap "Check In at Petrol Pump" in their app first. The code works once they have checked in here.',
    });
  }

  // Fairness between customers, judged once for the group: another customer
  // who checked in earlier and is still waiting would be jumped by starting
  // this fleet now. The attendant can still continue (override).
  if (req.body?.override !== true) {
    const first = members.find((m) => m.status === "upcoming" && m.stationCheckInAt) || members[0];
    const earlier = await require("../services/booking/stationArrival").earlierArrivals(first);
    const outsiders = earlier.filter((e) => String(e.fleetGroup || "") !== String(groupId));
    if (outsiders.length > 0) {
      const at = new Date(outsiders[0].stationCheckInAt).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "Asia/Kolkata",
      });
      return res.status(409).json({
        success: false,
        reason: "EARLIER_ARRIVAL",
        msg: `${outsiders[0].user?.name || "Another customer"}${outsiders[0].vehiclePlate ? ` (${outsiders[0].vehiclePlate})` : ""} checked in at the pump first, at ${at}. Serve them first, or continue anyway.`,
        earlier: outsiders.map((e) => ({
          bookingId: String(e._id),
          orderId: e.orderId || null,
          customer: e.user?.name || null,
          vehiclePlate: e.vehiclePlate || null,
          stationCheckInAt: e.stationCheckInAt,
          timeSlot: e.timeSlot,
        })),
      });
    }
  }

  const outcome = await fleetCheckIn.checkInGroup({ bookings: members, allowNotCheckedIn: supportOverride });

  // Nothing moved: say why, using the reasons the members carried.
  if (outcome.started.length === 0 && outcome.queued.length === 0) {
    metrics.inc("verification_failed_count");
    return res.status(409).json({
      success: false,
      reason: outcome.skipped[0]?.reason || "NOT_CHECKED_IN",
      msg: fleetCheckIn.describeOutcome(outcome),
      vehicles: outcome,
    });
  }

  metrics.inc("verification_success_count");

  // Each vehicle's own screens update, exactly as a single check-in does.
  const touched = await Booking.find({ _id: { $in: [...outcome.started, ...outcome.queued].map((v) => v.bookingId) } })
    .populate("user", "name")
    .populate("station", "name owner");
  for (const booking of touched) {
    try {
      realtime.bookingChanged(realtime.EVENTS.BOOKING_UPDATED, booking, { stationOwner: booking.station?.owner });
    } catch (err) {
      console.error("[Booking] fleet check-in emit failed:", err.message);
    }
  }
  await refreshStationQueue(members[0].station).catch((err) =>
    console.error("Failed to refresh station queue after fleet check-in:", err.message),
  );

  return res.json({
    success: true,
    fleet: true,
    fleetGroup: String(groupId),
    started: outcome.started.length > 0,
    queued: outcome.queued.length > 0,
    vehicles: outcome,
    msg: fleetCheckIn.describeOutcome(outcome),
  });
}

/**
 * POST /api/bookings/:id/station-check-in -- "Check In at Petrol Pump".
 * Body: { latitude, longitude } from the phone. Validated on the server
 * (services/booking/stationArrival.js): own booking, today, within the
 * check-in window, and within reach of the station.
 */
exports.stationCheckIn = async (req, res) => {
  const { stationCheckIn, ArrivalError } = require("../services/booking/stationArrival");
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ msg: "Booking not found" });
    const lat = Number(req.body?.latitude);
    const lng = Number(req.body?.longitude);
    const result = await stationCheckIn({ bookingId: req.params.id, userId: req.user.id, lat, lng });

    if (!result.alreadyCheckedIn) {
      // The vendor's list and the station's line update live.
      try {
        await result.booking.populate({ path: "station", select: "owner" });
        realtime.bookingChanged(realtime.EVENTS.BOOKING_UPDATED, result.booking, { stationOwner: result.booking.station?.owner });
      } catch (e) {
        console.error("[Booking] station check-in emit failed:", e.message);
      }
      await refreshStationQueue(result.booking.station?._id || result.booking.station).catch(() => {});
    }
    const [withInfo] = await require("../services/queue/queueInfo").withQueueInfo([result.booking]);
    res.json({
      msg: result.alreadyCheckedIn ? "You are already checked in." : "Checked in. Show your PIN to the attendant when called.",
      alreadyCheckedIn: result.alreadyCheckedIn,
      distanceM: result.distanceM,
      booking: withInfo,
    });
  } catch (err) {
    if (err instanceof ArrivalError) {
      return res.status(err.status).json({ reason: err.reason, msg: err.message, ...err.extra });
    }
    console.error("[Booking] station check-in failed:", err);
    res.status(500).json({ msg: "Could not check you in. Please try again." });
  }
};

exports.cancelBooking = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ msg: "Booking not found" });

    const before = await currentStatus(req.params.id, { user: req.user.id });
    // Optional: why the customer cancelled. Anything outside the list is ignored.
    const CANCEL_REASONS = ["plans_changed", "wrong_slot", "too_far", "long_wait", "other"];
    const cancelReason = CANCEL_REASONS.includes(req.body?.reason) ? req.body.reason : undefined;

    // One conditional write: if the booking stopped being "upcoming" or
    // "waitlisted" (the vendor started serving it, a sweep completed it)
    // nothing is overwritten.
    const booking = await transitionBooking({
      bookingId: req.params.id,
      to: "cancelled",
      from: ["upcoming", "waitlisted"],
      filter: { user: req.user.id },
      // Who cancelled matters to the risk engine: only a customer's own
      // cancellations describe the customer's behaviour.
      set: { cancelledAt: new Date(), cancelledBy: "customer", ...(cancelReason ? { cancelReason } : {}) },
    });
    if (!booking) {
      const status = await currentStatus(req.params.id, { user: req.user.id });
      if (!status) return res.status(404).json({ msg: "Booking not found" });
      return res
        .status(400)
        .json({ msg: `Only upcoming or waitlisted bookings can be cancelled (this one is ${status})` });
    }

    // The station's vendor and admins see the cancellation live, and the
    // customer's other open tabs update too.
    await emitBookingChange(realtime.EVENTS.BOOKING_CANCELLED, booking);

    if (before === "waitlisted") {
      require("../services/queue/waitlist").waitlist.cancel(booking.station, String(booking._id));
      return res.json({ msg: "Left the waitlist", booking });
    }

    // A cancelled reservation frees its nozzle window: the first customer
    // waiting for that window gets it.
    await bookingService.promoteFromWaitlist(booking.station);

    // A cancellation frees the nozzle: refresh the queue and everyone's ETA.
    try {
      const refreshed = await refreshStationQueue(booking.station);
      if (refreshed?.station) emitStationEvent(req, "station_updated", refreshed.station);
    } catch (e) {
      console.error("Failed to refresh station queue on cancel:", e);
    }

    res.json({ msg: "Booking cancelled successfully", booking });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
};
