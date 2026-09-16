/**
 * Interval scheduling, one app nozzle per fuel.
 *
 * Each station has exactly one nozzle allocated to app bookings for EACH fuel
 * it sells: one Petrol nozzle, one Diesel nozzle, one CNG nozzle. A booking
 * occupies a non-overlapping slice of its own fuel's nozzle timeline; a CNG
 * booking never blocks a Petrol one. Vendor-recorded walk-ins (models/WalkIn.js)
 * use the same nozzle as that fuel's bookings.
 *
 * A requested [start, end) window is available only if NO existing active
 * booking for that station AND fuel overlaps it:
 *
 *   requestedStart < existingEnd  AND  requestedEnd > existingStart
 *
 * Slot labels ("10:00 AM") are India time (config/businessTime.js); the
 * window is stored as UTC instants.
 */

const Booking = require("../../models/Booking");
const Station = require("../../models/Station");
const WalkIn = require("../../models/WalkIn");
const { normaliseFuel, fuelLabel } = require("../../config/fuels");
const { getServiceDurationSeconds } = require("../../config/fuelDurations");
const { parseClock, atBusinessTime, parseDateKey, dateKey } = require("../../config/businessTime");
const { BOOKABLE_SLOT_LABELS, isSlotElapsed } = require("../../config/booking");

const STANDARD_12H_SLOTS = BOOKABLE_SLOT_LABELS;
const DAY_MS = 24 * 60 * 60 * 1000;

// A booking still holds the nozzle while it's reserved (upcoming) or the
// vehicle is actually at the pump (serving). Anything else -- completed,
// cancelled, no_show, expired, waitlisted -- has released it.
const NOZZLE_OCCUPYING_STATUSES = ["upcoming", "serving"];

/** A Mongo filter for one fuel's bookings, or {} when no fuel is given (every nozzle). */
function fuelFilter(fuelType) {
  const label = fuelType ? fuelLabel(fuelType) : null;
  return label ? { fuelType: label } : {};
}

const sameFuel = (a, b) => !b || normaliseFuel(a) === normaliseFuel(b);

/**
 * Parse a "YYYY-MM-DD" date plus a "10:00 AM" / "6:30 PM" style label into
 * the real instant, in India time. Returns null for anything it can't parse
 * rather than throwing -- callers treat null as "reject the booking".
 */
function parseStartDateTime(bookingDate, timeSlotLabel) {
  if (!bookingDate || !timeSlotLabel) return null;

  const label = String(timeSlotLabel).trim();
  // Accept either "10:00 AM" (the UI's format) or a "10:00-10:30" range, in
  // which case only the start matters here.
  const startText = label.includes("-") ? label.split("-")[0].trim() : label;
  const clock = parseClock(startText);
  if (!clock) return null;

  return atBusinessTime(String(bookingDate).trim(), clock.hours, clock.minutes);
}

/**
 * @param {string} fuelType
 * @param {Date} startDate
 * @param {number} [quantity]  litres/kg; without it, the fuel's typical fill
 * @returns {{start:Date, end:Date, durationSeconds:number}|null}
 */
function computeWindow(fuelType, startDate, quantity) {
  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) return null;
  const durationSeconds = getServiceDurationSeconds(fuelType, quantity);
  const end = new Date(startDate.getTime() + durationSeconds * 1000);
  return { start: startDate, end, durationSeconds };
}

/**
 * Does [startDate, endDate) overlap any currently-active booking on this
 * station's nozzle for `fuelType`? Without a fuel, any of the station's nozzles.
 *
 * @param {string} stationId
 * @param {Date} startDate
 * @param {Date} endDate
 * @param {string} [excludeBookingId] skip this booking
 * @param {object} [opts] { now, fuelType }
 */
async function hasOverlap(stationId, startDate, endDate, excludeBookingId, { now = new Date(), fuelType = null } = {}) {
  const query = {
    station: stationId,
    ...fuelFilter(fuelType),
    status: { $in: NOZZLE_OCCUPYING_STATUSES },
    bookingStartTime: { $lt: endDate },
    bookingEndTime: { $gt: startDate },
  };
  if (excludeBookingId) query._id = { $ne: excludeBookingId };

  const conflict = await Booking.findOne(query).select("_id").lean();
  if (conflict) return true;

  // The nozzle as it is actually in use can run past booked windows.
  const live = (await liveServiceWindows([stationId], now)).get(String(stationId)) || [];
  return live.some(
    (w) =>
      sameFuel(w.fuelType, fuelType) &&
      w.bookingId !== String(excludeBookingId || "") &&
      windowsOverlap(startDate, endDate, w.start, w.end),
  );
}

