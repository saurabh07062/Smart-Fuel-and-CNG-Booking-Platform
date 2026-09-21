/**
 * Booking business rules, in one place.
 *
 * Everything the server uses to price and accept a booking lives here, so
 * the frontend's copies (frontend/src/constants/booking.ts) are only
 * display hints: a request is always re-priced and re-validated against
 * these values.
 *
 * This module also owns the slot model: the bookable labels, how long a slot
 * lasts and when it has passed. The nozzle scheduler, the finder, booking
 * creation and the no-show sweep all read it from here.
 */

const { FUEL_SERVICE_DURATIONS_SECONDS, getServiceDurationSeconds } = require("./fuelDurations");
const { FUEL_KEYS } = require("./fuels");
const { dateKey, parseClock, atBusinessTime } = require("./businessTime");

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  }
  return n;
}

/** Litres (or kg for CNG) a single booking may reserve. */
const QUANTITY_MIN = 1;
const QUANTITY_MAX = 60;

/**
 * Flat convenience fee added to every booking, in rupees. This is the fee the
 * app has always charged; BOOKING_CONVENIENCE_FEE overrides it without a code
 * change.
 */
const CONVENIENCE_FEE = envNumber("BOOKING_CONVENIENCE_FEE", 5);

/**
 * Hard ceiling on booking requests per account per minute, checked before
 * any database work (routes/bookingRoutes.js). The risk engine's velocity
 * rule already notices more than 6 attempts in 10 minutes; this only stops a
 * script from making the server write and count attempt rows as fast as it
 * can send them. No person filling in the booking form comes close.
 */
const BOOKING_REQUESTS_PER_MINUTE = Math.max(1, envNumber("BOOKING_REQUESTS_PER_MINUTE", 20));

/**
 * Every start time a customer can book, India time, 30 minutes apart, across
 * the whole day. Each station's opening hours (Station.scheduleAllowsSlot)
 * decide which of them are open: a 24-hour station offers all of them, a
 * 06:00-22:00 one the 6:00 AM-9:30 PM ones.
 */
const BOOKABLE_SLOT_LABELS = Object.freeze([
  "12:00 AM", "12:30 AM", "1:00 AM", "1:30 AM", "2:00 AM", "2:30 AM",
  "3:00 AM", "3:30 AM", "4:00 AM", "4:30 AM", "5:00 AM", "5:30 AM",
  "6:00 AM", "6:30 AM", "7:00 AM", "7:30 AM", "8:00 AM", "8:30 AM",
  "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "11:00 AM", "11:30 AM",
  "12:00 PM", "12:30 PM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM",
  "3:00 PM", "3:30 PM", "4:00 PM", "4:30 PM", "5:00 PM", "5:30 PM",
  "6:00 PM", "6:30 PM", "7:00 PM", "7:30 PM", "8:00 PM", "8:30 PM",
  "9:00 PM", "9:30 PM", "10:00 PM", "10:30 PM", "11:00 PM", "11:30 PM",
]);
const SLOT_SPACING_SECONDS = 30 * 60;

// The labels really are SLOT_SPACING_SECONDS apart: slotEndInstant and the
// booking windows depend on it.
BOOKABLE_SLOT_LABELS.forEach((label, i) => {
  const c = parseClock(label);
  if (!c) throw new Error(`Unparseable slot label "${label}"`);
  if (i > 0) {
    const p = parseClock(BOOKABLE_SLOT_LABELS[i - 1]);
    if ((c.hours * 60 + c.minutes - (p.hours * 60 + p.minutes)) * 60 !== SLOT_SPACING_SECONDS) {
      throw new Error(`Slot labels must be ${SLOT_SPACING_SECONDS / 60} minutes apart ("${BOOKABLE_SLOT_LABELS[i - 1]}" -> "${label}")`);
    }
  }
});

/**
 * A slot label is a booking WINDOW ("10:00 AM" = 10:00-10:30). Inside it the
 * scheduler (services/queue/slotAllocator.js) gives each booking its own
 * start on one of the fuel's app nozzles, so a window holds as many
 * bookings as fit: nozzles x floor(window / service duration).
 *
 * SLOT_GRID_SECONDS is the resolution of those starts (default 30 s): the
 * first start in a free stretch sits on the grid, later ones follow
 * back-to-back. It is not a unit of capacity.
 */
