/**
 * "Check In at Petrol Pump": the customer, standing at the station, marks
 * their arrival from the app. That fixes the order in which people reached
 * the station, so the attendant serves them first-come-first-served instead
 * of whoever reaches the counter first.
 *
 * The arrival is not the start of service: fuelling still starts when the
 * attendant verifies the PIN / QR (bookingController.verifyBooking ->
 * services/queue/nozzleService.js). Until then the booking is only marked
 * `stationCheckInAt`, and the attendant is warned before serving someone who
 * arrived later (earlierArrivals below).
 *
 * Checks, all on the server:
 *   - the customer's own booking, still upcoming, for today (India date)
 *   - from EARLY_CHECKIN_MINUTES before the slot until the slot is over
 *   - the phone's position within CHECKIN_RADIUS_M of the station's saved location
 *   - once only: a repeat returns the first check-in unchanged
 */
const Booking = require("../../models/Booking");
const Station = require("../../models/Station");
const geo = require("../algorithms/geo");
const { dateKey } = require("../../config/businessTime");
const { slotEndInstant } = require("../../config/booking");
const nozzleScheduler = require("../queue/nozzleScheduler");
const { onlineResources } = require("../../config/nozzleModes");

function envNumber(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
/** How close to the station (metres) a check-in must be. */
const radiusM = () => envNumber("CHECKIN_RADIUS_M", 300);
/** How long before the slot starts a customer may check in. */
const earlyMinutes = () => envNumber("EARLY_CHECKIN_MINUTES", 30);
/**
 * TEMPORARY, for testing away from the station: CHECKIN_DEMO_MODE=true skips
 * the location, distance and early-window checks (own booking, upcoming and
 * today still apply).
 *
 * IGNORED IN PRODUCTION, whatever the environment says.
 *
 * "Must be off in production" was a comment, and a comment does not switch
 * anything off. These are the checks that make a check-in mean "this customer
 * is physically at this station", so a .env copied from a developer's machine
 * to a server must not be able to disable them -- the flag is read only when
 * NODE_ENV is not "production", and src/config/auth.js refuses to start a
 * production server that sets it at all.
 */
const demoMode = () =>
  process.env.NODE_ENV !== "production" &&
  String(process.env.CHECKIN_DEMO_MODE || "").toLowerCase() === "true";

class ArrivalError extends Error {
  constructor(status, reason, message, extra = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.extra = extra;
  }
}

const stationCoord = (s) => {
  if (s?.coordinates && geo.isCoord(s.coordinates)) return s.coordinates;
  const c = s?.location?.coordinates;
  if (Array.isArray(c) && c.length === 2) return { lat: c[1], lng: c[0] };
  return null;
};

const fmt = (d) =>
  new Date(d).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });

/**
 * @param {object} p
 * @param {string} p.bookingId
 * @param {string} p.userId
 * @param {number} p.lat
 * @param {number} p.lng
 * @param {Date}   [p.now]
 * @returns {Promise<{booking:object, alreadyCheckedIn:boolean, distanceM:number}>}
 */
