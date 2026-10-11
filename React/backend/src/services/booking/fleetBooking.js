/**
 * Creating a fleet booking: one Booking per vehicle, grouped under one
 * FleetBooking.
 *
 * WHAT THIS IS BUILT AROUND
 *
 * A plan (services/booking/fleetPlanner.js) is a suggestion, not a hold.
 * Between the customer seeing it and pressing Confirm, somebody else may take
 * one of those positions. So confirmation does NOT trust the plan: every
 * vehicle is allocated again, here, under the same station lock a single
 * booking takes, against the live occupancy.
 *
 * PARTIAL SUCCESS IS A REAL OUTCOME
 *
 * If the fourth van's window filled up in the meantime, the right answer is
 * four bookings and one clearly-explained miss -- not five failures. The
 * request therefore reports per vehicle, and the four that were written stay
 * written. That is the explicit rule for this feature: recalculate the
 * affected vehicle, never cancel the group.
 *
 * WHAT IT REUSES
 *
 * Everything that makes a booking a booking: the nozzle scheduler for the
 * position, the stock ledger for the reservation, the same PIN and QR, the
 * same payment fields, the same realtime events and notifications. A fleet
 * member is an ordinary booking that happens to carry a group id, which is
 * why the vendor queue, check-in at the pump, ETA and revenue all work on it
 * without knowing this file exists.
 */

const crypto = require("crypto");
const Booking = require("../../models/Booking");
const FleetBooking = require("../../models/FleetBooking");
const Station = require("../../models/Station");
const User = require("../../models/User");
const lock = require("../core/lock");
const metrics = require("../core/metrics");
const nozzleScheduler = require("../queue/nozzleScheduler");
const allocator = require("../queue/slotAllocator");
const nozzleModes = require("../../config/nozzleModes");
const stockLedger = require("../inventory/stockLedger");
const realtime = require("../notification/realtime");
const notifications = require("../notification/notifications");
const { fuelLabel, fuelUnit, normaliseFuel } = require("../../config/fuels");
const { getServiceDurationSeconds } = require("../../config/fuelDurations");
const { formatHHMM, dateKey } = require("../../config/businessTime");
const { CONVENIENCE_FEE, SLOT_GRID_SECONDS, BOOKABLE_SLOT_LABELS, isSlotElapsed } = require("../../config/booking");
const { initialPaymentStatus, normalisePayMethod } = require("../payment/payMethod");
const { onlinePaymentsEnabled, ONLINE_PAYMENT_DISABLED_MSG } = require("../../config/payments");
const planner = require("./fleetPlanner");
const rewardService = require("../rewards/rewardService");
const rewardsConfig = require("../../config/rewards");

const { FleetError, ACTIVE_STATUSES } = planner;

