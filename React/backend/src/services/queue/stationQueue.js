/**
 * Live queue and ETAs, one line per fuel -- the one wait-time model.
 *
 * Each fuel has its own app nozzle (services/queue/nozzleScheduler.js): Petrol,
 * Diesel and CNG are separate lines, and one fuel's line never delays another.
 * A line is not a guess from a formula: it is today's real bookings and the
 * vendor-recorded walk-ins (models/WalkIn.js) for that fuel, served one after
 * another. simulateNozzleLine() walks one line in order:
 *
 *   serving   the vehicle at the nozzle; busy until it started plus its own
 *             service duration (or now, if it has overrun)
 *   arrived   checked in / walked in and waiting at the nozzle, in arrival
 *             order, each for its own service duration
 *   upcoming  served at its slot start, or when the nozzle frees if the line
 *             is running late; a booking whose whole slot has passed without
 *             arriving is the no-show sweep's case, not a car in line
 *
 * Every vehicle's service duration comes from its own quantity
 * (config/fuelDurations.js, stored on the booking or walk-in), so a wait is
 * the remaining time of the vehicle at the nozzle plus the service time of
 * every vehicle ahead -- never the number of vehicles times an average.
 *
 * From the lines:
 *   byFuel       per fuel: queueLength (vehicles in line now) and waitMinutes
 *                (until that line clears)
 *   queueLength  all fuels together; waitMinutes the longest fuel's wait
 *   etas         for every live booking today, minutes until its turn
 *
 * Station documents store queueLength / waitMinutes / queueStatus as a cache
 * for lists and realtime events; refreshStationQueue() is the only writer.
 */

const Booking = require("../../models/Booking");
const Station = require("../../models/Station");
const WalkIn = require("../../models/WalkIn");
const metrics = require("../core/metrics");
const { toQueueStatus } = require("../algorithms/queue");
const { getServiceDurationSeconds } = require("../../config/fuelDurations");
const { FUEL_KEYS, normaliseFuel, fuelLabel, fuelUnit } = require("../../config/fuels");
const { SLOT_SPACING_SECONDS } = require("../../config/booking");
const { startOfBusinessDay, endOfBusinessDay, dateKey } = require("../../config/businessTime");

const LINE_STATUSES = ["upcoming", "serving"];
const BASIS = "app-nozzle";
const BOOKING_FIELDS =
  "_id user station status fuelType quantity vehiclePlate bookingStartTime bookingEndTime arrivalTime fuelingStartTime serviceDurationSeconds";

function durationMs(b) {
  const seconds = Number(b.serviceDurationSeconds);
  if (seconds > 0) return seconds * 1000;
  if (b.bookingStartTime && b.bookingEndTime) {
    const d = new Date(b.bookingEndTime) - new Date(b.bookingStartTime);
    if (d > 0) return d;
  }
  return getServiceDurationSeconds(b.fuelType, b.quantity) * 1000;
}

const startMs = (b, fallback) =>
  new Date(b.fuelingStartTime || b.bookingStartTime || fallback).getTime();

/**
 * Pure: serve one fuel's line on its app nozzles (`resources`, default 1), as
 * of `now`. Callers pass one fuel's rows (simulateStation groups by fuel).
 *
 *   - a vehicle being served keeps its nozzle until its fill ends
 *   - vehicles already at the pump (checked in / walked in) are next, in
 *     arrival order, each on whichever nozzle frees first
 *   - booked vehicles not yet arrived follow in slot order, each no earlier
 *     than its booked start, on whichever nozzle frees first
 *
 * With one nozzle this is exactly the single-line hand-over of
 * services/queue/nozzleService.js.
 *
 * @param {Array<object>} bookings  _id, user, status, fuelType, resource,
 *   bookingStartTime, bookingEndTime, arrivalTime, fuelingStartTime,
 *   serviceDurationSeconds; walk-ins in the same shape with kind "walkin"
 * @param {Date} [now]
 * @param {{resources?:number}} [opts]
 * @returns {{queueLength:number, waitMinutes:number, queueStatus:string,
 *   basis:string, etas:Array<{bookingId:string, kind:string, user:string|null,
 *   position:number, etaMinutes:number, turnAt:number|null, resource:number}>,
 *   lineClearsAt:number, servingCount:number, resources:number}}
 *   lineClearsAt: when a vehicle arriving now would get a nozzle
 */
