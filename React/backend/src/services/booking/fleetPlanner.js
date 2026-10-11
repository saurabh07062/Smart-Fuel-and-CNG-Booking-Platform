/**
 * Working out when each vehicle of a fleet can be fuelled.
 *
 * WHAT IT DOES
 *
 * Given a station, a fuel, a day, a time to start from and a list of
 * vehicles, it places each vehicle on the earliest position that is really
 * free -- consecutively where the station's nozzles allow it, and moving on to
 * the next windows when they do not. It returns the plan, and for every
 * vehicle it could not place it says why in words the customer can act on.
 *
 * IT DOES NOT INVENT CAPACITY
 *
 * The placement is the SAME machinery a single booking goes through
 * (services/queue/slotAllocator.js, through nozzleScheduler): the same
 * windows, the same nozzles, the same fill durations, the same grid. The only
 * thing this file adds is memory -- each vehicle it places is added to the
 * occupancy the next vehicle is placed around, so a plan for five vans is a
 * plan the station can actually serve, rather than five copies of "the next
 * free slot".
 *
 * IT IS A SUGGESTION, NOT A HOLD
 *
 * Nothing is reserved here. Between seeing a plan and confirming it, another
 * customer may take one of those positions -- so the plan carries the figures
 * it was computed from and services/booking/fleetBooking.js allocates again,
 * under the station's lock, when the customer confirms. A plan that has gone
 * stale costs that one vehicle a later slot; it never silently books the
 * wrong time.
 */

const mongoose = require("mongoose");
const Station = require("../../models/Station");
const Booking = require("../../models/Booking");
const nozzleScheduler = require("../queue/nozzleScheduler");
const allocator = require("../queue/slotAllocator");
const nozzleModes = require("../../config/nozzleModes");
const { normaliseFuel, fuelLabel, fuelUnit } = require("../../config/fuels");
const { getServiceDurationSeconds } = require("../../config/fuelDurations");
const {
  BOOKABLE_SLOT_LABELS,
  SLOT_GRID_SECONDS,
  QUANTITY_MIN,
  QUANTITY_MAX,
  isSlotElapsed,
} = require("../../config/booking");
const { formatHHMM } = require("../../config/businessTime");
const fuelAmountService = require("./fuelAmount");

/** The most vehicles one group may hold. */
const MAX_FLEET_VEHICLES = Number(process.env.FLEET_MAX_VEHICLES) || 10;
const MIN_FLEET_VEHICLES = 2;

/** Statuses that mean a vehicle is already spoken for. */
const ACTIVE_STATUSES = ["upcoming", "serving", "waitlisted"];

class FleetError extends Error {
  constructor(status, reason, message, extra = {}) {
    super(message);
    this.name = "FleetError";
    this.status = status;
    this.reason = reason;
    Object.assign(this, extra);
  }
}

/** A plate as the guard compares it: upper case, no spaces or dashes. */
function plateKey(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .slice(0, 20);
}

/**
 * Check the request and normalise the vehicle list.
 *
 * Everything a client sends is suspect: the plate, the quantity, the number of
 * vehicles, and whether the same van appears twice. A duplicate inside one
 * request is refused here rather than at the database, so the customer is told
 * which vehicle rather than shown a write error.
 */
