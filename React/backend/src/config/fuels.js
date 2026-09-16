/**
 * The one definition of FuelMart's fuel types.
 *
 *   key    petrol | diesel | cng     used in code, object paths and queries
 *                                    (station.prices.petrol, inventory.cng)
 *   label  Petrol | Diesel | CNG     what is stored on a Booking and shown
 *   unit   L | kg                    CNG is sold by weight
 *
 * Anything a client sends ("PETROL", " cNg ") goes through normaliseFuel()
 * first; an unrecognised value is null, never silently treated as petrol.
 */

const FUEL_KEYS = Object.freeze(["petrol", "diesel", "cng"]);
const FUEL_LABELS = Object.freeze({ petrol: "Petrol", diesel: "Diesel", cng: "CNG" });
const FUEL_UNITS = Object.freeze({ petrol: "L", diesel: "L", cng: "kg" });

/** Any casing/spacing of a fuel name -> its key, or null. */
function normaliseFuel(value) {
  if (value === undefined || value === null) return null;
  const f = String(value).toLowerCase().trim();
  return FUEL_KEYS.includes(f) ? f : null;
}

/** Any casing of a fuel name -> its display label, or null. */
function fuelLabel(value) {
  const key = normaliseFuel(value);
  return key ? FUEL_LABELS[key] : null;
}

/** Any casing of a fuel name -> "L" or "kg", or null. */
function fuelUnit(value) {
  const key = normaliseFuel(value);
  return key ? FUEL_UNITS[key] : null;
}

module.exports = { FUEL_KEYS, FUEL_LABELS, FUEL_UNITS, normaliseFuel, fuelLabel, fuelUnit };