function simulateNozzleLine(bookings, now = new Date(), { resources = 1 } = {}) {
  const t = now.getTime();
  const slotMs = SLOT_SPACING_SECONDS * 1000;
  const R = Math.max(1, Math.floor(Number(resources) || 1));

  const serving = [];
  const arrived = []; // checked in / walked in, waiting for a nozzle (services/queue/nozzleService.js)
  const upcoming = [];
  for (const b of bookings || []) {
    if (b.status === "serving") serving.push(b);
    else if (b.status === "upcoming" && b.arrivalTime) arrived.push(b);
    else if (b.status === "upcoming" && b.bookingStartTime) {
      if (new Date(b.bookingStartTime).getTime() + slotMs <= t) continue; // slot over, never arrived
      upcoming.push(b);
    }
  }
  serving.sort((a, b) => startMs(a, now) - startMs(b, now));
  arrived.sort((a, b) => new Date(a.arrivalTime) - new Date(b.arrivalTime));
  upcoming.sort((a, b) => new Date(a.bookingStartTime) - new Date(b.bookingStartTime));

  const etas = [];
  // turnAt: the instant (ms) this vehicle reaches a nozzle, so the queue
  // clock knows when its whole-minute ETA next ticks down.
  const eta = (b, position, minutes, turnAt, resource) =>
    etas.push({
      bookingId: String(b._id),
      kind: b.kind || "booking",
      user: b.user ? String(b.user) : null,
      position,
      etaMinutes: minutes,
      turnAt,
      resource,
    });

  const free = new Array(R).fill(t); // when each nozzle is next free
  // The nozzle that frees first (lowest number on a tie), at or after `notBefore`.
  const soonest = (notBefore = -Infinity) => {
    let best = 0;
    for (let i = 1; i < R; i++) if (Math.max(free[i], notBefore) < Math.max(free[best], notBefore)) best = i;
    return best;
  };

  let inLine = 0;
  for (const b of serving) {
    // Its own nozzle; one numbered past the current count shares the last.
    const i = Math.min(R, Math.max(1, Number(b.resource) || 1)) - 1;
    free[i] = Math.max(free[i], startMs(b, now) + durationMs(b));
    inLine += 1;
    eta(b, inLine, 0, null, i + 1);
  }

  // Vehicles already at the pump are next, in arrival order: they are
  // physically in line whatever a slot says, and a released nozzle is handed
  // to them first.
  for (const b of arrived) {
    const i = soonest();
    const turn = free[i];
    free[i] = turn + durationMs(b);
    inLine += 1;
    eta(b, inLine, Math.ceil(Math.max(0, turn - t) / 60_000), turn, i + 1);
  }

  let lineClearsAt = null;
  let position = inLine;
  for (const b of upcoming) {
    const slotStart = new Date(b.bookingStartTime).getTime();
    // Sorted by start: every booking already due comes before any that isn't,
    // so a newcomer's wait is fixed once the first future one is reached.
    if (slotStart > t && lineClearsAt === null) lineClearsAt = Math.min(...free);
    const i = soonest(slotStart);
    const turn = Math.max(slotStart, free[i]);
    free[i] = turn + durationMs(b);
    position += 1;
    if (slotStart <= t) inLine += 1;
    eta(b, position, Math.ceil(Math.max(0, turn - t) / 60_000), turn, i + 1);
  }
  if (lineClearsAt === null) lineClearsAt = Math.min(...free);

  const waitMinutes = Math.ceil(Math.max(0, lineClearsAt - t) / 60_000);
  return {
    queueLength: inLine,
    waitMinutes,
    queueStatus: toQueueStatus(waitMinutes),
    basis: BASIS,
    etas,
    lineClearsAt,
    servingCount: serving.length,
    resources: R,
  };
}