function validateFleetInput(body = {}) {
  const fuel = normaliseFuel(body.fuelType);
  if (!fuel) throw new FleetError(400, "INVALID_FUEL_TYPE", `Unrecognised fuel type '${body.fuelType}'.`);

  const stationId = body.stationId;
  if (!stationId || !mongoose.isValidObjectId(stationId)) {
    throw new FleetError(400, "INVALID_STATION", "A valid stationId is required.");
  }

  const bookingDate = String(body.bookingDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) {
    throw new FleetError(400, "INVALID_DATE", "bookingDate must be a YYYY-MM-DD date.");
  }
  const bookingRules = require("../../config/booking");
  // A day that has already gone. Caught here rather than slot by slot at
  // confirmation time, so a customer who left the page open overnight is told
  // once, plainly, instead of being shown a plan in which every van failed.
  if (bookingDate < require("../../config/businessTime").dateKey()) {
    throw new FleetError(400, "DATE_PASSED", "That date has passed. Choose today or a later day.");
  }
  if (bookingRules.isBeyondAdvanceWindow(bookingDate)) {
    const days = bookingRules.advanceBookingDays();
    throw new FleetError(
      400,
      "DATE_TOO_FAR",
      `Bookings open only ${days} day${days === 1 ? "" : "s"} ahead. Choose a date up to ${bookingRules.lastBookableDate()}.`,
    );
  }

  // The time they would like to start from. Optional: without one the plan
  // starts at the first bookable window of the day.
  const preferredSlot = body.preferredSlot ? String(body.preferredSlot) : null;
  if (preferredSlot && !BOOKABLE_SLOT_LABELS.includes(preferredSlot)) {
    throw new FleetError(400, "INVALID_SLOT", "Choose one of the listed time slots as the preferred start.");
  }

  const list = Array.isArray(body.vehicles) ? body.vehicles : [];
  if (list.length < MIN_FLEET_VEHICLES) {
    throw new FleetError(
      400,
      "TOO_FEW_VEHICLES",
      `Choose at least ${MIN_FLEET_VEHICLES} vehicles. For one vehicle, use the normal booking.`,
    );
  }
  if (list.length > MAX_FLEET_VEHICLES) {
    throw new FleetError(400, "TOO_MANY_VEHICLES", `A fleet booking can hold up to ${MAX_FLEET_VEHICLES} vehicles.`);
  }

  const seen = new Map();
  const vehicles = list.map((raw, i) => {
    const plate = plateKey(raw?.vehiclePlate ?? raw?.plate ?? raw?.registrationNumber);
    if (!plate) {
      throw new FleetError(400, "VEHICLE_PLATE_REQUIRED", `Vehicle ${i + 1} has no registration number.`, { index: i });
    }
    if (seen.has(plate)) {
      throw new FleetError(
        400,
        "DUPLICATE_VEHICLE",
        `${plate} is in this booking twice. Each vehicle can hold one slot.`,
        { index: i, vehiclePlate: plate, firstIndex: seen.get(plate) },
      );
    }
    seen.set(plate, i);

    // Each vehicle says how much in its own terms: litres/kg, or rupees.
    // The rupees are turned into a quantity later, once the station's price
    // has been read (planFleet below), by the same resolver the single
    // booking flow uses -- one van may be "45 L" while the next is "₹500".
    let howMuch;
    try {
      howMuch = fuelAmountService.readRequest(raw || {});
    } catch (err) {
      throw new FleetError(400, err.reason || "INVALID_QUANTITY", `${plate}: ${err.message}`, {
        index: i,
        vehiclePlate: plate,
      });
    }
    const quantity = howMuch.quantity;

    return {
      index: i + 1,
      vehiclePlate: plate,
      vehicleKey: plate,
      // The saved vehicle it came from, when it came from the garage.
      vehicleRef: mongoose.isValidObjectId(raw?.vehicleId) ? String(raw.vehicleId) : null,
      vehicleType: typeof raw?.vehicleType === "string" ? raw.vehicleType : null,
      vehicleName: typeof raw?.nickname === "string" ? raw.nickname : typeof raw?.vehicleName === "string" ? raw.vehicleName : null,
      quantity,
      howMuch,
      bookedBy: howMuch.bookedBy,
      requestedAmount: howMuch.fuelAmount,
    };
  });

  /**
   * Reward points for the group, as ONE figure for the whole fleet.
   *
   * Not per vehicle: a customer fuelling five vans thinks about one discount on
   * one bill. It is split across the vehicles that actually get booked, in
   * proportion to their bills (services/booking/fleetBooking.js), so each van's
   * own receipt and its own cancellation carry their own share.
   *
   * Shape only here; the balance and the cap depend on the station's price.
   */
  const redeemPoints = (() => {
    const raw = body.redeemPoints;
    if (raw === undefined || raw === null || raw === "" || raw === false) return 0;
    const points = Number(raw);
    if (!Number.isInteger(points) || points < 0) {
      throw new FleetError(400, "INVALID_POINTS", "redeemPoints must be a whole number of reward points.");
    }
    return points;
  })();

  return { fuel, stationId: String(stationId), bookingDate, preferredSlot, vehicles, redeemPoints };
}

