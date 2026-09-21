/**
 * The capacity and allocation core of the nozzle scheduler
 * (services/queue/nozzleScheduler.js) -- pure, deterministic, no database.
 *
 * Model
 *   - A booking WINDOW is a 30-minute slot label ("10:00 AM" = 10:00-10:30).
 *     The customer picks a window; the scheduler picks the exact start.
 *   - Each fuel has R app RESOURCES (online nozzles). A resource serves one
 *     vehicle at a time.
 *   - A booking occupies [start, start + serviceDuration) on one resource.
 *     Its duration comes from config/fuelDurations.js (Petrol/Diesel 40 s,
 *     CNG 300 s, or quantity-based when rates are configured).
 *   - The first start in a free stretch is aligned to the time GRID
 *     (config/booking.js SLOT_GRID_SECONDS, 30 s); each later one starts the
 *     moment the service before it ends (back-to-back). The grid is only the
 *     resolution of start times, never a unit of capacity.
 *   - A booking must start inside its window and finish by the window's end.
 *
 * Capacity of a window for one fuel
 *   total      = R x floor(window length / duration)       (theoretical)
 *   available  = how many more bookings fit, placing each at the earliest
 *                free grid start on any resource, around what is already
 *                there (reservations, the vehicle being served, checked-in
 *                vehicles and walk-ins at the app nozzles)
 *
 * All times are milliseconds since the epoch.
 */

/** Round `ms` up to the next grid line counted from `originMs`. */
function ceilToGrid(ms, originMs, gridMs) {
  if (!(gridMs > 0)) return ms;
  const k = Math.ceil((ms - originMs) / gridMs);
  return originMs + Math.max(0, k) * gridMs;
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

/**
 * Earliest grid start >= `from` on ONE resource where [start, start+duration)
 * is free and ends by `windowEnd`; null when none.
 * @param {Array<{start:number,end:number}>} busy  that resource's occupied intervals
 */
function earliestOnResource(busy, { windowStart, windowEnd, from, durationMs, gridMs }) {
  const sorted = [...busy].sort((a, b) => a.start - b.start);
  let t = ceilToGrid(Math.max(windowStart, from), windowStart, gridMs);
  // Each pass moves `t` past one blocking interval, so this ends.
  for (let guard = 0; guard <= sorted.length + 1; guard++) {
    if (t + durationMs > windowEnd) return null;
    const block = sorted.find((b) => overlaps(t, t + durationMs, b.start, b.end));
    if (!block) return t;
    // Back-to-back: the next service starts the moment the blocking one ends,
    // so no nozzle time is lost to grid rounding (45 x 40 s fit in 30 min).
    t = Math.max(t, block.end);
  }
  return null;
}

/**
 * The earliest valid service position in a window across all resources:
 * the soonest start; on a tie, the lowest resource number.
 *
 * @param {object} p
 * @param {number} p.windowStart
 * @param {number} p.windowEnd
 * @param {number} [p.notBefore]  e.g. now: nothing is placed in the past
 * @param {number} p.durationMs
 * @param {Array<Array<{start:number,end:number}>>} p.busyByResource  index 0 = resource 1
 * @param {number} p.gridMs
 * @returns {{resource:number, start:number, end:number}|null}
 */
function allocate({ windowStart, windowEnd, notBefore = -Infinity, durationMs, busyByResource, gridMs }) {
  if (!(durationMs > 0) || !(windowEnd > windowStart) || !busyByResource?.length) return null;
  let best = null;
  busyByResource.forEach((busy, i) => {
    const start = earliestOnResource(busy || [], { windowStart, windowEnd, from: notBefore, durationMs, gridMs });
    if (start !== null && (best === null || start < best.start)) best = { resource: i + 1, start, end: start + durationMs };
  });
  return best;
}

/**
 * Capacity of one window for one fuel.
 * @returns {{total:number, available:number, reserved:number, resources:number}}
 *   total: theoretical (resources x whole services in the window);
 *   available: how many more bookings of `durationMs` still fit;
 *   reserved: bookings already starting in this window.
 */
function windowCapacity({ windowStart, windowEnd, notBefore = -Infinity, durationMs, busyByResource, gridMs, reservedStarts = [] }) {
  const resources = busyByResource?.length || 0;
  if (!(durationMs > 0) || !(windowEnd > windowStart) || resources === 0) {
    return { total: 0, available: 0, reserved: 0, resources };
  }
  const total = resources * Math.floor((windowEnd - windowStart) / durationMs);

  // Fill a copy greedily, earliest first; for equal-length services this is
  // the most that fit around the existing occupancy.
  const busy = busyByResource.map((b) => [...(b || [])]);
  let available = 0;
  for (;;) {
    const next = allocate({ windowStart, windowEnd, notBefore, durationMs, busyByResource: busy, gridMs });
    if (!next) break;
    busy[next.resource - 1].push({ start: next.start, end: next.end });
    available++;
    if (available > total) break; // cannot happen; a hard stop for bad input
  }
  const reserved = reservedStarts.filter((s) => s >= windowStart && s < windowEnd).length;
  return { total, available: Math.min(available, total), reserved, resources };
}

module.exports = { ceilToGrid, overlaps, earliestOnResource, allocate, windowCapacity };