/** Each fuel's app nozzle count at a station (config/nozzleModes.js), at least 1. */
function resourcesByFuelOf(station) {
  const { onlineResources } = require("../../config/nozzleModes");
  return Object.fromEntries(FUEL_KEYS.map((f) => [f, Math.max(1, onlineResources(station, f))]));
}

/** Rows of one station, split into its fuels' lines (unknown fuels are left out). */
function groupByFuel(rows) {
  const byFuel = new Map(FUEL_KEYS.map((f) => [f, []]));
  for (const r of rows || []) byFuel.get(normaliseFuel(r.fuelType))?.push(r);
  return byFuel;
}

/**
 * Pure: a station's lines, one per fuel, and the station-wide totals lists
 * and caches read. The etas cover every fuel; positions are within a fuel.
 */
function simulateStation(rows, now = new Date(), resourcesByFuel = {}) {
  const byFuel = {};
  const etas = [];
  let queueLength = 0;
  let waitMinutes = 0;
  let lineClearsAt = now.getTime();
  for (const [fuel, list] of groupByFuel(rows)) {
    const line = simulateNozzleLine(list, now, { resources: resourcesByFuel[fuel] });
    byFuel[fuel] = {
      queueLength: line.queueLength,
      waitMinutes: line.waitMinutes,
      queueStatus: line.queueStatus,
      lineClearsAt: line.lineClearsAt,
      basis: BASIS,
    };
    etas.push(...line.etas);
    queueLength += line.queueLength;
    waitMinutes = Math.max(waitMinutes, line.waitMinutes);
    lineClearsAt = Math.max(lineClearsAt, line.lineClearsAt);
  }
  return { queueLength, waitMinutes, queueStatus: toQueueStatus(waitMinutes), basis: BASIS, etas, lineClearsAt, byFuel };
}

/** A walk-in in the booking-shaped row the line simulation reads. */
function walkInRow(w) {
  return {
    _id: w._id,
    kind: "walkin",
    user: null,
    station: w.station,
    status: w.status === "serving" ? "serving" : "upcoming",
    fuelType: w.fuelType,
    quantity: w.quantity,
    vehiclePlate: w.vehicleNumber,
    bookingStartTime: null,
    bookingEndTime: null,
    arrivalTime: w.arrivalTime,
    fuelingStartTime: w.fuelingStartTime,
    serviceDurationSeconds: w.serviceDurationSeconds,
  };
}

/**
 * The walk-ins that are in a fuel's APP line: all of them where walk-ins share
 * the app nozzle, none where they have their own nozzles (config/nozzleModes.js)
 * -- except one still on the app nozzle from before the split was set.
 */
async function appLineWalkIns(walkIns) {
  if (!walkIns.length) return walkIns;
  const nozzleSetup = require("../../config/nozzleModes");
  const ids = [...new Set(walkIns.map((w) => String(w.station)))];
  const stations = await Station.find({ _id: { $in: ids } }).select("nozzleConfig").lean();
  const byId = new Map(stations.map((st) => [String(st._id), st]));
  return walkIns.filter((w) => {
    if (!nozzleSetup.separateWalkIns(byId.get(String(w.station)), w.fuelType)) return true;
    return w.status === "serving" && (w.lane === 0 || w.lane == null);
  });
}

/**
 * Today's line rows for these stations from MongoDB: live bookings and active
 * walk-ins, keyed by station id.
 */
async function loadLineRows(stationIds, now = new Date(), { extraBookingFields = "" } = {}) {
  const byStation = new Map((stationIds || []).map((id) => [String(id), []]));
  if (byStation.size === 0) return byStation;

  const [bookings, walkIns] = await Promise.all([
    Booking.find({
      station: { $in: stationIds },
      status: { $in: LINE_STATUSES },
      $or: [
        { status: "serving" },
        { bookingStartTime: { $gte: startOfBusinessDay(now), $lte: endOfBusinessDay(now) } },
      ],
    })
      .select(`${BOOKING_FIELDS} ${extraBookingFields}`.trim())
      .lean(),
    WalkIn.find({
      station: { $in: stationIds },
      status: { $in: ["waiting", "serving"] },
      $or: [{ status: "serving" }, { businessDate: dateKey(now) }],
    }).lean(),
  ]);

  for (const r of bookings) byStation.get(String(r.station))?.push(r);
  for (const w of await appLineWalkIns(walkIns)) byStation.get(String(w.station))?.push(walkInRow(w));
  return byStation;
}