/** "FM-FLEET-2026-8F3A1C2B" -- what the customer quotes for the whole group. */
function generateFleetReference() {
  return `FM-FLEET-${dateKey().slice(0, 4)}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

/** An order id for one member booking, in the same shape as every other. */
function generateOrderId() {
  return `FM-${dateKey().slice(0, 4)}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Confirm a fleet booking.
 *
 * @param {object} args
 * @param {{id: string}} args.user     the signed-in customer (never from the body)
 * @param {object} args.body           stationId, fuelType, bookingDate, payMethod, vehicles[]
 *        Each vehicle carries the slot the customer accepted or edited
 *        (`timeSlot`); the position INSIDE that slot is allocated here.
 * @returns {Promise<object>} { group, bookings, failures, summary }
 */
async function createFleetBooking({ user, body, now = new Date() }) {
  const started = Date.now();
  const input = planner.validateFleetInput(body);
  const { fuel, stationId, bookingDate, vehicles } = input;

  // Pay at the pump only, while online payment is switched off -- refused
  // before anything is reserved, exactly as a single booking is.
  const payMethod = normalisePayMethod(body.payMethod);
  if (payMethod === "online" && !onlinePaymentsEnabled()) {
    throw new FleetError(400, "ONLINE_PAYMENT_DISABLED", ONLINE_PAYMENT_DISABLED_MSG);
  }

  const station = await planner.stationFor(stationId, fuel);
  // "₹500 of diesel" becomes a quantity here, at the price just read -- not
  // at the price the customer saw while planning (services/booking/fuelAmount.js).
  planner.resolveAmounts(vehicles, station, fuel);
  const resources = nozzleModes.onlineResources(station, fuel);
  const customer = await User.findById(user.id).select("name email phone").lean();
  if (!customer) throw new FleetError(401, "ACCOUNT_NOT_FOUND", "Your account could not be found.");

  // The slot each vehicle is being confirmed into: what the customer accepted
  // (or edited). A vehicle without one is placed from the group's first slot.
  const wanted = vehicles.map((v, i) => {
    const raw = (body.vehicles || [])[i] || {};
    const label = String(raw.timeSlot || body.preferredSlot || "");
    return { ...v, timeSlot: BOOKABLE_SLOT_LABELS.includes(label) ? label : null };
  });

  for (const v of wanted) {
    if (!v.timeSlot) {
      throw new FleetError(400, "SLOT_REQUIRED", `${v.vehiclePlate} has no time slot. Find slots first, then confirm.`, {
        vehiclePlate: v.vehiclePlate,
      });
    }
    if (isSlotElapsed(bookingDate, v.timeSlot)) {
      throw new FleetError(400, "SLOT_PASSED", `The slot '${v.timeSlot}' has already passed.`, { vehiclePlate: v.vehiclePlate });
    }
    if (!Station.scheduleAllowsSlot(station, bookingDate, v.timeSlot)) {
      throw new FleetError(
        409,
        "STATION_CLOSED_AT_SLOT",
        `This station is closed at ${v.timeSlot} on ${bookingDate}.`,
        { vehiclePlate: v.vehiclePlate },
      );
    }
  }

  const price = Number(station.prices?.[fuel]);
  const label = fuelLabel(fuel);

  /**
   * ONE code for the whole group.
   *
   * Five vans arriving together are one customer standing at one window; five
   * different four-digit codes to read out, in the right order, is a worse
   * experience than the paper slip it replaced. Every member booking stores
   * the same code, and entering it once checks the whole group in
   * (controllers/bookingController.js verifyBooking): the first van starts
   * fuelling and the rest are recorded as waiting, in their booked order.
   *
   * It is no weaker than a per-vehicle code. The code still only works after
   * the customer has physically checked in at that station, still only at
   * that station's own pumps, and still only on the day of the booking.
   */
  const groupCode = String(crypto.randomInt(1000, 10000));

  // The group document exists before its members, so every member has
  // something to point at even if the process dies mid-way. A group with no
  // members reads as "empty" (models/FleetBooking.js) rather than as a lie.
  const group = await FleetBooking.create({
    reference: generateFleetReference(),
    user: user.id,
    station: stationId,
    fuelType: label,
    bookingDate,
    preferredSlot: body.preferredSlot || wanted[0].timeSlot,
    vehicleCount: wanted.length,
    quantityTotal: round2(wanted.reduce((sum, v) => sum + v.quantity, 0)),
    amountTotal: round2(wanted.reduce((sum, v) => sum + price * v.quantity + CONVENIENCE_FEE, 0)),
    createdBy: user.id,
  });

  const written = [];
  const failures = [];

  /**
   * Write the whole group under the fuel's nozzle lock.
   *
   * One lock for the group rather than one per vehicle: taking and releasing
   * it five times would let another customer slip between two of the vans and
   * break the run the customer just accepted. The lock is the same key a
   * single booking takes, so the two cannot interleave either.
   */
  const writeAll = async (guard) => {
    await require("../core/schedulingIndexes").ensureSchedulingIndexes();

    // Vehicles already holding a live booking are refused here rather than at
    // the index, so the customer is told which van and why.
    const alreadyBooked = await planner.vehiclesAlreadyBooked(user.id, wanted);

    for (const [i, vehicle] of wanted.entries()) {
      guard?.assertHeld?.();

      const clash = alreadyBooked.get(vehicle.vehicleKey);
      if (clash) {
        failures.push({
          ...publicVehicle(vehicle),
          reason: "VEHICLE_ALREADY_BOOKED",
          message: `${vehicle.vehiclePlate} already has a booking (${clash.timeSlot || "a slot"} on ${clash.bookingDate}), so it was left out.`,
        });
        continue;
      }

      const outcome = await writeOne({
        user,
        customer,
        station,
        stationId,
        fuel,
        label,
        price,
        bookingDate,
        payMethod: body.payMethod,
        vehicle,
        fleetIndex: i + 1,
        group,
        groupCode,
        resources,
        now,
      });

      if (outcome.booking) written.push(outcome.booking);
      else failures.push({ ...publicVehicle(vehicle), reason: outcome.reason, message: outcome.message });
    }
  };

  try {
    await lock.withLock(require("../queue/nozzleService").nozzleKey(stationId, fuel), (guard) => writeAll(guard), {
      ttlMs: 20_000,
      maxWaitMs: 5_000,
    });
  } catch (err) {
    // The codes services/core/lock.js actually raises when the fuel's nozzle
    // lock could not be taken, or ran out before the protected write.
    if (err?.code === "LOCK_TIMEOUT" || err?.code === "LOCK_UNAVAILABLE" || err?.code === "LOCK_EXPIRED") {
      // Someone else is booking this fuel right now. Nothing was written under
      // a lock we did not hold, so the group is simply removed and the
      // customer asked to try again -- no half-made bookings.
      await FleetBooking.deleteOne({ _id: group._id }).catch(() => {});
      throw new FleetError(
        409,
        "STATION_BUSY",
        "This station is being booked by someone else at the moment. Try again in a few seconds.",
      );
    }
    throw err;
  }

  // A group that got nothing is not a group. Removing it keeps the customer's
  // fleet list free of empty references.
  if (written.length === 0) {
    await FleetBooking.deleteOne({ _id: group._id }).catch(() => {});
    metrics.inc("fleet_booking_rejected_count");
    throw new FleetError(409, "NO_VEHICLE_BOOKED", failures[0]?.message || "None of these vehicles could be booked.", {
      failures,
    });
  }

  // The group's reward-points discount, now that it is known which vehicles
  // were actually booked. Split across them; never fatal.
  const reward = await applyFleetDiscount({ user, points: input.redeemPoints, bookings: written, group });

  // Everything below happens AFTER the writes, so nothing is announced that
  // was not stored (the ordering rule in services/notification/realtime.js).
  await announce({ user, group, station, bookings: written, label });

  metrics.inc("fleet_booking_created_count");
  metrics.observe("fleet_booking_create_ms", Date.now() - started);

  return {
    group: await publicGroup(group, written),
    bookings: written.map(publicBooking),
    failures,
    summary: summarise(written, failures),
    // Present only when points were asked for: what was applied, or why not.
    ...(reward ? { reward } : {}),
  };
}

/**
 * One reward-points discount, spread across the vehicles that were booked.
 *
 * WHY IT IS SPLIT RATHER THAN HELD AT THE GROUP
 *
 * Each van in a fleet is a full booking of its own: its own slot, its own
 * receipt, its own cancellation (models/Booking.js). A discount recorded once
 * against the group could not answer "what does THIS van cost?" and could not
 * be partly returned when one van is cancelled. Split in proportion to each
 * bill, by largest remainder so the shares add up to exactly the points spent,
 * each van carries its own share and the existing per-booking reversal
 * (services/booking/bookingTransitions.js) works unchanged.
 *
 * WHY IT RUNS AFTER THE BOOKINGS EXIST
 *
 * Because the customer may have asked for five vehicles and got four: the cap
 * ("points may cover up to 20% of a bill") has to be measured against what was
 * actually committed, not against what was requested.
 *
 * Never throws. The bookings are already confirmed, and losing four slots
 * because a discount could not be applied would be the worse outcome by far;
 * the return value tells the customer what happened.
 *
 * @returns {Promise<{applied:boolean, points:number, discount:number, msg:string}|null>}
 */
async function applyFleetDiscount({ user, points, bookings, group }) {
  const want = Math.floor(Number(points) || 0);
  if (want <= 0 || bookings.length === 0) return null;

  const committed = round2(bookings.reduce((sum, b) => sum + (Number(b.amount) || 0), 0));

  let allowed;
  try {
    allowed = await rewardService.validateRedemption({ userId: user.id, amount: committed, points: want });
  } catch (err) {
    if (err instanceof rewardService.RewardError) {
      console.warn(`[fleet] group ${group.reference}: discount not applied (${err.reason}).`);
      return { applied: false, points: 0, discount: 0, msg: err.message };
    }
    throw err;
  }
  if (!allowed) return null;

  const shares = splitPoints(allowed.points, bookings.map((b) => Number(b.amount) || 0));
  let spent = 0;
  let discounted = 0;

  for (const [i, booking] of bookings.entries()) {
    const share = shares[i];
    if (share <= 0) continue;
    try {
      await rewardService.redeem({
        userId: user.id,
        points: share,
        booking: booking._id,
        fleetGroup: group._id,
        note: `Discount on ${booking.vehiclePlate || `vehicle ${i + 1}`} (${group.reference})`,
      });
    } catch (err) {
      // The balance ran out part-way. The vans already discounted keep theirs;
      // the rest are charged in full. Nothing is taken that was not recorded.
      console.warn(`[fleet] group ${group.reference}: ran out of points at vehicle ${i + 1} (${err.reason || err.message}).`);
      break;
    }
    const discount = rewardsConfig.rupeesFor(share);
    const payable = round2(Math.max(0, (Number(booking.amount) || 0) - discount));
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { rewardPointsUsed: share, rewardDiscount: discount, payableAmount: payable } },
    ).catch((e) => console.error(`[fleet] could not record the discount on ${booking._id}:`, e.message));
    // Keep the in-memory copies in step, so the response and the notifications
    // quote the discounted figures rather than the full ones.
    booking.rewardPointsUsed = share;
    booking.rewardDiscount = discount;
    booking.payableAmount = payable;
    spent += share;
    discounted = round2(discounted + discount);
  }

  if (spent === 0) return { applied: false, points: 0, discount: 0, msg: "Your reward points were not applied." };
  return {
    applied: true,
    points: spent,
    discount: discounted,
    msg: `${spent} reward points applied — ₹${discounted} off ${bookings.length === 1 ? "this booking" : "these bookings"}.`,
  };
}