/**
 * Each fuel's nozzle as it is actually being used: the vehicle fueling now
 * (from its fuelingStartTime until its release) and the vehicles checked in or
 * walked in and waiting at it (from their projected turn in that fuel's live
 * line, services/queue/stationQueue.js).
 *
 * A booking reserves a window at its slot start, but a late check-in or a car
 * waiting behind a long fill uses the nozzle later than that. These windows
 * are what stop a new booking -- or a waitlist promotion -- from being given
 * time the nozzle is really busy.
 *
 * @returns {Promise<Map<string, Array<{start:Date, end:Date, status:"live", bookingId:string, fuelType:string}>>>}
 */
async function liveServiceWindows(stationIds, now = new Date()) {
  const byStation = new Map();
  if (!stationIds?.length) return byStation;

  const { simulateNozzleLine, walkInRow, groupByFuel } = require("./stationQueue");
  const [bookings, walkIns] = await Promise.all([
    Booking.find({
      station: { $in: stationIds },
      $or: [
        { status: "serving", fuelingStartTime: { $ne: null } },
        { status: "upcoming", arrivalTime: { $ne: null }, bookingDate: dateKey(now) },
      ],
    })
      .select("_id user station status fuelType quantity bookingStartTime bookingEndTime arrivalTime fuelingStartTime serviceDurationSeconds")
      .lean(),
    WalkIn.find({
      station: { $in: stationIds },
      status: { $in: ["waiting", "serving"] },
      $or: [{ status: "serving" }, { businessDate: dateKey(now) }],
    }).lean(),
  ]);
  const rows = [...bookings, ...walkIns.map(walkInRow)];
  if (rows.length === 0) return byStation;

  const seconds = (b) =>
    Number(b.serviceDurationSeconds) > 0 ? Number(b.serviceDurationSeconds) : getServiceDurationSeconds(b.fuelType, b.quantity);
  const grouped = new Map();
  for (const r of rows) {
    const key = String(r.station);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }
  for (const [key, list] of grouped) {
    const byId = new Map(list.map((b) => [String(b._id), b]));
    const windows = [];
    for (const fuelLine of groupByFuel(list).values()) {
      for (const e of simulateNozzleLine(fuelLine, now).etas) {
        const b = byId.get(e.bookingId);
        if (!b) continue;
        const start = b.status === "serving" ? new Date(b.fuelingStartTime) : new Date(e.turnAt);
        windows.push({
          start,
          end: new Date(start.getTime() + seconds(b) * 1000),
          status: "live",
          bookingId: e.bookingId,
          fuelType: fuelLabel(b.fuelType),
        });
      }
    }
    byStation.set(key, windows);
  }
  return byStation;
}

/**
 * The first label at or after `fromLabel` on `bookingDate` that can actually
 * be booked: not passed, within the station's hours (when `station` is
 * given), this fuel's nozzle free.
 *
 * @param {object} [opts] { station, now, quantity }
 * @returns {Promise<string|null>}
 */
async function findNextAvailableStart(stationId, fuelType, bookingDate, fromLabel, opts = {}) {
  const rows = await generateAvailability(stationId, fuelType, bookingDate, opts);
  const from = Math.max(0, STANDARD_12H_SLOTS.indexOf(fromLabel));
  return rows.slice(from).find((r) => r.bookable)?.label ?? null;
}

/**
 * Every bookable label on one day at one station for one fuel, each with
 * whether it can be booked and, if not, why. One query for the whole day.
 *
 * @param {object} [opts]
 * @param {object} [opts.station]  station (doc or lean) for its opening hours
 * @param {Date} [opts.now]
 * @param {number} [opts.quantity] the fill being booked; without it, a typical fill
 * @returns {Promise<Array<{label, start, end, durationSeconds, available,
 *   elapsed, withinHours, bookable, reason}>>}
 */
async function generateAvailability(stationId, fuelType, bookingDate, { station = null, now = new Date(), quantity } = {}) {
  const fuel = normaliseFuel(fuelType);
  if (!fuel || !parseDateKey(bookingDate)) return [];

  const dayStart = atBusinessTime(bookingDate, 0, 0);
  const windows =
    (await loadActiveWindows([stationId], dayStart, new Date(dayStart.getTime() + DAY_MS), { now, fuelType: fuel })).get(
      String(stationId),
    ) || [];
  return describeLabels(windows, fuel, bookingDate, { station, now, quantity });
}

