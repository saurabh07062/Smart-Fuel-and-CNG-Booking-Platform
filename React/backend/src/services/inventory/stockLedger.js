/**
 * Station fuel stock: reservations, sales, deliveries and low-stock alerts.
 *
 * Stock has two numbers per fuel on the Station document:
 *
 *   inventory            what is in the tank
 *   inventoryCommitted   what live bookings have been promised
 *
 * and available = inventory - inventoryCommitted.
 *
 * The database guard (what the station lock alone could not give):
 *   reserveStock  one conditional $inc -- the station document is matched only
 *                 if available still covers the quantity. Two requests racing
 *                 for the last 10 L cannot both match, whatever the locks did.
 *
 * Exactly-once bookkeeping, keyed on Booking.stockReserved:
 *   reserve   booking creation (and waitlist promotion) sets it true
 *   release   cancel / expiry / no-show: the booking update that clears the
 *             flag is conditional on it being true, so the commitment is
 *             given back once even if several paths try
 *   sale      completion clears the flag in its own conditional update and
 *             takes the quantity off both inventory and the commitment
 *
 * Every change to physical stock is recorded (models/InventoryMovement).
 * Low-stock alerts go to the owning vendor when a fuel drops INTO a worse tier.
 *
 * Without a MongoDB replica set the booking write and the station write are
 * separate; a crash between them can leave the commitment too high (never
 * too low, so stock is never over-sold). reconcileCommitments() finds and
 * repairs that, and runs with the booking sweep.
 */

const mongoose = require("mongoose");
const Station = require("../../models/Station");
const Booking = require("../../models/Booking");
const BookingAttempt = require("../../models/BookingAttempt");
const InventoryMovement = require("../../models/InventoryMovement");
const metrics = require("../core/metrics");
const { classifyStock, TIERS } = require("./inventoryThreshold");
const { FUEL_KEYS, FUEL_UNITS, normaliseFuel, fuelLabel } = require("../../config/fuels");
const { dateKey } = require("../../config/businessTime");

const LIVE_STATUSES = ["upcoming", "serving"];
const oid = (id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

/**
 * Commit `quantity` of `fuel` at a station, only if available stock covers it.
 * @returns {Promise<boolean>} false = not enough stock (nothing changed)
 */
async function reserveStock(stationId, fuel, quantity) {
  const key = normaliseFuel(fuel);
  const qty = Number(quantity);
  if (!key || !(qty > 0)) return false;

  const result = await Station.collection.updateOne(
    {
      _id: oid(stationId),
      $expr: {
        $gte: [
          { $subtract: [{ $ifNull: [`$inventory.${key}`, 0] }, { $ifNull: [`$inventoryCommitted.${key}`, 0] }] },
          qty,
        ],
      },
    },
    { $inc: { [`inventoryCommitted.${key}`]: qty } },
  );
  metrics.inc(result.modifiedCount ? "stock_reserved_count" : "stock_reservation_refused_count");
  return result.modifiedCount === 1;
}

/** Give back a commitment (floored at zero). For a reservation whose booking was never saved. */
async function unreserveStock(stationId, fuel, quantity) {
  const key = normaliseFuel(fuel);
  const qty = Number(quantity);
  if (!key || !(qty > 0)) return false;
  const path = `inventoryCommitted.${key}`;
  const result = await Station.collection.updateOne({ _id: oid(stationId) }, [
    { $set: { [path]: { $max: [0, { $subtract: [{ $ifNull: [`$${path}`, 0] }, qty] }] } } },
  ]);
  return result.modifiedCount === 1;
}

/**
 * Release a booking's commitment once it is no longer live without having
 * completed (cancelled, expired, no-show). Exactly once: the flag is cleared
 * conditionally and only the caller that cleared it gives the stock back.
 */
async function releaseReservation(bookingId) {
  const before = await Booking.findOneAndUpdate(
    { _id: bookingId, stockReserved: true, status: { $nin: LIVE_STATUSES } },
    { $set: { stockReserved: false } },
    { new: false },
  )
    .select("station fuelType quantity")
    .lean();
  if (!before) return false;

  await unreserveStock(before.station, before.fuelType, before.quantity);
  metrics.inc("stock_released_count");
  return true;
}

/**
 * Release every reservation whose booking has stopped being live -- after the
 * bulk status updates (expiry, no-show sweeps) and as a safety net.
 */
async function releaseStaleReservations(filter = {}) {
  const rows = await Booking.find({ ...filter, stockReserved: true, status: { $nin: LIVE_STATUSES } })
    .select("_id")
    .limit(1000)
    .lean();
  let released = 0;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop -- each is its own conditional update
    if (await releaseReservation(r._id)) released += 1;
  }
  return released;
}

