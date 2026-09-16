/**
 * Business time for FuelMart: India Standard Time.
 *
 * Every "today", every slot label ("10:00 AM") and every opening hour means
 * India time, whatever timezone the server process runs in. A production
 * server almost always runs in UTC, and mixing `new Date().toISOString()`
 * (UTC date) with `setHours()` (server-local clock) gets a booking's day or
 * start wrong for five and a half hours of every day.
 *
 * India has no daylight saving, so a fixed +05:30 offset is exact.
 * Instants are stored in MongoDB as normal UTC Dates; only interpretation and
 * display go through here.
 */

const TIME_ZONE = "Asia/Kolkata";
const OFFSET_MINUTES = 330; // +05:30
const MONGO_TIMEZONE = "+05:30"; // for $dateToString / $dateTrunc
const OFFSET_MS = OFFSET_MINUTES * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const pad = (n) => String(n).padStart(2, "0");

/** A Date whose UTC fields read as India wall-clock time. Internal only. */
function shifted(date) {
  return new Date(date.getTime() + OFFSET_MS);
}

/** India calendar date, "YYYY-MM-DD", for an instant (default: now). */
function dateKey(date = new Date()) {
  return shifted(date).toISOString().slice(0, 10);
}

/** India wall-clock parts of an instant. dayOfWeek: 0 = Sunday. */
function clockParts(date = new Date()) {
  const s = shifted(date);
  return {
    dateKey: s.toISOString().slice(0, 10),
    hours: s.getUTCHours(),
    minutes: s.getUTCMinutes(),
    dayOfWeek: s.getUTCDay(),
  };
}

/** "HH:MM" in India time. */
function formatHHMM(date) {
  const { hours, minutes } = clockParts(date);
  return `${pad(hours)}:${pad(minutes)}`;
}

/** "YYYY-MM-DD" -> {year, month, day}, or null for anything not a real date. */
function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

/**
 * A clock time: "10:00 AM", "6:30 pm" or 24-hour "18:45".
 * @returns {{hours:number, minutes:number}|null}
 */
function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(String(text || "").trim());
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = Number(m[2]);
  const ampm = m[3] ? m[3].toUpperCase() : null;
  if (minutes > 59) return null;
  if (ampm) {
    if (hours < 1 || hours > 12) return null;
    if (ampm === "PM" && hours < 12) hours += 12;
    if (ampm === "AM" && hours === 12) hours = 0;
  } else if (hours > 23) {
    return null;
  }
  return { hours, minutes };
}

/** The instant at India wall-clock `hours:minutes` on India date `key`, or null. */
function atBusinessTime(key, hours, minutes = 0) {
  const d = parseDateKey(key);
  if (!d || !Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  return new Date(Date.UTC(d.year, d.month - 1, d.day, hours, minutes) - OFFSET_MS);
}

/** Midnight India time at the start of the India day containing `date`. */
function startOfBusinessDay(date = new Date()) {
  return atBusinessTime(dateKey(date), 0, 0);
}

/** The last millisecond of the India day containing `date`. */
function endOfBusinessDay(date = new Date()) {
  return new Date(startOfBusinessDay(date).getTime() + DAY_MS - 1);
}

/** Midnight India time on the 1st of the India month containing `date`. */
function startOfBusinessMonth(date = new Date()) {
  return atBusinessTime(`${dateKey(date).slice(0, 7)}-01`, 0, 0);
}

module.exports = {
  TIME_ZONE,
  OFFSET_MINUTES,
  MONGO_TIMEZONE,
  dateKey,
  clockParts,
  formatHHMM,
  parseDateKey,
  parseClock,
  atBusinessTime,
  startOfBusinessDay,
  endOfBusinessDay,
  startOfBusinessMonth,
};