const SLOT_GRID_SECONDS = (() => {
  const v = envNumber("SLOT_GRID_SECONDS", 30);
  if (!Number.isInteger(v) || v < 1 || v > SLOT_SPACING_SECONDS || SLOT_SPACING_SECONDS % v !== 0) {
    throw new Error(`SLOT_GRID_SECONDS must be a whole number of seconds that divides ${SLOT_SPACING_SECONDS}, got ${v}`);
  }
  return v;
})();

/** A fill must fit inside one window, or no booking of it could ever be placed. */
const longestService = Math.max(
  ...Object.values(FUEL_SERVICE_DURATIONS_SECONDS),
  ...FUEL_KEYS.map((fuel) => getServiceDurationSeconds(fuel, QUANTITY_MAX)),
);
if (longestService > SLOT_SPACING_SECONDS) {
  throw new Error(
    `A fuel service duration (${longestService}s) must fit inside one booking window ` +
      `(${SLOT_SPACING_SECONDS}s).`,
  );
}

/**
 * When a slot ends, India time: a label ("10:00 AM") ends one slot spacing
 * after it starts. An "HH:MM-HH:MM" range -- the shape some older bookings
 * were stored with -- ends at its second time. null for anything unparseable.
 */
function slotEndInstant(bookingDate, timeSlot) {
  const label = String(timeSlot || "").trim();
  if (!bookingDate || !label) return null;

  if (label.includes("-")) {
    const endText = label.split("-")[1].trim();
    const ampm = /(AM|PM)/i.exec(label)?.[0];
    const clock = parseClock(/am|pm/i.test(endText) || !ampm ? endText : `${endText} ${ampm}`);
    return clock ? atBusinessTime(bookingDate, clock.hours, clock.minutes) : null;
  }

  const clock = parseClock(label);
  const start = clock ? atBusinessTime(bookingDate, clock.hours, clock.minutes) : null;
  return start ? new Date(start.getTime() + SLOT_SPACING_SECONDS * 1000) : null;
}

/** Has this slot's time already gone by, in India time? A missing date has. */
function isSlotElapsed(bookingDate, timeSlot, now = new Date()) {
  if (!bookingDate) return true;
  const today = dateKey(now);
  if (bookingDate < today) return true;
  if (bookingDate > today) return false;
  if (!timeSlot) return false;
  const end = slotEndInstant(bookingDate, timeSlot);
  return end ? now > end : false;
}

/**
 * How far ahead a customer may book, in days after today (India date):
 * 2 = today, tomorrow and the day after. ADVANCE_BOOKING_DAYS overrides it;
 * read on each call so it can be changed per environment.
 */
function advanceBookingDays() {
  const v = envNumber("ADVANCE_BOOKING_DAYS", 2);
  if (!Number.isInteger(v)) throw new Error(`ADVANCE_BOOKING_DAYS must be a whole number of days, got "${process.env.ADVANCE_BOOKING_DAYS}"`);
  return v;
}

/** The last India date that can be booked now ("YYYY-MM-DD"). */
function lastBookableDate(now = new Date()) {
  return dateKey(new Date(now.getTime() + advanceBookingDays() * 24 * 60 * 60 * 1000));
}

/** Is this "YYYY-MM-DD" further ahead than bookings are accepted? */
function isBeyondAdvanceWindow(bookingDate, now = new Date()) {
  return String(bookingDate) > lastBookableDate(now);
}

module.exports = {
  advanceBookingDays,
  lastBookableDate,
  isBeyondAdvanceWindow,
  QUANTITY_MIN,
  QUANTITY_MAX,
  CONVENIENCE_FEE,
  BOOKING_REQUESTS_PER_MINUTE,
  BOOKABLE_SLOT_LABELS,
  SLOT_SPACING_SECONDS,
  SLOT_GRID_SECONDS,
  slotEndInstant,
  isSlotElapsed,
};
