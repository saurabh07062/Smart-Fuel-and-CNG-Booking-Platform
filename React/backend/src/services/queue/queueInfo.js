/**
 * Vehicle count and expected waiting time for bookings that already exist:
 * how many vehicles are ahead, the queue position, the wait and the
 * estimated start -- the same five figures the booking preview shows
 * (stationQueue.buildQueuePreview, `you`), from the same source.
 *
 * The source is the nozzle scheduler's occupancy (nozzleScheduler.
 * loadActiveWindows): each upcoming booking's reserved window, and for a car
 * checked in or being fuelled its LIVE window -- the fill in progress for its
 * remaining time, the car waiting from when the nozzle frees. Cancelled,
 * expired, no-show and completed bookings hold no window, so they never
 * count; each booking is one window, so none counts twice.
 *
 * "Ahead" means on this fuel's app nozzles, starting before this vehicle and
 * still occupying a nozzle when this customer joins the line (the later of
 * now and their slot's start) -- exactly the rule of the preview's
 * scheduleForWindow, so a customer sees the same numbers before and after
 * booking, and the vendor sees the same numbers as the customer.
 *
 * Read-only and server-side: nothing here trusts a count sent by a client.
 */
const { normaliseFuel } = require("../../config/fuels");
const { SLOT_SPACING_SECONDS } = require("../../config/booking");
const { TIME_ZONE } = require("../../config/businessTime");

const ACTIVE = ["upcoming", "serving"];

/** 380 -> "6 min 20 sec", 40 -> "40 sec", 0 -> "No wait". */
function formatWait(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s === 0) return "No wait";
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r} sec`;
  return r === 0 ? `${m} min` : `${m} min ${r} sec`;
}

/** An instant as India time of day: "10:06 AM". */
function formatClock(date) {
  if (!date) return null;
  return new Date(date).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: TIME_ZONE,
  });
}

/**
 * Pure: the five figures for one vehicle given the occupancy of its fuel's
 * nozzles.
 *
 * @param {Array<{bookingId?:string,start:Date|string,end:Date|string}>} windows
 * @param {object} me
 * @param {string} [me.id]       excluded from `windows` (a booking is not ahead of itself)
 * @param {number} me.startMs    when this vehicle reaches a nozzle
 * @param {number} me.joinMs     when this customer joins the line
 * @param {boolean} [me.serving] at the nozzle already
 */
function figuresFor(windows, me) {
  if (me.serving) {
    return {
      vehicleCountAhead: 0,
      queuePosition: 1,
      expectedWaitingSeconds: 0,
      expectedWaitingTime: formatWait(0),
      estimatedStartTime: formatClock(me.startMs),
      estimatedStartAt: new Date(me.startMs),
    };
  }
  const ahead = (windows || []).filter((w) => {
    if (me.id && String(w.bookingId) === String(me.id)) return false;
    const s = new Date(w.start).getTime();
    const e = new Date(w.end).getTime();
    return s < me.startMs && e > me.joinMs;
  }).length;
  const wait = Math.max(0, Math.round((me.startMs - me.joinMs) / 1000));
  return {
    vehicleCountAhead: ahead,
    queuePosition: ahead + 1,
    expectedWaitingSeconds: wait,
    expectedWaitingTime: formatWait(wait),
    estimatedStartTime: formatClock(me.startMs),
    estimatedStartAt: new Date(me.startMs),
  };
}

const stationIdOf = (b) => String(b.station?._id ?? b.station);

/**
 * The figures for each active booking (upcoming or serving); others get null.
 * One occupancy read per station and fuel, whatever the number of bookings.
 *
 * @param {Array<object>} bookings  lean or documents: _id, station, status,
 *   fuelType, bookingStartTime, bookingEndTime, fuelingStartTime
 * @returns {Promise<Map<string, object|null>>} by booking id
 */
async function queueInfoForBookings(bookings, { now = new Date() } = {}) {
  const nozzleScheduler = require("./nozzleScheduler");
  const out = new Map();
  const t = now.getTime();
  const slotMs = SLOT_SPACING_SECONDS * 1000;

  // Group the active ones by station and fuel; everything else has no queue.
  const groups = new Map();
  for (const b of bookings || []) {
    const id = String(b._id);
    const fuel = normaliseFuel(b.fuelType);
    if (!ACTIVE.includes(b.status) || !fuel || !b.bookingStartTime) {
      out.set(id, null);
      continue;
    }
    const key = `${stationIdOf(b)}|${fuel}`;
    if (!groups.has(key)) groups.set(key, { stationId: stationIdOf(b), fuel, list: [] });
    groups.get(key).list.push(b);
  }

  for (const { stationId, fuel, list } of groups.values()) {
    // Read the occupancy once, wide enough for every booking in the group.
    let from = Infinity;
    let to = -Infinity;
    for (const b of list) {
      const s = new Date(b.bookingStartTime).getTime();
      from = Math.min(from, t, s);
      to = Math.max(to, s + slotMs, t + slotMs);
    }
    const windows =
      (await nozzleScheduler.loadActiveWindows([stationId], new Date(from - slotMs), new Date(to), { now, fuelType: fuel })).get(
        String(stationId),
      ) || [];
    const liveById = new Map(windows.filter((w) => w.bookingId).map((w) => [String(w.bookingId), w]));

    for (const b of list) {
      const id = String(b._id);
      const slotStart = new Date(b.bookingStartTime).getTime();
      // The window this booking really holds: the live one when checked in /
      // fuelling, else its reserved one.
      const mine = liveById.get(id);
      const startMs = new Date(mine?.start ?? (b.status === "serving" ? b.fuelingStartTime : null) ?? b.bookingStartTime).getTime();
      // The slot's own 30-minute window starts at the label (bookingStartTime
      // sits inside it, placed back to back).
      const windowStart = slotStart - (slotStart % slotMs === 0 ? 0 : slotStart % slotMs);
      out.set(
        id,
        figuresFor(windows, {
          id,
          startMs,
          joinMs: Math.max(t, Math.min(windowStart, startMs)),
          serving: b.status === "serving",
        }),
      );
    }
  }
  return out;
}

/**
 * Adds `queueInfo` (the five figures, or null) to each booking, as plain
 * objects. (Not "queueStatus": on a station that name is Low / Moderate / High.)
 */
async function withQueueInfo(bookings, opts) {
  const list = (bookings || []).map((b) => (typeof b?.toObject === "function" ? b.toObject() : b));
  const byId = await queueInfoForBookings(list, opts);
  return list.map((b) => ({ ...b, queueInfo: byId.get(String(b._id)) ?? null }));
}

module.exports = { formatWait, formatClock, figuresFor, queueInfoForBookings, withQueueInfo };