// ---------------------------------------------------------------------------
// Physical stock changes
// ---------------------------------------------------------------------------

const SEVERITY = { [TIERS.NORMAL]: 0, [TIERS.UNKNOWN]: 0, [TIERS.LOW]: 1, [TIERS.CRITICAL]: 2, [TIERS.OUT]: 3 };

/**
 * Tell the station's vendor when a fuel drops INTO a worse tier (normal ->
 * low, low -> critical, anything -> out). Staying in the same tier, or
 * recovering, is not news. One notification per station, fuel, tier and day.
 */
async function alertIfLow({ station, fuel, stockBefore, stockAfter }) {
  if (!station?.owner) return null;
  const capacity = station.tankCapacity?.[fuel];
  const before = classifyStock(stockBefore, capacity);
  const after = classifyStock(stockAfter, capacity);
  if (SEVERITY[after.tier] === 0 || SEVERITY[after.tier] <= SEVERITY[before.tier]) return null;

  const unit = FUEL_UNITS[fuel];
  const label = fuelLabel(fuel);
  const detail = `${stockAfter} ${unit} left${after.percent !== null ? ` (${after.percent}% of the tank)` : ""}.`;
  const notifications = require("../notification/notifications");
  const note = await notifications.notify({
    user: station.owner,
    type: "low_stock",
    title: `${label} ${after.tier === TIERS.OUT ? "is out of stock" : `is ${after.label.toLowerCase()}`} at ${station.name}`,
    body: detail,
    link: "vendor-panel",
    station: station._id,
    dedupeKey: `stock:${station._id}:${fuel}:${after.tier}:${dateKey()}`,
  });
  if (note) {
    metrics.inc("low_stock_alert_count");
    try {
      require("../notification/realtime").toVendor(station.owner, "low_stock_alert", {
        stationId: String(station._id),
        stationName: station.name,
        fuel,
        stock: stockAfter,
        capacity: capacity ?? null,
        percent: after.percent,
        tier: after.tier,
      });
    } catch (err) {
      console.error("[stockLedger] low-stock emit failed:", err.message);
    }
  }
  return note;
}

/**
 * A completed booking's fuel leaves the tank: take its quantity off stock
 * (floored at zero) and, if it held a reservation, off the commitment too --
 * one station update. Recorded as a sale; may raise a low-stock alert.
 */
async function recordSale(booking, { releaseCommitment = false } = {}) {
  const fuel = normaliseFuel(booking.fuelType);
  const qty = Number(booking.quantity);
  if (!fuel || !(qty > 0) || !booking.station) return null;

  const stockPath = `inventory.${fuel}`;
  const commitPath = `inventoryCommitted.${fuel}`;
  const minus = (path) => ({ $max: [0, { $subtract: [{ $ifNull: [`$${path}`, 0] }, qty] }] });

  const before = await Station.collection.findOneAndUpdate(
    { _id: oid(booking.station._id || booking.station) },
    [{ $set: { [stockPath]: minus(stockPath), ...(releaseCommitment ? { [commitPath]: minus(commitPath) } : {}) } }],
    { returnDocument: "before" },
  );
  if (!before) return null;

  const stockBefore = num(before.inventory?.[fuel]);
  const stockAfter = Math.max(0, stockBefore - qty);
  metrics.inc("inventory_deducted_count");

  try {
    await InventoryMovement.create({
      station: before._id,
      fuel,
      type: "sale",
      quantity: -qty,
      stockAfter,
      unit: FUEL_UNITS[fuel],
      booking: booking._id,
    });
  } catch (err) {
    if (err?.code !== 11000) console.error("[stockLedger] sale record failed:", err.message);
  }

  await alertIfLow({ station: before, fuel, stockBefore, stockAfter }).catch((err) =>
    console.error("[stockLedger] low-stock alert failed:", err.message),
  );
  return { stockBefore, stockAfter };
}