/**
 * The station facts a fleet plan depends on, or a refusal.
 *
 * Exactly the checks a single booking makes (services/booking/bookingCreate.js):
 * the station is open, sells this fuel, has it available, takes app bookings
 * on it, and publishes a price. Checked once for the whole group -- they all
 * share one station and one fuel.
 */
async function stationFor(stationId, fuel) {
  const station = await Station.findById(stationId)
    .select("name status fuelTypes fuelAvailability nozzleConfig prices inventory inventoryCommitted owner operatingSchedule openingHours")
    .lean();

  if (!station) throw new FleetError(404, "STATION_NOT_FOUND", "Station not found.");
  if (station.status !== "Active") {
    throw new FleetError(409, "STATION_INACTIVE", "This station is not accepting bookings right now.");
  }
  const label = fuelLabel(fuel);
  if (!(station.fuelTypes || []).some((f) => normaliseFuel(f) === fuel)) {
    throw new FleetError(409, "FUEL_NOT_SOLD", `This station does not sell ${label}.`);
  }
  if (station.fuelAvailability?.[fuel] === false) {
    throw new FleetError(409, "FUEL_UNAVAILABLE", `${label} is currently unavailable at this station.`);
  }
  if (!nozzleModes.acceptsOnline(station, fuel)) {
    throw new FleetError(409, "NOZZLE_OFFLINE_ONLY", nozzleModes.walkInOnlyMessage(fuel));
  }
  const price = Number(station.prices?.[fuel]);
  if (!Number.isFinite(price) || price <= 0) {
    throw new FleetError(409, "PRICE_UNAVAILABLE", `This station has not published a ${label} price.`);
  }
  return station;
}

/**
 * Turn every "₹500" vehicle into a real quantity, in place.
 *
 * Done here rather than in validateFleetInput because it needs the station's
 * published price, which is only read once the station has been loaded. The
 * arithmetic, the limits and the wording are the single booking flow's
 * (services/booking/fuelAmount.js): one van asking for litres and the next
 * asking for rupees are priced by the same rule.
 */
function resolveAmounts(vehicles, station, fuel) {
  for (const vehicle of vehicles) {
    if (vehicle.howMuch?.bookedBy !== "amount") continue;
    try {
      const resolved = fuelAmountService.resolve({
        unitPrice: station.prices?.[fuel],
        fuel,
        request: vehicle.howMuch,
      });
      vehicle.quantity = resolved.quantity;
      vehicle.requestedAmount = resolved.requestedAmount;
      vehicle.bookedBy = "amount";
    } catch (err) {
      throw new FleetError(err.reason === "PRICE_UNAVAILABLE" ? 409 : 400, err.reason, `${vehicle.vehiclePlate}: ${err.message}`, {
        vehiclePlate: vehicle.vehiclePlate,
      });
    }
  }
  return vehicles;
}

/** The labels a fleet may be placed in, in time order, from `preferredSlot`. */
function candidateLabels(station, bookingDate, preferredSlot, { now = new Date() } = {}) {
  const from = preferredSlot ? BOOKABLE_SLOT_LABELS.indexOf(preferredSlot) : 0;
  return BOOKABLE_SLOT_LABELS.slice(Math.max(from, 0)).filter(
    (label) =>
      // Not in the past, and only while the station is actually open -- the
      // same two rules a single booking is held to.
      !isSlotElapsed(bookingDate, label) && Station.scheduleAllowsSlot(station, bookingDate, label),
  );
}

/**
 * Which of these vehicles already hold a live booking.
 *
 * Returned as a map plate -> booking, so the plan can mark that vehicle as a
 * conflict and carry on with the others rather than refusing the whole group
 * because one van is already booked.
 */
async function vehiclesAlreadyBooked(userId, vehicles) {
  const keys = vehicles.map((v) => v.vehicleKey);
  const rows = await Booking.find({
    user: userId,
    vehicleKey: { $in: keys },
    status: { $in: ACTIVE_STATUSES },
  })
    .select("vehicleKey bookingDate timeSlot status orderId station")
    .lean();
  return new Map(rows.map((b) => [b.vehicleKey, b]));
}