/**
 * Snapshots for many stations from one query each for bookings and walk-ins.
 * @returns {Promise<Map<string, ReturnType<typeof simulateStation>>>} every id present
 */
async function queueSnapshots(stationIds, now = new Date()) {
  const rows = await loadLineRows(stationIds, now);
  const stations = new Map(
    (await Station.find({ _id: { $in: [...rows.keys()] } }).select("nozzleConfig").lean()).map((st) => [String(st._id), st]),
  );
  return new Map([...rows].map(([id, list]) => [id, simulateStation(list, now, resourcesByFuelOf(stations.get(id)))]));
}

/** Per-fuel totals, safe for any audience (no vehicles, no customers). */
function fuelQueueSummary(snapshot) {
  return Object.fromEntries(
    Object.entries(snapshot?.byFuel || {}).map(([fuel, q]) => [
      fuel,
      { queueLength: q.queueLength, waitMinutes: q.waitMinutes, queueStatus: q.queueStatus },
    ]),
  );
}

/**
 * Recompute one station's queue and push it out: the station's cached
 * fields, each live booking's etaMinutes, a queue event (with every fuel's
 * line) to the station's watchers and an ETA to each customer in line.
 */
async function refreshStationQueue(stationId, { now = new Date() } = {}) {
  const snapshot = (await queueSnapshots([stationId], now)).get(String(stationId));
  const station = await Station.findOneAndUpdate(
    { _id: stationId },
    {
      $set: {
        queueLength: snapshot.queueLength,
        waitMinutes: snapshot.waitMinutes,
        queueStatus: snapshot.queueStatus,
      },
    },
    { returnDocument: "after" },
  ).lean();
  if (!station) return null;

  const bookingEtas = snapshot.etas.filter((e) => e.kind === "booking");
  await Promise.all(
    bookingEtas.map((e) =>
      Booking.updateOne({ _id: e.bookingId, etaMinutes: { $ne: e.etaMinutes } }, { $set: { etaMinutes: e.etaMinutes } }),
    ),
  );
  lastSentLines.set(String(stationId), lineSignature(snapshot));

  try {
    const realtime = require("../notification/realtime");
    realtime.stationChanged(realtime.EVENTS.QUEUE_UPDATED, station, {
      queueLength: snapshot.queueLength,
      waitMinutes: snapshot.waitMinutes,
      queueStatus: snapshot.queueStatus,
      fuelQueues: fuelQueueSummary(snapshot),
      queueUpdatedAt: now,
    });
    // Everything that moves a line -- a booking made, cancelled, missed,
    // promoted, checked in or finished, a walk-in arriving or leaving -- also
    // changes which slots can be booked and every pre-booking estimate.
    // Booking grids and queue previews watching this station refetch; the
    // payload says only which station.
    const slotChange = { stationId: String(station._id), updatedAt: station.updatedAt || now };
    realtime.toStation(station._id, realtime.EVENTS.SLOT_UPDATED, slotChange);
    if (station.owner) realtime.toVendor(station.owner, realtime.EVENTS.SLOT_UPDATED, slotChange);
    for (const e of bookingEtas) {
      if (e.user) realtime.toUser(e.user, "eta_update", { bookingId: e.bookingId, position: e.position, etaMinutes: e.etaMinutes });
    }
  } catch (err) {
    console.error("[stationQueue] realtime emit failed:", err.message);
  }

  metrics.inc("queue_refresh_count");
  return { station, ...snapshot };
}

// ------------------------------------------------------------ queue preview