async function stationCheckIn({
  bookingId,
  userId,
  lat,
  lng,
  now = new Date(),
}) {
  const booking = await Booking.findOne({ _id: bookingId, user: userId });
  if (!booking) throw new ArrivalError(404, "NOT_FOUND", "Booking not found");
  if (booking.stationCheckInAt) {
    return {
      booking,
      alreadyCheckedIn: true,
      distanceM: booking.stationCheckInDistanceM ?? null,
    };
  }
  if (booking.status !== "upcoming") {
    throw new ArrivalError(
      409,
      "NOT_UPCOMING",
      `This booking is ${booking.status}; there is nothing to check in.`,
    );
  }

  const today = dateKey(now);
  if (booking.bookingDate !== today) {
    throw new ArrivalError(
      409,
      booking.bookingDate > today ? "NOT_TODAY" : "DATE_PASSED",
      booking.bookingDate > today
        ? `This booking is for ${booking.bookingDate}. Check in on that day.`
        : "This booking's date has passed.",
    );
  }

  const slotStart = nozzleScheduler.parseStartDateTime(
    booking.bookingDate,
    booking.timeSlot,
  );
  const opensAt = slotStart
    ? new Date(slotStart.getTime() - earlyMinutes() * 60_000)
    : null;
  if (!demoMode() && opensAt && now < opensAt) {
    throw new ArrivalError(
      409,
      "TOO_EARLY",
      `Check-in opens at ${fmt(opensAt)}, ${earlyMinutes()} minutes before your ${booking.timeSlot} slot.`,
      {
        opensAt,
      },
    );
  }
  const slotEnd = slotEndInstant(booking.bookingDate, booking.timeSlot);
  if (slotEnd && now >= slotEnd) {
    throw new ArrivalError(409, "SLOT_OVER", "Your slot has ended.");
  }

  let distanceM = null;
  if (demoMode()) {
    // Demo: no location needed; a position sent is still measured, for the record.
    const station = await Station.findById(booking.station)
      .select("coordinates location")
      .lean();
    const at = stationCoord(station);
    if (at && geo.isCoord({ lat, lng }) && !(lat === 0 && lng === 0))
      distanceM = Math.round(geo.haversineKm({ lat, lng }, at) * 1000);
  } else {
    if (!geo.isCoord({ lat, lng }) || (lat === 0 && lng === 0)) {
      throw new ArrivalError(
        400,
        "LOCATION_REQUIRED",
        "Turn on location so the app can confirm you are at the station.",
      );
    }
    const station = await Station.findById(booking.station)
      .select("coordinates location name")
      .lean();
    const at = stationCoord(station);
    if (!at)
      throw new ArrivalError(
        409,
        "STATION_LOCATION_UNKNOWN",
        "This station has no saved location. Please show your PIN to the attendant.",
      );
    distanceM = Math.round(geo.haversineKm({ lat, lng }, at) * 1000);
    if (distanceM > radiusM()) {
      throw new ArrivalError(
        409,
        "TOO_FAR",
        `You are about ${distanceM >= 1000 ? `${(distanceM / 1000).toFixed(1)} km` : `${distanceM} m`} from ${station.name}. Check in when you reach the pump.`,
        {
          distanceM,
          radiusM: radiusM(),
        },
      );
    }
  }

  // Once only, and only while still upcoming: a concurrent tap or a vendor
  // action in between cannot be overwritten.
  const updated = await Booking.findOneAndUpdate(
    {
      _id: booking._id,
      user: userId,
      status: "upcoming",
      stationCheckInAt: null,
    },
    { $set: { stationCheckInAt: now, stationCheckInDistanceM: distanceM } },
    { returnDocument: "after" },
  );
  if (!updated) {
    const current = await Booking.findById(booking._id);
    if (current?.stationCheckInAt)
      return {
        booking: current,
        alreadyCheckedIn: true,
        distanceM: current.stationCheckInDistanceM,
      };
    throw new ArrivalError(
      409,
      "NOT_UPCOMING",
      "This booking changed. Refresh and try again.",
    );
  }

  /**
   * A fleet arrives together, so one tap checks the group in.
   *
   * The vans came in a convoy to one station for one visit, and the customer
   * holds ONE code for all of them (services/booking/fleetBooking.js). Making
   * them tap five times -- while the attendant waits -- to satisfy a rule
   * meant to prove they are at the pump would be ceremony: the proof is the
   * same location, at the same moment, for every van in the group.
   *
   * Only the customer's OWN group, only today's live members, and only ones
   * not already checked in. A failure here does not undo the booking that was
   * just checked in: the group's remaining vans can still be checked in by
   * their own tap or by the attendant's override.
   */
  let groupCheckedIn = 0;
  if (updated.fleetGroup) {
    try {
      const rest = await Booking.updateMany(
        {
          fleetGroup: updated.fleetGroup,
          user: userId,
          _id: { $ne: updated._id },
          status: "upcoming",
          bookingDate: today,
          stationCheckInAt: null,
        },
        { $set: { stationCheckInAt: now, stationCheckInDistanceM: distanceM } },
      );
      groupCheckedIn = rest.modifiedCount || 0;
    } catch (err) {
      console.error("[arrival] could not check in the rest of the fleet:", err.message);
    }
  }

  return { booking: updated, alreadyCheckedIn: false, distanceM, groupCheckedIn };
}

/**
 * Customers who checked in at the station BEFORE `booking` and are still
 * waiting for the attendant (same station and fuel, not yet at a nozzle),
 * when there is no free app nozzle left for them all. Serving `booking` now
 * would jump them. Empty when nobody is jumped.
 */
async function earlierArrivals(booking, { now = new Date() } = {}) {
  const mine = booking.stationCheckInAt
    ? new Date(booking.stationCheckInAt)
    : now;
  const stationId = booking.station?._id ?? booking.station;
  const waiting = await Booking.find({
    _id: { $ne: booking._id },
    station: stationId,
    fuelType: booking.fuelType,
    bookingDate: dateKey(now),
    status: "upcoming",
    arrivalTime: null, // not yet verified at the pump
    stationCheckInAt: { $ne: null, $lt: mine },
  })
    .sort({ stationCheckInAt: 1 })
    // fleetGroup travels with the row so a caller can tell a stranger from
    // the customer's OWN other vehicles: a fleet checking itself in must not
    // be told that it is jumping its own vans
    // (controllers/bookingController.js verifyFleetGroup).
    .select("_id orderId vehiclePlate stationCheckInAt timeSlot user fleetGroup")
    .populate("user", "name")
    .lean();
  if (waiting.length === 0) return [];

  // Nozzles still free for app bookings: online, less those fuelling or held
  // by a car already verified and waiting.
  const station = await Station.findById(stationId)
    .select("nozzleConfig")
    .lean();
  const nozzles = onlineResources(station, booking.fuelType);
  const busy = await Booking.countDocuments({
    station: stationId,
    fuelType: booking.fuelType,
    $or: [
      { status: "serving" },
      { status: "upcoming", arrivalTime: { $ne: null } },
    ],
  });
  const free = Math.max(0, nozzles - busy);
  return waiting.length >= free ? waiting : [];
}

module.exports = {
  stationCheckIn,
  earlierArrivals,
  ArrivalError,
  radiusM,
  earlyMinutes,
  demoMode,
};