/**
 * Build the schedule.
 *
 * The loop is the whole idea: vehicles are placed one after another, and each
 * placement is added to the occupancy the next placement sees. The search for
 * vehicle n+1 starts at the window vehicle n landed in -- not back at the
 * preferred time -- which is what produces a consecutive run when the station
 * can serve one, and the nearest following windows when it cannot.
 *
 * @returns {Promise<object>} the plan; see `shapePlan` at the foot of the file.
 */
async function planFleet({ user, body, now = new Date() }) {
  const input = validateFleetInput(body);
  const { fuel, stationId, bookingDate, preferredSlot, vehicles } = input;

  const station = await stationFor(stationId, fuel);
  resolveAmounts(vehicles, station, fuel);
  const resources = nozzleModes.onlineResources(station, fuel);
  if (resources < 1) {
    throw new FleetError(409, "NOZZLE_OFFLINE_ONLY", nozzleModes.walkInOnlyMessage(fuel));
  }

  const labels = candidateLabels(station, bookingDate, preferredSlot, { now });
  if (labels.length === 0) {
    throw new FleetError(
      409,
      "NO_SLOTS_LEFT",
      preferredSlot
        ? `There are no bookable slots at or after ${preferredSlot} on ${bookingDate}.`
        : `There are no bookable slots left on ${bookingDate}.`,
    );
  }

  // Everything already on this fuel's nozzles for the whole span in question:
  // one read, then placed around in memory.
  const spanStart = nozzleScheduler.windowOf(bookingDate, labels[0]).start;
  const spanEnd = nozzleScheduler.windowOf(bookingDate, labels[labels.length - 1]).end;
  const existing =
    (await nozzleScheduler.loadActiveWindows([stationId], spanStart, spanEnd, { now, fuelType: fuel })).get(
      String(stationId),
    ) || [];
  const busy = nozzleScheduler.busyByResource(existing, resources);

  // Vehicles that cannot be planned at all, because they are already booked.
  const alreadyBooked = await vehiclesAlreadyBooked(user.id, vehicles);

  const gridMs = SLOT_GRID_SECONDS * 1000;
  const assignments = [];
  let searchFrom = 0; // index into `labels`: where the next vehicle's search starts

  for (const vehicle of vehicles) {
    const clash = alreadyBooked.get(vehicle.vehicleKey);
    if (clash) {
      assignments.push({
        ...vehicle,
        state: "conflict",
        reason: "VEHICLE_ALREADY_BOOKED",
        message: `${vehicle.vehiclePlate} already has a booking (${clash.timeSlot || "a slot"} on ${clash.bookingDate}). Cancel it first, or leave this vehicle out.`,
        existingBookingId: String(clash._id),
      });
      continue;
    }

    const durationSeconds = getServiceDurationSeconds(fuel, vehicle.quantity);
    let placed = null;

    for (let i = searchFrom; i < labels.length; i += 1) {
      const label = labels[i];
      const win = nozzleScheduler.windowOf(bookingDate, label);
      const next = allocator.allocate({
        windowStart: win.start.getTime(),
        windowEnd: win.end.getTime(),
        notBefore: now.getTime(),
        durationMs: durationSeconds * 1000,
        busyByResource: busy,
        gridMs,
      });
      if (next) {
        placed = { label, labelIndex: i, ...next, durationSeconds };
        break;
      }
    }

    if (!placed) {
      assignments.push({
        ...vehicle,
        state: "unavailable",
        reason: "NO_SLOT_AVAILABLE",
        message: `No free position is left for ${vehicle.vehiclePlate} on ${bookingDate}. Try another day, or remove this vehicle.`,
      });
      continue;
    }

    // The next vehicle is looked for from here, so the group stays together.
    busy[placed.resource - 1].push({ start: placed.start, end: placed.end });
    searchFrom = placed.labelIndex;

    assignments.push({
      ...vehicle,
      state: "suggested",
      timeSlot: placed.label,
      startTime: formatHHMM(new Date(placed.start)),
      endTime: formatHHMM(new Date(placed.end)),
      startsAt: new Date(placed.start),
      endsAt: new Date(placed.end),
      resource: placed.resource,
      durationSeconds: placed.durationSeconds,
    });
  }

  return shapePlan({ station, fuel, bookingDate, preferredSlot, assignments, labels, resources, now });
}