/** "MH12AB1234" -> "MH12 •••• 34". null when there is nothing safe to show. */
function maskVehicle(plate) {
  const s = String(plate || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length < 6) return null;
  return `${s.slice(0, 4)} •••• ${s.slice(-2)}`;
}

/**
 * What a customer sees BEFORE booking: the real line for one fuel at one
 * station, and where a booking of `quantity` would stand in it.
 *
 * The customer's estimate comes from running the same line simulation with
 * their booking added: joining at their slot start (or now, when the slot has
 * already started), their turn is when every vehicle ahead -- the one at the
 * nozzle for its remaining time, then each one for its own service time --
 * has finished. Another day has no live line yet: the estimate is the slot
 * start itself, which the nozzle schedule already reserves.
 *
 * Public: vehicles are shown only as masked plates, never customers.
 *
 * @param {object} p
 * @param {string} p.stationId
 * @param {string} p.fuelType
 * @param {number} p.quantity
 * @param {Date}   [p.slotStart]   start of the chosen slot (India time already applied)
 * @param {string} [p.bookingDate] "YYYY-MM-DD" of that slot
 * @param {Date}   [p.now]
 */
async function buildQueuePreview({ stationId, fuelType, quantity, slotStart = null, bookingDate = null, timeSlot = null, now = new Date() }) {
  const fuel = normaliseFuel(fuelType);
  const t = now.getTime();
  const serviceSeconds = getServiceDurationSeconds(fuel, quantity);
  const station = await Station.findById(stationId).select("nozzleConfig operatingSchedule openingHours status").lean();
  const resources = resourcesByFuelOf(station)[fuel];
  const rows = ((await loadLineRows([stationId], now)).get(String(stationId)) || []).filter(
    (r) => normaliseFuel(r.fuelType) === fuel,
  );
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  const line = simulateNozzleLine(rows, now, { resources });

  // The line as it stands, in serving order.
  const queue = line.etas.map((e) => {
    const r = byId.get(e.bookingId);
    const seconds = Math.round(durationMs(r) / 1000);
    const serving = r.status === "serving";
    const startsAt = serving ? startMs(r, now) : e.turnAt;
    const inLineNow = serving || Boolean(r.arrivalTime) || (r.bookingStartTime && new Date(r.bookingStartTime).getTime() <= t);
    return {
      position: e.position,
      kind: e.kind,
      vehicle: maskVehicle(r.vehiclePlate),
      quantity: r.quantity ?? null,
      status: serving ? "serving" : inLineNow ? "waiting" : "booked",
      serviceSeconds: seconds,
      startsAt: startsAt ? new Date(startsAt) : null,
      endsAt: startsAt ? new Date(Math.max(startsAt + seconds * 1000, serving ? t : 0)) : null,
    };
  });

  const current = queue.find((q) => q.status === "serving") || null;
  const currentServing = current && {
    vehicle: current.vehicle,
    kind: current.kind,
    quantity: current.quantity,
    serviceSeconds: current.serviceSeconds,
    startedAt: current.startsAt,
    endsAt: current.endsAt,
    remainingSeconds: Math.max(0, Math.ceil((current.endsAt.getTime() - t) / 1000)),
  };

  const isToday = !bookingDate || bookingDate === dateKey(now);
  // A chosen window: the scheduler's own answer -- the exact position a
  // booking made now would get (services/queue/nozzleScheduler.js), so the
  // estimate and the booking never disagree.
  const schedule = bookingDate && timeSlot
    ? await scheduleForWindow({ stationId, fuel, quantity, bookingDate, timeSlot, station, now, serviceSeconds })
    : null;
  let you;
  // A full window has no position to show: the line estimate below stands.
  if (schedule && schedule.resourceAvailable) {
    const startAt = schedule.estimatedStartTime;
    you = {
      joinAt: new Date(schedule.joinAt),
      position: schedule.queueAhead + 1,
      vehiclesAhead: schedule.queueAhead,
      estimatedWaitSeconds: schedule.expectedWaitSeconds,
      estimatedStartAt: startAt,
      estimatedCompleteAt: schedule.estimatedCompletionTime,
      basis: "scheduler",
    };
  } else if (!isToday && slotStart) {
    you = {
      joinAt: slotStart,
      position: 1,
      vehiclesAhead: 0,
      estimatedWaitSeconds: 0,
      estimatedStartAt: slotStart,
      estimatedCompleteAt: new Date(slotStart.getTime() + serviceSeconds * 1000),
      basis: "reserved-slot",
    };
  } else {
    const joinAt = Math.max(t, slotStart ? slotStart.getTime() : t);
    const PREVIEW_ID = "__preview__";
    const withYou = simulateNozzleLine(
      [
        ...rows,
        {
          _id: PREVIEW_ID,
          status: "upcoming",
          fuelType: fuel,
          quantity,
          bookingStartTime: new Date(joinAt),
          serviceDurationSeconds: serviceSeconds,
        },
      ],
      now,
    );
    const mine = withYou.etas.find((e) => e.bookingId === PREVIEW_ID);
    const turnAt = mine?.turnAt ?? joinAt;
    you = {
      joinAt: new Date(joinAt),
      position: mine?.position ?? 1,
      vehiclesAhead: Math.max(0, (mine?.position ?? 1) - 1),
      estimatedWaitSeconds: Math.max(0, Math.ceil((turnAt - joinAt) / 1000)),
      estimatedStartAt: new Date(turnAt),
      estimatedCompleteAt: new Date(turnAt + serviceSeconds * 1000),
      basis: BASIS,
    };
  }

  return {
    stationId: String(stationId),
    fuelType: fuelLabel(fuel),
    unit: fuelUnit(fuel),
    asOf: now,
    basis: BASIS,
    currentServing,
    vehiclesWaiting: queue.filter((q) => q.status === "waiting").length,
    queueLength: line.queueLength,
    waitMinutes: line.waitMinutes,
    queue,
    you: { quantity, serviceSeconds, ...you },
    // The scheduler's summary for the chosen window (null without one).
    schedule: schedule
      ? {
          fuelType: fuelLabel(fuel),
          serviceDurationSeconds: serviceSeconds,
          resources: schedule.resources,
          vehiclesServing: line.servingCount,
          queueAhead: schedule.queueAhead,
          expectedWaitSeconds: schedule.expectedWaitSeconds,
          estimatedStartTime: schedule.estimatedStartTime,
          estimatedCompletionTime: schedule.estimatedCompletionTime,
          availableCapacity: schedule.availableCapacity,
          totalCapacity: schedule.totalCapacity,
          resourceAvailable: schedule.resourceAvailable,
          reason: schedule.reason,
        }
      : null,
  };
}