/**
 * Split `total` whole points across bills, in proportion, losing nothing.
 *
 * Plain proportional division leaves a remainder (3 vans, 10 points: 3.33 each)
 * and rounding each share down would quietly keep points the customer spent.
 * The largest-remainder method gives the leftover to the bills with the biggest
 * fractions, so the shares always add up to exactly `total`.
 */
function splitPoints(total, bills) {
  const sum = bills.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return bills.map(() => 0);

  const exact = bills.map((bill) => (bill / sum) * total);
  const shares = exact.map(Math.floor);
  let left = total - shares.reduce((a, b) => a + b, 0);

  const order = exact
    .map((value, i) => ({ i, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let k = 0; left > 0; k += 1, left -= 1) shares[order[k % order.length].i] += 1;

  return shares;
}

/**
 * One vehicle: allocate, reserve its fuel, write it.
 *
 * Returns { booking } or { reason, message } -- it never throws for a problem
 * that concerns only this vehicle, because the rest of the group must still go
 * through.
 */
async function writeOne({
  user,
  customer,
  station,
  stationId,
  fuel,
  label,
  price,
  bookingDate,
  payMethod,
  vehicle,
  fleetIndex,
  group,
  groupCode,
  resources,
  now,
}) {
  const durationSeconds = getServiceDurationSeconds(fuel, vehicle.quantity);
  const win = nozzleScheduler.windowOf(bookingDate, vehicle.timeSlot);

  // The live occupancy of this window, read again now -- this is the recheck
  // the plan cannot do for us.
  const existing =
    (await nozzleScheduler.loadActiveWindows([stationId], win.start, win.end, { now, fuelType: fuel })).get(
      String(stationId),
    ) || [];
  const position = allocator.allocate({
    windowStart: win.start.getTime(),
    windowEnd: win.end.getTime(),
    notBefore: now.getTime(),
    durationMs: durationSeconds * 1000,
    busyByResource: nozzleScheduler.busyByResource(existing, resources),
    gridMs: SLOT_GRID_SECONDS * 1000,
  });

  if (!position) {
    metrics.inc("fleet_slot_taken_count");
    return {
      reason: "SLOT_TAKEN",
      message: `${vehicle.timeSlot} filled up before this was confirmed, so ${vehicle.vehiclePlate} was not booked. Pick another time for it.`,
    };
  }

  const taxes = CONVENIENCE_FEE;
  const amount = round2(price * vehicle.quantity + taxes);

  const doc = new Booking({
    user: user.id,
    station: stationId,
    stationName: station.name || null,
    userName: customer.name || null,
    userContact: customer.phone || customer.email || null,
    fuelType: label,
    quantity: vehicle.quantity,
    bookedBy: vehicle.bookedBy === "amount" ? "amount" : "quantity",
    requestedAmount: vehicle.requestedAmount ?? null,
    price,
    taxes,
    amount,
    bookingDate,
    timeSlot: vehicle.timeSlot,
    startTime: formatHHMM(new Date(position.start)),
    endTime: formatHHMM(new Date(position.end)),
    bookingStartTime: new Date(position.start),
    bookingEndTime: new Date(position.end),
    resource: position.resource,
    serviceDurationSeconds: durationSeconds,
    vehiclePlate: vehicle.vehiclePlate,
    vehicleKey: vehicle.vehicleKey,
    vehicleRef: vehicle.vehicleRef || null,
    vehicleType: vehicle.vehicleType || null,
    vehicleName: vehicle.vehicleName || null,
    fleetGroup: group._id,
    fleetIndex,
    payMethod,
    paymentStatus: initialPaymentStatus(payMethod),
    // The GROUP's code, shared by every vehicle in it: one number the
    // customer shows once (see where groupCode is made, above). The QR stays
    // per booking, so scanning one van's pass still identifies that van.
    verificationCode: groupCode,
    qrCodeData: crypto.randomBytes(16).toString("hex"),
    orderId: generateOrderId(),
    status: "upcoming",
  });
  doc.$locals.rawPayMethod = payMethod;

  // Stock, the same conditional reservation a single booking makes: the
  // station cannot be oversold even if five requests arrive together.
  if (!(await stockLedger.reserveStock(stationId, fuel, vehicle.quantity))) {
    return {
      reason: "INSUFFICIENT_STOCK",
      message: `The station does not have enough ${label} left for ${vehicle.vehiclePlate} (${vehicle.quantity} ${fuelUnit(fuel)}).`,
    };
  }
  doc.stockReserved = true;

  try {
    await doc.save();
    // The lock serialised this fuel; if it was lost, check and back out rather
    // than double-book a nozzle.
    const clash = await nozzleScheduler.hasOverlap(stationId, doc.bookingStartTime, doc.bookingEndTime, doc._id, {
      fuelType: fuel,
      resource: position.resource,
    });
    if (clash) {
      await Booking.deleteOne({ _id: doc._id });
      throw Object.assign(new Error("overlap after write"), { code: 11000 });
    }
    return { booking: doc };
  } catch (err) {
    await stockLedger
      .unreserveStock(stationId, fuel, vehicle.quantity)
      .catch((e) => console.error("[fleet] failed to give back a reservation:", e.message));

    if (err?.code === 11000) {
      const byVehicle = Boolean(err.keyPattern?.vehicleKey) || /uniq_active_booking_per_vehicle/.test(err.message || "");
      return byVehicle
        ? {
            reason: "VEHICLE_ALREADY_BOOKED",
            message: `${vehicle.vehiclePlate} already has an active booking, so it was left out.`,
          }
        : {
            reason: "SLOT_TAKEN",
            message: `${vehicle.timeSlot} was taken while this was being confirmed, so ${vehicle.vehiclePlate} was not booked.`,
          };
    }
    console.error("[fleet] could not write a member booking:", err.message);
    return { reason: "ERROR", message: `${vehicle.vehiclePlate} could not be booked. Please try again.` };
  }
}

/**
 * Tell everyone who needs to know, once the bookings exist.
 *
 * Each member goes out as an ordinary booking:created -- which is what makes
 * the vendor's queue, the admin console and the customer's own screens update
 * without knowing anything about fleets -- and the customer gets ONE
 * notification for the group rather than five.
 */
async function announce({ user, group, station, bookings, label }) {
  for (const booking of bookings) {
    try {
      realtime.bookingChanged(realtime.EVENTS.BOOKING_CREATED, booking, { stationOwner: station.owner });
    } catch (err) {
      console.error("[fleet] realtime announce failed:", err.message);
    }
  }

  const first = bookings[0];
  const last = bookings[bookings.length - 1];
  await notifications
    .notify({
      user: user.id,
      type: "booking_created",
      title: `${bookings.length} vehicle${bookings.length === 1 ? "" : "s"} booked`,
      body:
        bookings.length === 1
          ? `${first.vehiclePlate} at ${first.timeSlot}, ${station.name || "your station"}.`
          : `${label} for ${bookings.length} vehicles at ${station.name || "your station"}, ${first.timeSlot} to ${last.timeSlot}. Reference ${group.reference}.`,
      link: "booking",
      booking: first._id,
      station: station._id,
      dedupeKey: `fleet:${group._id}:created`,
    })
    .catch((err) => console.error("[fleet] notification failed:", err.message));

  // The station's queue figures move because several bookings just landed.
  require("../queue/stationQueue")
    .refreshStationQueue(station._id)
    .catch((err) => console.error("[fleet] queue refresh failed:", err.message));
}

// ── reading ────────────────────────────────────────────────────────────────

/**
 * One group with its member bookings, for the customer who owns it.
 *
 * The members are read live and their state is derived from them, so a group
 * never disagrees with the bookings it contains.
 */
async function getFleetBooking(user, groupId, { withQueue = true } = {}) {
  if (!planner.plateKey && !groupId) return null;
  const filter = { _id: groupId };
  // A customer sees only their own; an admin sees any (the controller decides
  // which of the two it is asking for).
  if (user.role !== "admin") filter.user = user.id;

  const group = await FleetBooking.findOne(filter).populate("station", "name address contactPhone status").lean();
  if (!group) return null;

  let bookings = await Booking.find({ fleetGroup: group._id }).sort({ fleetIndex: 1 }).lean();
  if (withQueue) {
    // The same live figures a single booking shows (vehicles ahead, wait, ETA).
    bookings = await require("../queue/queueInfo").withQueueInfo(bookings);
  }

  return { ...(await publicGroup(group, bookings)), bookings: bookings.map(publicBooking) };
}

/** A customer's fleet groups, newest first. */
async function listFleetBookings(user, { limit = 20 } = {}) {
  const groups = await FleetBooking.find({ user: user.id })
    .populate("station", "name address status")
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 20, 1), 50))
    .lean();
  if (groups.length === 0) return { groups: [] };

  const members = await Booking.find({ fleetGroup: { $in: groups.map((g) => g._id) } })
    .select("fleetGroup fleetIndex status vehiclePlate timeSlot amount paymentStatus")
    .lean();
  const byGroup = new Map();
  for (const b of members) {
    const key = String(b.fleetGroup);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(b);
  }

  return {
    groups: await Promise.all(groups.map((g) => publicGroup(g, byGroup.get(String(g._id)) || []))),
  };
}