/**
 * Re-plan ONE vehicle into a chosen window -- the "Edit slot" action.
 *
 * Takes the rest of the plan as given and asks whether this vehicle fits in
 * the label the customer picked, around everything already booked AND around
 * its own group. Answering per vehicle is the point: changing one van's time
 * must not shuffle the other four.
 */
async function planOneVehicle({ user, body, now = new Date() }) {
  const input = validateFleetInput({ ...body, vehicles: body.vehicles });
  const { fuel, stationId, bookingDate } = input;
  const label = String(body.timeSlot || "");
  if (!BOOKABLE_SLOT_LABELS.includes(label)) {
    throw new FleetError(400, "INVALID_SLOT", "Choose one of the listed time slots.");
  }

  const station = await stationFor(stationId, fuel);
  resolveAmounts(input.vehicles, station, fuel);
  if (!Station.scheduleAllowsSlot(station, bookingDate, label)) {
    throw new FleetError(409, "STATION_CLOSED_AT_SLOT", `This station is closed at ${label} on ${bookingDate}.`);
  }
  if (isSlotElapsed(bookingDate, label)) {
    throw new FleetError(400, "SLOT_PASSED", `The slot '${label}' has already passed.`);
  }

  const target = input.vehicles.find((v) => v.vehiclePlate === plateKey(body.vehiclePlate)) || input.vehicles[0];
  const others = input.vehicles.filter((v) => v !== target);
  const resources = nozzleModes.onlineResources(station, fuel);
  const win = nozzleScheduler.windowOf(bookingDate, label);

  const existing =
    (await nozzleScheduler.loadActiveWindows([stationId], win.start, win.end, { now, fuelType: fuel })).get(
      String(stationId),
    ) || [];
  const busy = nozzleScheduler.busyByResource(existing, resources);

  // The group's own other vehicles occupy their planned positions too --
  // otherwise two of the customer's own vans could be offered one nozzle.
  for (const other of others) {
    if (other.startsAt && other.endsAt) {
      const i = Math.min(resources, Math.max(1, Number(other.resource) || 1)) - 1;
      busy[i].push({ start: new Date(other.startsAt).getTime(), end: new Date(other.endsAt).getTime() });
    }
  }

  const durationSeconds = getServiceDurationSeconds(fuel, target.quantity);
  const next = allocator.allocate({
    windowStart: win.start.getTime(),
    windowEnd: win.end.getTime(),
    notBefore: now.getTime(),
    durationMs: durationSeconds * 1000,
    busyByResource: busy,
    gridMs: SLOT_GRID_SECONDS * 1000,
  });

  if (!next) {
    return {
      ...target,
      state: "full",
      reason: "SLOT_FULL",
      timeSlot: label,
      message: `${label} is full for ${fuelLabel(fuel)} at this station. Pick another time.`,
    };
  }

  return {
    ...target,
    state: "suggested",
    timeSlot: label,
    startTime: formatHHMM(new Date(next.start)),
    endTime: formatHHMM(new Date(next.end)),
    startsAt: new Date(next.start),
    endsAt: new Date(next.end),
    resource: next.resource,
    durationSeconds,
  };
}

/**
 * The plan as the client receives it: the vehicles, what it costs, and a
 * sentence explaining the shape of the schedule.
 *
 * The prices are the station's own published price (the same figure a single
 * booking is charged) plus the same convenience fee; nothing here invents a
 * rate, and a station with no published price never gets this far.
 */
