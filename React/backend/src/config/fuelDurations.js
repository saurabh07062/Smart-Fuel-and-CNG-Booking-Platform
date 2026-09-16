/**
 * Single source of truth for how long a fill occupies its fuel's nozzle.
 *
 * Every booking-window calculation (creating a booking, checking overlap,
 * generating availability, queue wait estimates, auto-completion) reads the
 * duration from here -- nowhere else in the codebase may hardcode a service
 * time.
 *
 * A fill's time depends on how much is dispensed:
 *
 *   seconds = setup + secondsPerUnit x quantity      (rounded to whole seconds)
 *
 *   Petrol / Diesel   6 s + 3.4 s per litre   10 L -> 40 s, 5 L -> 23 s
 *   CNG              60 s + 12 s per kg       20 kg -> 300 s
 *
 * The booked quantity is stored on the booking with the duration it produced
 * (Booking.serviceDurationSeconds), so a later change to these rates never
 * alters a booking already made. Override without a code change:
 *
 *   FUEL_SETUP_SECONDS_PETROL=6      FUEL_SECONDS_PER_UNIT_PETROL=3.4
 *   FUEL_SETUP_SECONDS_DIESEL=6      FUEL_SECONDS_PER_UNIT_DIESEL=3.4
 *   FUEL_SETUP_SECONDS_CNG=60        FUEL_SECONDS_PER_UNIT_CNG=12
 *
 * When no quantity is known (a station list estimating "a typical fill"), the
 * typical duration below is used -- Petrol/Diesel 40 s, CNG 5 min -- which the
 * rates reproduce at 10 L and 20 kg:
 *
 *   FUEL_SERVICE_SECONDS_PETROL=40   FUEL_SERVICE_SECONDS_DIESEL=40   FUEL_SERVICE_SECONDS_CNG=300
 *
 * An invalid override fails at boot, and config/booking.js refuses to start
 * if the longest possible fill is not shorter than the gap between slots.
 */

const { FUEL_KEYS, normaliseFuel } = require("./fuels");

const DEFAULT_SECONDS = { petrol: 40, diesel: 40, cng: 5 * 60 };
const DEFAULT_RATES = {
  petrol: { setupSeconds: 6, secondsPerUnit: 3.4 },
  diesel: { setupSeconds: 6, secondsPerUnit: 3.4 },
  cng: { setupSeconds: 60, secondsPerUnit: 12 },
};

function envNumber(name, fallback, { integer = false, allowZero = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  const ok = Number.isFinite(n) && (allowZero ? n >= 0 : n > 0) && (!integer || Number.isInteger(n));
  if (!ok) {
    throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} ${integer ? "whole " : ""}number, got "${raw}"`);
  }
  return n;
}

const FUEL_SERVICE_DURATIONS_SECONDS = Object.freeze(
  Object.fromEntries(
    FUEL_KEYS.map((fuel) => [fuel, envNumber(`FUEL_SERVICE_SECONDS_${fuel.toUpperCase()}`, DEFAULT_SECONDS[fuel], { integer: true })]),
  ),
);

const FUEL_SERVICE_RATES = Object.freeze(
  Object.fromEntries(
    FUEL_KEYS.map((fuel) => [
      fuel,
      Object.freeze({
        setupSeconds: envNumber(`FUEL_SETUP_SECONDS_${fuel.toUpperCase()}`, DEFAULT_RATES[fuel].setupSeconds, { allowZero: true }),
        secondsPerUnit: envNumber(`FUEL_SECONDS_PER_UNIT_${fuel.toUpperCase()}`, DEFAULT_RATES[fuel].secondsPerUnit),
      }),
    ]),
  ),
);

/**
 * @param {string} fuelType any casing/spelling normaliseFuel accepts
 * @param {number} [quantity] litres (kg for CNG). Without one, the fuel's
 *   typical duration.
 * @returns {number} whole seconds, at least 1; falls back to petrol for an
 *   unrecognised fuel rather than throwing, since callers validate the fuel
 *   type earlier in the request and this is only arithmetic.
 */
function getServiceDurationSeconds(fuelType, quantity) {
  const fuel = FUEL_SERVICE_RATES[normaliseFuel(fuelType)] ? normaliseFuel(fuelType) : "petrol";
  const qty = Number(quantity);
  if (quantity === undefined || quantity === null || !Number.isFinite(qty) || qty <= 0) {
    return FUEL_SERVICE_DURATIONS_SECONDS[fuel];
  }
  const { setupSeconds, secondsPerUnit } = FUEL_SERVICE_RATES[fuel];
  return Math.max(1, Math.round(setupSeconds + secondsPerUnit * qty));
}

module.exports = {
  FUEL_SERVICE_DURATIONS_SECONDS,
  FUEL_SERVICE_RATES,
  getServiceDurationSeconds,
};