/**
 * Record a vendor's change to stock or tank size (the update itself is done
 * by the caller in one conditional write; `before` is the document as it was).
 */
async function recordVendorChange({ before, fuel, action, quantity, capacity, userId, note, orderedOn = null }) {
  const rows = [];
  const unit = FUEL_UNITS[fuel];
  const stockBefore = num(before.inventory?.[fuel]);
  let stockAfter = stockBefore;
  let leadTimeDays = null;

  if (quantity !== null && quantity !== undefined) {
    stockAfter = action === "add" ? stockBefore + quantity : quantity;
    const delta = stockAfter - stockBefore;
    if (action === "add" ? quantity > 0 : true) {
      // A delivery with its order date is a measured lead time (services/inventory/leadTime.js).
      if (action === "add" && orderedOn) {
        leadTimeDays = require("./leadTime").daysBetweenKeys(orderedOn, dateKey());
      }
      rows.push({
        station: before._id,
        fuel,
        type: action === "add" ? "delivery" : "stock_count",
        quantity: delta,
        stockAfter,
        unit,
        recordedBy: userId || null,
        note: note || null,
        ...(action === "add" && orderedOn ? { orderedOn, leadTimeDays } : {}),
      });
    }
  }
  if (capacity !== null && capacity !== undefined) {
    rows.push({
      station: before._id,
      fuel,
      type: "capacity_change",
      capacityAfter: capacity,
      stockAfter,
      unit,
      recordedBy: userId || null,
      note: note || null,
    });
  }
  if (rows.length) await InventoryMovement.insertMany(rows);

  if (stockAfter < stockBefore) {
    const station = { ...before, tankCapacity: { ...before.tankCapacity, ...(capacity ? { [fuel]: capacity } : {}) } };
    await alertIfLow({ station, fuel, stockBefore, stockAfter }).catch((err) =>
      console.error("[stockLedger] low-stock alert failed:", err.message),
    );
  }
  return { stockBefore, stockAfter, recorded: rows.length, leadTimeDays };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Compare each station's inventoryCommitted with the sum of its live,
 * reserved bookings. With `apply`, repair a difference -- but only for a
 * station with no booking request in flight (no pending attempt in the last
 * `quietMs`), because a request between its reservation and its save is
 * legitimately counted in the station but not yet visible as a booking.
 * The write is conditional on the value just read, so a concurrent
 * reservation is never overwritten.
 */
async function reconcileCommitments({ stationIds = null, apply = false, quietMs = 60_000, now = new Date() } = {}) {
  const match = { stockReserved: true, status: { $in: LIVE_STATUSES } };
  if (stationIds) match.station = { $in: stationIds.map(oid) };
  const rows = await Booking.aggregate([
    { $match: match },
    { $group: { _id: { station: "$station", fuelType: "$fuelType" }, qty: { $sum: "$quantity" } } },
  ]);
  const expected = new Map();
  for (const r of rows) {
    const key = `${r._id.station}:${normaliseFuel(r._id.fuelType)}`;
    expected.set(key, (expected.get(key) || 0) + r.qty);
  }

  const stations = await Station.find(stationIds ? { _id: { $in: stationIds.map(oid) } } : {})
    .select("_id name inventoryCommitted")
    .lean();

  const drift = [];
  for (const s of stations) {
    for (const fuel of FUEL_KEYS) {
      const recorded = num(s.inventoryCommitted?.[fuel]);
      const want = expected.get(`${s._id}:${fuel}`) || 0;
      if (recorded !== want) drift.push({ stationId: String(s._id), station: s.name, fuel, recorded, expected: want });
    }
  }

  let repaired = 0;
  let skipped = 0;
  if (apply) {
    for (const d of drift) {
      // eslint-disable-next-line no-await-in-loop
      const busy = await BookingAttempt.exists({
        station: d.stationId,
        outcome: "pending",
        createdAt: { $gte: new Date(now.getTime() - quietMs) },
      });
      if (busy) {
        skipped += 1;
        continue;
      }
      const path = `inventoryCommitted.${d.fuel}`;
      const stillRecorded = d.recorded === 0 ? { $in: [0, null] } : d.recorded;
      // eslint-disable-next-line no-await-in-loop
      const res = await Station.collection.updateOne({ _id: oid(d.stationId), [path]: stillRecorded }, { $set: { [path]: d.expected } });
      if (res.modifiedCount) repaired += 1;
      else skipped += 1;
    }
    if (drift.length) metrics.inc("stock_commitment_drift_count");
    if (repaired) console.warn(`[stockLedger] repaired ${repaired} commitment drift(s)`, drift);
  }

  return { checked: stations.length, drift, repaired, skipped };
}

// ---------------------------------------------------------------------------
// History coverage
// ---------------------------------------------------------------------------

/**
 * Record a station's starting stock as stock_count movements, so its history
 * accounts for the figure it starts from. Only fuels with stock and no
 * movement yet, so calling it again adds nothing.
 * @returns {Promise<number>} rows written
 */
async function recordOpeningStock({ station, userId = null, note = "Opening stock" }) {
  const fuels = FUEL_KEYS.filter((f) => num(station?.inventory?.[f]) > 0);
  if (!station?._id || fuels.length === 0) return 0;

  const existing = await InventoryMovement.distinct("fuel", { station: station._id, fuel: { $in: fuels } });
  const rows = fuels
    .filter((f) => !existing.includes(f))
    .map((f) => ({
      station: station._id,
      fuel: f,
      type: "stock_count",
      quantity: num(station.inventory[f]),
      stockAfter: num(station.inventory[f]),
      unit: FUEL_UNITS[f],
      recordedBy: userId || null,
      note,
    }));
  if (rows.length) await InventoryMovement.insertMany(rows);
  return rows.length;
}

/**
 * Read-only: does each fuel's latest recorded figure match the tank?
 *   NO_HISTORY  stock on the station but no movement explains it
 *   MISMATCH    the latest movement's stockAfter differs from the station
 * A mismatch means stock changed outside the ledger (a script, a direct
 * database edit). Reported, never repaired automatically: which number is
 * true needs a physical count.
 */
async function ledgerDrift({ stationIds = null } = {}) {
  const stationFilter = stationIds ? { station: { $in: stationIds.map(oid) } } : {};
  const latest = await InventoryMovement.aggregate([
    { $match: { ...stationFilter, stockAfter: { $ne: null } } },
    { $sort: { createdAt: -1, _id: -1 } },
    { $group: { _id: { station: "$station", fuel: "$fuel" }, stockAfter: { $first: "$stockAfter" } } },
  ]);
  const byKey = new Map(latest.map((r) => [`${r._id.station}:${r._id.fuel}`, r.stockAfter]));

  const stations = await Station.find(stationIds ? { _id: { $in: stationIds.map(oid) } } : {})
    .select("_id name inventory")
    .lean();

  const drift = [];
  for (const s of stations) {
    for (const fuel of FUEL_KEYS) {
      const stock = num(s.inventory?.[fuel]);
      const key = `${s._id}:${fuel}`;
      const base = { stationId: String(s._id), station: s.name, fuel, stock };
      if (!byKey.has(key)) {
        if (stock > 0) drift.push({ ...base, ledger: null, reason: "NO_HISTORY" });
      } else if (byKey.get(key) !== stock) {
        drift.push({ ...base, ledger: byKey.get(key), reason: "MISMATCH" });
      }
    }
  }
  return drift;
}

/** Available stock for one fuel on a station document: inventory minus commitments. */
function availableStock(station, fuel) {
  return num(station?.inventory?.[fuel]) - num(station?.inventoryCommitted?.[fuel]);
}

module.exports = {
  reserveStock,
  unreserveStock,
  releaseReservation,
  releaseStaleReservations,
  recordSale,
  recordVendorChange,
  alertIfLow,
  reconcileCommitments,
  recordOpeningStock,
  ledgerDrift,
  availableStock,
  LIVE_STATUSES,
};
