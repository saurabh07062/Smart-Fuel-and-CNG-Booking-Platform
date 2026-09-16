/**
 * Fuel inventory classification by percentage of the station's real tank
 * capacity.
 *
 *   percent = current stock / tank capacity x 100
 *
 *   stock <= 0               out_of_stock
 *   percent <  CRITICAL (10) critical
 *   percent <  LOW (25)      low
 *   otherwise                normal
 *   capacity not recorded    capacity_unset  (percent is null)
 *
 * Capacity comes from station.tankCapacity, set by the vendor. There is no
 * assumed default: a percentage against a made-up tank size would be a
 * made-up percentage. Until a vendor records the capacity, the only thing
 * that can honestly be said is whether the tank is empty.
 *
 * Thresholds are configurable: INVENTORY_CRITICAL_PERCENT, INVENTORY_LOW_PERCENT.
 */

const { FUEL_KEYS, FUEL_UNITS, normaliseFuel } = require("../../config/fuels");

function envPercent(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 100) {
    throw new Error(`${name} must be a percentage between 0 and 100, got "${raw}"`);
  }
  return n;
}

const THRESHOLDS = Object.freeze({
  criticalBelowPercent: envPercent("INVENTORY_CRITICAL_PERCENT", 10),
  lowBelowPercent: envPercent("INVENTORY_LOW_PERCENT", 25),
});
if (THRESHOLDS.criticalBelowPercent >= THRESHOLDS.lowBelowPercent) {
  throw new Error("INVENTORY_CRITICAL_PERCENT must be lower than INVENTORY_LOW_PERCENT");
}

const TIERS = {
  OUT: "out_of_stock",
  CRITICAL: "critical",
  LOW: "low",
  NORMAL: "normal",
  UNKNOWN: "capacity_unset",
};

const TIER_LABELS = {
  [TIERS.OUT]: "Out of Stock",
  [TIERS.CRITICAL]: "Critical",
  [TIERS.LOW]: "Low Stock",
  [TIERS.NORMAL]: "Available",
  [TIERS.UNKNOWN]: "Capacity not set",
};

/** Tiers a vendor should act on. */
const ALERT_TIERS = [TIERS.OUT, TIERS.CRITICAL, TIERS.LOW];

/**
 * @param {number} current   stock in the fuel's unit (L or kg)
 * @param {number|null} capacity  the tank's real capacity, or null if unknown
 * @returns {{tier:string, label:string, percent:number|null}}
 */
function classifyStock(current, capacity) {
  const cap = Number.isFinite(capacity) && capacity > 0 ? capacity : null;
  const stock = Number.isFinite(current) ? Math.max(0, current) : 0;
  const percent = cap ? Math.min(100, Math.round((stock / cap) * 100)) : null;

  let tier;
  if (stock <= 0) tier = TIERS.OUT;
  else if (percent === null) tier = TIERS.UNKNOWN;
  else if (percent < THRESHOLDS.criticalBelowPercent) tier = TIERS.CRITICAL;
  else if (percent < THRESHOLDS.lowBelowPercent) tier = TIERS.LOW;
  else tier = TIERS.NORMAL;

  return { tier, label: TIER_LABELS[tier], percent };
}

/**
 * Classify every fuel a station sells and tracks stock for.
 * @param {object} station  Station document or plain object
 * @returns {Record<string, {current:number, capacity:number|null, unit:string,
 *            tier:string, label:string, percent:number|null}>}
 */
function classifyStationInventory(station) {
  const inventory = station?.inventory || {};
  const capacities = station?.tankCapacity || {};
  const sold = (station?.fuelTypes || []).map(normaliseFuel).filter(Boolean);
  const result = {};

  for (const fuel of FUEL_KEYS) {
    if (sold.length && !sold.includes(fuel)) continue; // station doesn't sell it
    const current = Number(inventory[fuel]);
    if (!Number.isFinite(current)) continue; // not tracked
    const capacity = Number.isFinite(capacities[fuel]) && capacities[fuel] > 0 ? capacities[fuel] : null;
    // Promised to live bookings (services/inventory/stockLedger.js); available is what
    // can still be booked.
    const committed = Number(station?.inventoryCommitted?.[fuel]) || 0;
    result[fuel] = {
      current,
      capacity,
      unit: FUEL_UNITS[fuel],
      committed,
      available: Math.max(0, current - committed),
      ...classifyStock(current, capacity),
    };
  }
  return result;
}

module.exports = {
  TIERS,
  TIER_LABELS,
  ALERT_TIERS,
  THRESHOLDS,
  classifyStock,
  classifyStationInventory,
};