function shapePlan({ station, fuel, bookingDate, preferredSlot, assignments, labels, resources, now }) {
  const { CONVENIENCE_FEE } = require("../../config/booking");
  const price = Number(station.prices?.[fuel]);
  const round2 = (n) => Math.round(n * 100) / 100;

  const priced = assignments.map((a) => {
    if (a.state !== "suggested") return a;
    const taxes = CONVENIENCE_FEE;
    return { ...a, pricePerUnit: price, taxes, amount: round2(price * a.quantity + taxes) };
  });

  const scheduled = priced.filter((a) => a.state === "suggested");
  const conflicts = priced.filter((a) => a.state === "conflict");
  const unplaced = priced.filter((a) => a.state === "unavailable");

  // Is the run consecutive? Two vehicles are "together" when the second starts
  // in the same window as the first or the one after it.
  const slotIndexes = scheduled.map((a) => labels.indexOf(a.timeSlot));
  const consecutive = slotIndexes.every((v, i) => i === 0 || v - slotIndexes[i - 1] <= 1);

  // Stock is not reserved by a plan, but a plan that obviously cannot be
  // served is worth saying so before the customer confirms it.
  const totalQuantity = round2(scheduled.reduce((sum, a) => sum + a.quantity, 0));
  const inTank = Number(station.inventory?.[fuel]);
  const committed = Number(station.inventoryCommitted?.[fuel]) || 0;
  const freeToSell = Number.isFinite(inTank) ? round2(Math.max(inTank - committed, 0)) : null;
  const stockShort = freeToSell !== null && totalQuantity > freeToSell;

  return {
    station: { stationId: String(station._id), name: station.name || null, nozzles: resources },
    fuelType: fuelLabel(fuel),
    unit: fuelUnit(fuel),
    bookingDate,
    preferredSlot,
    generatedAt: now,
    vehicles: priced,
    totals: {
      requested: priced.length,
      scheduled: scheduled.length,
      conflicts: conflicts.length,
      unavailable: unplaced.length,
      quantity: totalQuantity,
      amount: round2(scheduled.reduce((sum, a) => sum + (a.amount || 0), 0)),
    },
    stock: { freeToSell, enough: !stockShort },
    consecutive,
    // The one-line explanation the UI shows above the schedule. It describes
    // what actually happened, including when it is not what was asked for.
    summary: explain({ scheduled, conflicts, unplaced, consecutive, preferredSlot, stockShort, freeToSell, fuel }),
  };
}

/** The plan in a sentence -- honest about what could not be arranged. */
function explain({ scheduled, conflicts, unplaced, consecutive, preferredSlot, stockShort, freeToSell, fuel }) {
  const parts = [];
  if (scheduled.length === 0) {
    parts.push("No vehicle could be scheduled.");
  } else {
    const first = scheduled[0];
    const last = scheduled[scheduled.length - 1];
    parts.push(
      scheduled.length === 1
        ? `One vehicle at ${first.timeSlot}.`
        : first.timeSlot === last.timeSlot
          ? // Every vehicle fits the SAME window -- which is the usual outcome
            // for petrol or diesel, where a fill takes well under a minute and
            // a 30-minute window holds a queue of them. Saying "from 8:00 AM
            // to 8:00 AM" was technically true and read like a mistake.
            `${scheduled.length} vehicles in the ${first.timeSlot} window, one after another from ${first.startTime}.`
          : consecutive
            ? `${scheduled.length} vehicles back to back from ${first.timeSlot} to ${last.timeSlot}.`
            : `${scheduled.length} vehicles between ${first.timeSlot} and ${last.timeSlot} -- the nearest free positions, because the windows in between are full.`,
    );
    if (preferredSlot && first.timeSlot !== preferredSlot) {
      parts.push(`${preferredSlot} was full, so the run starts at ${first.timeSlot}.`);
    }
  }
  if (conflicts.length) {
    parts.push(
      `${conflicts.length} vehicle${conflicts.length === 1 ? "" : "s"} already ${conflicts.length === 1 ? "has" : "have"} a booking and ${conflicts.length === 1 ? "was" : "were"} left out.`,
    );
  }
  if (unplaced.length) {
    parts.push(`${unplaced.length} could not be fitted in on this day.`);
  }
  if (stockShort) {
    parts.push(`The station has ${freeToSell} ${fuelUnit(fuel)} free to sell, which is less than this plan needs.`);
  }
  return parts.join(" ");
}

module.exports = {
  FleetError,
  MAX_FLEET_VEHICLES,
  MIN_FLEET_VEHICLES,
  ACTIVE_STATUSES,
  plateKey,
  validateFleetInput,
  resolveAmounts,
  stationFor,
  candidateLabels,
  vehiclesAlreadyBooked,
  planFleet,
  planOneVehicle,
};
