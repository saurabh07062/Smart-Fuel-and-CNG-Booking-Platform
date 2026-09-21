/**
 * The fuels a vendor sells, chosen at registration ("Provided Products").
 *
 * Kept on the vendor as `vendorFuelTypes` (fuel keys: petrol, diesel, cng) and
 * used by the vendor panel: the Add Station form asks prices only for these,
 * and a new station sells only these. The registration form also offers "EV
 * Charging", which is not a bookable fuel here and is not stored.
 */

const { FUEL_KEYS, FUEL_LABELS, normaliseFuel } = require("../../config/fuels");

const REQUIRED_MSG = "Select at least one fuel your station sells: Petrol, Diesel or CNG.";

/** "petrol,Diesel" | ["petrol","cng"] | JSON text -> unique fuel keys, in the standard order. */
function parseFuelList(raw) {
  let items = raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      items = Array.isArray(parsed) ? parsed : raw.split(",");
    } catch {
      items = raw.split(",");
    }
  }
  if (!Array.isArray(items)) return [];
  const chosen = new Set(items.map(normaliseFuel).filter(Boolean));
  return FUEL_KEYS.filter((k) => chosen.has(k));
}

/** Registration/profile input -> { fuels } or { error } when no supported fuel was chosen. */
function parseVendorFuels(raw) {
  const fuels = parseFuelList(raw);
  return fuels.length ? { fuels } : { error: REQUIRED_MSG };
}

/**
 * The fuels a vendor's new station may sell. Vendors registered before this
 * was recorded have no list: they keep every fuel, as before.
 */
function vendorFuelsOf(user) {
  const fuels = parseFuelList(user?.vendorFuelTypes);
  return fuels.length ? fuels : [...FUEL_KEYS];
}

const labelsOf = (fuels) => fuels.map((f) => FUEL_LABELS[f]);

module.exports = { parseFuelList, parseVendorFuels, vendorFuelsOf, labelsOf, REQUIRED_MSG };