/**
 * Where a booking made now would land in one window: from the scheduler's
 * availability row (capacity and the next free position) and the nozzle
 * occupancy it was worked out from (vehicles scheduled ahead of it).
 */
async function scheduleForWindow({ stationId, fuel, quantity, bookingDate, timeSlot, station, now, serviceSeconds }) {
  const nozzleScheduler = require("./nozzleScheduler");
  const rows = await nozzleScheduler.generateAvailability(stationId, fuel, bookingDate, { station, now, quantity });
  const row = rows.find((r) => r.label === timeSlot);
  if (!row) return null;
  const win = nozzleScheduler.windowOf(bookingDate, timeSlot);
  const joinAt = Math.max(now.getTime(), win.start.getTime());
  const cap = row.capacity || { total: 0, available: 0, resources: 0 };
  if (!row.bookable) {
    return {
      joinAt,
      resources: cap.resources,
      queueAhead: 0,
      expectedWaitSeconds: null,
      estimatedStartTime: null,
      estimatedCompletionTime: null,
      availableCapacity: 0,
      totalCapacity: cap.total,
      resourceAvailable: false,
      reason: row.reason,
    };
  }
  const start = row.start.getTime();
  // Everyone on this fuel's nozzles between joining and that start: served,
  // waiting, walked in or booked into the window ahead.
  const windows =
    (await nozzleScheduler.loadActiveWindows([stationId], new Date(joinAt), new Date(start), { now, fuelType: fuel })).get(
      String(stationId),
    ) || [];
  const queueAhead = windows.filter((w) => new Date(w.start).getTime() < start && new Date(w.end).getTime() > joinAt).length;
  return {
    joinAt,
    resources: cap.resources,
    queueAhead,
    expectedWaitSeconds: Math.max(0, Math.round((start - joinAt) / 1000)),
    estimatedStartTime: new Date(start),
    estimatedCompletionTime: new Date(start + serviceSeconds * 1000),
    availableCapacity: cap.available,
    totalCapacity: cap.total,
    resourceAvailable: true,
    reason: null,
  };
}