/** The group as a client sees it, with its state read from the members. */
async function publicGroup(group, bookings) {
  const state = FleetBooking.statusOf(bookings);
  const station = group.station && typeof group.station === "object" ? group.station : null;
  return {
    fleetId: String(group._id),
    reference: group.reference,
    // The one code for the whole group. Read from a member rather than stored
    // twice: the bookings are what the attendant's check-in matches against.
    pin: bookings.find((b) => b.verificationCode)?.verificationCode ?? null,
    fuelType: group.fuelType,
    bookingDate: group.bookingDate,
    preferredSlot: group.preferredSlot || null,
    vehicleCount: group.vehicleCount,
    createdAt: group.createdAt,
    station: station
      ? { stationId: String(station._id), name: station.name || null, address: station.address || null, status: station.status || null }
      : { stationId: String(group.station) },
    status: state.state,
    counts: { total: state.total, live: state.live, completed: state.completed, cancelled: state.cancelled },
    // Read from what the members actually hold now, so a cancellation is
    // reflected instead of the figure frozen at booking time.
    quantity: round2(bookings.reduce((sum, b) => sum + (b.status === "cancelled" ? 0 : Number(b.quantity) || 0), 0)),
    amount: round2(bookings.reduce((sum, b) => sum + (b.status === "cancelled" ? 0 : Number(b.amount) || 0), 0)),
    // The group's reward discount and what is left to pay, over the vehicles
    // that are still going ahead -- a cancelled van's share was returned to the
    // customer's balance, so it is not a discount on this group any more.
    rewardPointsUsed: bookings.reduce((sum, b) => sum + (b.status === "cancelled" ? 0 : Number(b.rewardPointsUsed) || 0), 0),
    rewardDiscount: round2(bookings.reduce((sum, b) => sum + (b.status === "cancelled" ? 0 : Number(b.rewardDiscount) || 0), 0)),
    payableAmount: round2(
      bookings.reduce(
        (sum, b) => sum + (b.status === "cancelled" ? 0 : Number(b.payableAmount ?? b.amount) || 0),
        0,
      ),
    ),
    vehicles: bookings.map((b) => ({
      bookingId: String(b._id),
      vehiclePlate: b.vehiclePlate || null,
      timeSlot: b.timeSlot || null,
      status: b.status,
      paymentStatus: b.paymentStatus || null,
    })),
  };
}

