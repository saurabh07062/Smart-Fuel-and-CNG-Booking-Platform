/**
 * What FuelMart earns on a booking, and when it is collected.
 *
 * HOW THE MONEY ACTUALLY MOVES
 *
 * Fuel is paid for at the pump (config/payments.js): the customer hands cash
 * or UPI to the attendant, so the VENDOR holds the whole amount from the
 * moment the fill completes. There is no point "paying the vendor out" -- they
 * were paid first, by the customer, directly. What is outstanding is the other
 * direction: the vendor owes FuelMart its commission on that sale.
 *
 * So a commission is accrued per booking as PENDING, it accumulates through
 * the day, and at the configured settlement time the day's total is moved to
 * the admin account in one transfer per vendor. That is the flow this file
 * configures.
 *
 * WHAT THE COMMISSION IS TAKEN ON
 *
 *   convenience fee   kept in full. It is FuelMart's own charge for the
 *                     booking, not the dealer's for the fuel.
 *   fuel value        a percentage (COMMISSION_PERCENT), which is the platform
 *                     fee the dealer agreed to.
 *
 * Both figures come from the booking's own stored row, never from a rate card
 * written here -- see services/commission/commissionService.js computeFor.
 *
 * Every value is an environment variable, because every one of them is a
 * commercial decision that will change without the code changing.
 */

const { parseClock } = require("./businessTime");

function num(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.warn(`[commission] ${name}="${raw}" is not a usable value; using ${fallback}.`);
    return fallback;
  }
  return value;
}

const commission = {
  /** Percentage of the fuel value (price x quantity) taken as commission. */
  get PERCENT() {
    return num("COMMISSION_PERCENT", 2, { max: 100 });
  },

  /**
   * Whether the booking's convenience fee is FuelMart's in full.
   *
   * It is, by default: the fee is charged for the booking service, which is
   * FuelMart's, not for the fuel. Set COMMISSION_KEEPS_FEE=false where a
   * dealer has negotiated to keep it.
   */
  get KEEPS_CONVENIENCE_FEE() {
    return String(process.env.COMMISSION_KEEPS_FEE ?? "true").toLowerCase() !== "false";
  },

  /**
   * When the day's commission is settled, as "HH:MM" in India time.
   *
   * After the last bookable slot by default, so a day's trading is closed
   * before its money is moved.
   */
  get SETTLEMENT_TIME() {
    const raw = String(process.env.COMMISSION_SETTLEMENT_TIME || "23:30").trim();
    const parsed = parseClock(raw);
    if (!parsed) {
      console.warn(`[commission] COMMISSION_SETTLEMENT_TIME="${raw}" is not HH:MM; using 23:30.`);
      return { hours: 23, minutes: 30, text: "23:30" };
    }
    return { ...parsed, text: raw };
  },

  /**
   * A settlement below this is carried forward rather than transferred.
   *
   * A ₹3 bank transfer costs more to make than it is worth; the entries stay
   * pending and join the next day's settlement. 0 settles any amount.
   */
  get MIN_SETTLEMENT_AMOUNT() {
    return num("COMMISSION_MIN_SETTLEMENT", 100, { max: 100000 });
  },

  /**
   * How the transfer is actually made.
   *
   *   "manual"   FuelMart has no payout rail configured, which is the truth
   *              today (online payments are off entirely). The settlement is
   *              raised and left AWAITING CONFIRMATION; an admin records the
   *              money as received once it genuinely has been, and only then
   *              is anything marked settled.
   *   "gateway"  a payout API. Not implemented: selecting it makes the
   *              settlement fail loudly rather than quietly pretend.
   *
   * The rule behind both: nothing is ever marked transferred because a
   * schedule fired. It is marked transferred when the transfer is confirmed.
   */
  get PAYOUT_MODE() {
    const mode = String(process.env.COMMISSION_PAYOUT_MODE || "manual").trim().toLowerCase();
    return mode === "gateway" ? "gateway" : "manual";
  },

  /** Whether the end-of-day job runs at all (off disables accrual settlement only). */
  get SETTLEMENT_ENABLED() {
    return String(process.env.COMMISSION_SETTLEMENT_ENABLED ?? "true").toLowerCase() !== "false";
  },
};

/** Rupees, to the paisa. */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Exported as the object itself, getters intact.
 *
 * Spreading it (`{ ...commission }`) would CALL every getter once, at require
 * time, and store the answers -- freezing whatever the environment said when
 * this file was first loaded. Every read has to go through the getter.
 */
commission.round2 = round2;

module.exports = commission;