// ---------------------------------------------------------------- queue clock
//
// Booking actions refresh the queue as they happen. But the line also moves
// with nothing but time: a booked slot starts (the car joins the line), a
// slot passes with no arrival (it drops out), a fill finishes, and every wait
// and ETA is a whole number of minutes counting down. Those instants are all
// known from the bookings themselves, so the clock wakes exactly then --
// not on a fixed poll -- recomputes, and pushes only stations that changed.

const CLOCK_MAX_SLEEP_MS = 60_000; // re-plan at least this often, so new bookings are included
const CLOCK_MIN_SLEEP_MS = 1_000;

/** What customers were last sent per fuel, by station (the station cache holds only totals). */
const lastSentLines = new Map();
const lineSignature = (snapshot) =>
  JSON.stringify(Object.entries(snapshot.byFuel || {}).map(([f, q]) => [f, q.queueLength, q.waitMinutes]));

/**
 * Pure: the next instant at which this station's lines, waits or any ETA
 * change, or null if nothing live is left.
 */
function nextQueueChange(bookings, now = new Date(), resourcesByFuel = {}) {
  const t = now.getTime();
  const slotMs = SLOT_SPACING_SECONDS * 1000;
  let next = Infinity;
  const consider = (ms) => {
    if (Number.isFinite(ms) && ms > t && ms < next) next = ms;
  };
  // A whole-minute countdown to `at` ticks down when its remaining time crosses the next minute.
  const minuteTick = (at) => {
    const d = at - t;
    if (Number.isFinite(d) && d > 0) consider(t + ((d - 1) % 60_000) + 1);
  };

  for (const b of bookings || []) {
    if (b.status === "serving") {
      consider(startMs(b, now) + durationMs(b));
    } else if (b.status === "upcoming" && b.bookingStartTime && !b.arrivalTime) {
      const start = new Date(b.bookingStartTime).getTime();
      consider(start); // joins the line
      consider(start + slotMs); // or drops out, never having arrived
    }
  }
  for (const [fuel, list] of groupByFuel(bookings)) {
    if (list.length === 0) continue;
    const line = simulateNozzleLine(list, now, { resources: resourcesByFuel[fuel] });
    minuteTick(line.lineClearsAt);
    for (const e of line.etas) minuteTick(e.turnAt);
  }

  return next === Infinity ? null : new Date(next);
}

/**
 * Recompute every station with a live line today (or a cached line that has
 * since emptied) and refresh -- write, emit queue/slot/ETA events -- only
 * those whose queue, wait, any fuel's line or any booking's ETA differs from
 * what clients were last sent.
 *
 * @param {object} [opts]
 * @param {Date} [opts.now]
 * @param {Array} [opts.stationIds]  limit to these stations (tests)
 * @returns {Promise<{checked:number, refreshed:number, nextAt:Date|null}>}
 */