/** One member booking, in the shape the customer's booking screens expect. */
function publicBooking(b) {
  const row = typeof b?.toObject === "function" ? b.toObject() : b;
  return {
    bookingId: String(row._id),
    orderId: row.orderId || null,
    fleetGroup: row.fleetGroup ? String(row.fleetGroup) : null,
    fleetIndex: row.fleetIndex ?? null,
    vehiclePlate: row.vehiclePlate || null,
    vehicleName: row.vehicleName || null,
    fuelType: row.fuelType,
    quantity: row.quantity,
    bookedBy: row.bookedBy || "quantity",
    requestedAmount: row.requestedAmount ?? null,
    amount: row.amount,
    // What this vehicle costs after its share of the group discount.
    rewardPointsUsed: row.rewardPointsUsed || 0,
    rewardDiscount: row.rewardDiscount || 0,
    payableAmount: row.payableAmount ?? row.amount,
    bookingDate: row.bookingDate,
    timeSlot: row.timeSlot,
    startTime: row.startTime || null,
    endTime: row.endTime || null,
    status: row.status,
    paymentStatus: row.paymentStatus || null,
    verificationCode: row.verificationCode || null,
    qrCodeData: row.qrCodeData || null,
    queueInfo: row.queueInfo ?? null,
    etaMinutes: row.etaMinutes ?? null,
    stationCheckInAt: row.stationCheckInAt || null,
  };
}