/**
 * labelAvailability plus the other two reasons a label cannot be booked.
 * reason: "PASSED" | "CLOSED" | "RESERVED" | null (bookable).
 * `windows` must already be this fuel's (loadActiveWindows with fuelType).
 */
function describeLabels(windows, fuelType, bookingDate, { station = null, now = new Date(), quantity } = {}) {
  return labelAvailability(windows, fuelType, bookingDate, STANDARD_12H_SLOTS, quantity).map((s) => {
    const elapsed = isSlotElapsed(bookingDate, s.label, now);
    const withinHours = station ? Station.scheduleAllowsSlot(station, bookingDate, s.label) : true;
    const reason = elapsed ? "PASSED" : !withinHours ? "CLOSED" : !s.available ? "RESERVED" : null;
    return {
      ...s,
      durationSeconds: s.start ? Math.round((s.end - s.start) / 1000) : null,
      elapsed,
      withinHours,
      bookable: reason === null,
      reason,
    };
  });
}

// ---------------------------------------------------------------------------
// Batch helpers for read paths (station finder, discovery). They answer the
// same questions as hasOverlap/generateAvailability from one query for many
// stations, instead of one query per label per station.
// ---------------------------------------------------------------------------

/** App bookings have one nozzle per fuel at each station (see top of file). */
const APP_NOZZLES = 1;

/** The overlap rule, in one place: [aStart, aEnd) meets [bStart, bEnd). */
function windowsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * Nozzle-occupying windows that touch [from, to), for many stations, keyed by
 * station id: every live booking's reserved window, plus the nozzle's actual
 * use right now (liveServiceWindows) where it reaches into that range. With
 * `fuelType`, only that fuel's nozzle.
 *
 * @returns {Promise<Map<string, Array<{start:Date, end:Date, status:string, fuelType:string}>>>}
 */
async function loadActiveWindows(stationIds, from, to, { now = new Date(), fuelType = null } = {}) {
  const byStation = new Map();
  if (!stationIds?.length) return byStation;

  const rows = await Booking.find({
    station: { $in: stationIds },
    ...fuelFilter(fuelType),
    status: { $in: NOZZLE_OCCUPYING_STATUSES },
    bookingStartTime: { $lt: to },
    bookingEndTime: { $gt: from },
  })
    .select("station status fuelType bookingStartTime bookingEndTime")
    .lean();

  for (const r of rows) {
    const key = String(r.station);
    if (!byStation.has(key)) byStation.set(key, []);
    byStation.get(key).push({ start: r.bookingStartTime, end: r.bookingEndTime, status: r.status, fuelType: r.fuelType });
  }

  const live = await liveServiceWindows(stationIds, now);
  for (const [key, windows] of live) {
    for (const w of windows) {
      if (!sameFuel(w.fuelType, fuelType)) continue;
      if (!windowsOverlap(from, to, w.start, w.end)) continue;
      if (!byStation.has(key)) byStation.set(key, []);
      byStation.get(key).push(w);
    }
  }
  return byStation;
}

/**
 * Availability of each label on `bookingDate` against already-loaded windows
 * -- the same answer generateAvailability() gives, without a query per label.
 *
 * @returns {Array<{label:string, start:Date|null, end:Date|null, available:boolean}>}
 */
function labelAvailability(windows, fuelType, bookingDate, labels = STANDARD_12H_SLOTS, quantity) {
  return labels.map((label) => {
    const start = parseStartDateTime(bookingDate, label);
    const w = start && computeWindow(fuelType, start, quantity);
    if (!w) return { label, start: null, end: null, available: false };
    const busy = (windows || []).some((x) => windowsOverlap(w.start, w.end, x.start, x.end));
    return { label, start: w.start, end: w.end, available: !busy };
  });
}

module.exports = {
  NOZZLE_OCCUPYING_STATUSES,
  APP_NOZZLES,
  parseStartDateTime,
  computeWindow,
  hasOverlap,
  findNextAvailableStart,
  generateAvailability,
  windowsOverlap,
  loadActiveWindows,
  liveServiceWindows,
  labelAvailability,
  describeLabels,
};
