/**
 * India Standard Time helpers, mirroring backend/config/businessTime.js.
 *
 * Booking dates and slot labels mean India time wherever the customer's
 * browser is. `new Date().toISOString()` is the UTC date -- still yesterday
 * until 5:30 AM in India -- and `setHours()` is the browser's own zone, so
 * neither is used for booking decisions.
 */

const IST_OFFSET_MS = 330 * 60_000; // +05:30, no daylight saving
const DAY_MS = 24 * 60 * 60_000;

/** India calendar date "YYYY-MM-DD", `offsetDays` from today. */
export function istDateKey(offsetDays = 0, now: number = Date.now()): string {
  return new Date(now + IST_OFFSET_MS + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** "10:00 AM", "6:30 pm" or "18:45" -> minutes since midnight, or null. */
function clockMinutes(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(text.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3]?.toUpperCase();
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === "PM" && h < 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return h * 60 + min;
}

/** The instant at India wall-clock `minutes` past midnight on India date `key`. */
function istInstant(key: string, minutes: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, minutes) - IST_OFFSET_MS;
}

/** Slot length, as backend/config/booking.js SLOT_SPACING_SECONDS. */
export const SLOT_MINUTES = 30;

/**
 * When a slot ends (ms), India time: a label ends SLOT_MINUTES after it
 * starts; an "HH:MM-HH:MM" range ends at its second time.
 */
export function slotEndMs(bookingDate: string, timeSlot: string): number | null {
  const label = timeSlot.trim();
  if (label.includes("-")) {
    let end = label.split("-")[1].trim();
    const ampm = /(AM|PM)/i.exec(label)?.[0];
    if (!/am|pm/i.test(end) && ampm) end = `${end} ${ampm}`;
    const mins = clockMinutes(end);
    return mins === null ? null : istInstant(bookingDate, mins);
  }
  const start = clockMinutes(label);
  return start === null ? null : istInstant(bookingDate, start + SLOT_MINUTES);
}