function publicVehicle(v) {
  return { vehiclePlate: v.vehiclePlate, quantity: v.quantity, timeSlot: v.timeSlot || null, fleetIndex: v.index ?? null };
}

/** What happened, in a sentence -- including what did not. */
function summarise(written, failures) {
  const parts = [];
  if (written.length) {
    const first = written[0];
    const last = written[written.length - 1];
    parts.push(
      written.length === 1
        ? `1 vehicle booked at ${first.timeSlot}.`
        : first.timeSlot === last.timeSlot
          ? // All in one window, which is the usual outcome for a fuel whose
            // fill takes under a minute. "10:00 AM to 10:00 AM" was true and
            // read like a bug (the planner's summary has the same fix).
            `${written.length} vehicles booked in the ${first.timeSlot} window.`
          : `${written.length} vehicles booked, ${first.timeSlot} to ${last.timeSlot}.`,
    );
  }
  if (failures.length) {
    parts.push(
      `${failures.length} could not be booked: ${failures.map((f) => f.vehiclePlate).join(", ")}. The rest are confirmed.`,
    );
  }
  return parts.join(" ");
}

module.exports = {
  createFleetBooking,
  getFleetBooking,
  listFleetBookings,
  publicGroup,
  publicBooking,
  generateFleetReference,
  // Exported for test/rewardPoints.test.js: the split is arithmetic worth
  // checking on its own, without booking five vans to do it.
  splitPoints,
};