async function reconcileQueues({ now = new Date(), stationIds = null } = {}) {
  const scope = stationIds ? { station: { $in: stationIds } } : {};
  const [rows, walkIns] = await Promise.all([
    Booking.find({
      ...scope,
      status: { $in: LINE_STATUSES },
      $or: [
        { status: "serving" },
        { bookingStartTime: { $gte: startOfBusinessDay(now), $lte: endOfBusinessDay(now) } },
      ],
    })
      .select(`${BOOKING_FIELDS} etaMinutes`)
      .lean(),
    WalkIn.find({
      ...scope,
      status: { $in: ["waiting", "serving"] },
      $or: [{ status: "serving" }, { businessDate: dateKey(now) }],
    }).lean(),
  ]);

  const byStation = new Map();
  const add = (r) => {
    const key = String(r.station);
    if (!byStation.has(key)) byStation.set(key, []);
    byStation.get(key).push(r);
  };
  rows.forEach(add);
  (await appLineWalkIns(walkIns)).map(walkInRow).forEach(add);
  // A station still showing a line whose bookings have all finished or gone.
  const showingLine = await Station.find({
    ...(stationIds ? { _id: { $in: stationIds } } : {}),
    $or: [{ queueLength: { $gt: 0 } }, { waitMinutes: { $gt: 0 } }],
  })
    .select("_id")
    .lean();
  for (const s of showingLine) if (!byStation.has(String(s._id))) byStation.set(String(s._id), []);

  const cached = new Map(
    (await Station.find({ _id: { $in: [...byStation.keys()] } }).select("queueLength waitMinutes queueStatus nozzleConfig").lean()).map(
      (s) => [String(s._id), s],
    ),
  );

  let refreshed = 0;
  let nextAt = null;
  for (const [stationId, list] of byStation) {
    const station = cached.get(stationId);
    if (!station) continue;
    const snap = simulateStation(list, now, resourcesByFuelOf(station));
    const sentEta = new Map(list.filter((b) => b.kind !== "walkin").map((b) => [String(b._id), b.etaMinutes]));
    const sentLines = lastSentLines.get(stationId);
    const signature = lineSignature(snap);
    const changed =
      station.queueLength !== snap.queueLength ||
      station.waitMinutes !== snap.waitMinutes ||
      station.queueStatus !== snap.queueStatus ||
      (sentLines !== undefined && sentLines !== signature) ||
      snap.etas.some((e) => e.kind === "booking" && sentEta.get(e.bookingId) !== e.etaMinutes);
    if (changed) {
      await refreshStationQueue(stationId, { now });
      refreshed += 1;
    } else {
      lastSentLines.set(stationId, signature);
    }
    const next = nextQueueChange(list, now, resourcesByFuelOf(station));
    if (next && (!nextAt || next < nextAt)) nextAt = next;
  }
  if (refreshed) metrics.inc("queue_clock_refresh_count", refreshed);
  return { checked: byStation.size, refreshed, nextAt };
}

/**
 * Run reconcileQueues at each next change instant (never sooner than 1 s,
 * never later than 60 s). Once per instant across server instances
 * (services/core/lock.js). Returns { stop }.
 */
function startQueueClockJob() {
  let timer = null;
  let stopped = false;

  const schedule = (ms) => {
    if (stopped) return;
    timer = setTimeout(run, Math.min(CLOCK_MAX_SLEEP_MS, Math.max(CLOCK_MIN_SLEEP_MS, ms)));
    if (typeof timer.unref === "function") timer.unref();
  };

  const run = async () => {
    let sleep = CLOCK_MAX_SLEEP_MS;
    try {
      const { ran, result } = await require("../core/lock").runExclusive("queueClock", 900, () => reconcileQueues());
      if (ran && result.nextAt) sleep = result.nextAt.getTime() - Date.now();
    } catch (err) {
      console.error("[queueClock] run failed:", err.message);
    }
    schedule(sleep);
  };

  schedule(CLOCK_MIN_SLEEP_MS);
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

module.exports = {
  simulateNozzleLine,
  simulateStation,
  groupByFuel,
  walkInRow,
  appLineWalkIns,
  resourcesByFuelOf,
  loadLineRows,
  queueSnapshots,
  fuelQueueSummary,
  refreshStationQueue,
  buildQueuePreview,
  maskVehicle,
  nextQueueChange,
  reconcileQueues,
  startQueueClockJob,
  BASIS,
};
