/**
 * The reward-point rules: earning rate, what a point is worth, and the limits
 * on spending them.
 *
 * Every figure lives here, and every one can be changed by an environment
 * variable without touching code -- because these are business decisions, not
 * program logic. A station chain that wants 5 points per ₹100 should not need
 * a release.
 *
 * WHY A CONFIG FILE AND NOT NUMBERS IN THE SERVICE
 *
 * Points are money-adjacent. If the earning rate is written in one file, the
 * redemption value in another and the cap in a third, they drift, and the
 * drift shows up as a customer being given a discount the business did not
 * agree to. One file, read by the ledger, the quote, the API and the tests.
 *
 * THE INVARIANT THE REST OF THE SYSTEM RELIES ON
 *
 * A point has a fixed rupee value (POINT_VALUE_RUPEES). It is never a
 * percentage, never variable by station, never negotiated at checkout. That is
 * what makes a balance meaningful to a customer ("1,200 points = ₹600") and
 * what lets the ledger be checked by addition.
 */

/** A number from the environment, or the default when it is absent or unusable. */
function num(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.warn(`[rewards] ${name}="${raw}" is not a usable value; using ${fallback}.`);
    return fallback;
  }
  return value;
}

const rewards = {
  /**
   * Points earned per ₹100 actually paid, on a booking that COMPLETES.
   *
   * Earned at completion rather than at booking, deliberately: a booking that
   * is cancelled or never turned up dispensed no fuel, and paying points for
   * it would be paying for nothing. Zero disables earning.
   */
  get EARN_PER_100() {
    return num("REWARD_POINTS_PER_100", 2, { max: 1000 });
  },

  /** What one point is worth as a discount, in rupees. */
  get POINT_VALUE_RUPEES() {
    return num("REWARD_POINT_VALUE", 0.5, { min: 0.01, max: 100 });
  },

  /**
   * The smallest redemption allowed.
   *
   * Not an obstacle: it stops the ledger filling with one-point rows worth
   * fifty paise each, and it keeps the discount line on a receipt meaningful.
   */
  get MIN_REDEEM_POINTS() {
    return Math.floor(num("REWARD_MIN_REDEEM", 50, { min: 1, max: 100000 }));
  },

  /**
   * The most of a bill points may pay for, as a percentage.
   *
   * Points can never clear a bill completely. The fuel has a cost to the
   * station, the station is paid at the pump, and a ₹0 booking is both a
   * business loss and an invitation to make bookings for free.
   */
  get MAX_DISCOUNT_PERCENT() {
    return num("REWARD_MAX_DISCOUNT_PERCENT", 20, { min: 1, max: 100 });
  },

  /**
   * Points credited to a new customer account, through the ledger.
   *
   * This used to be a `default: 100` on the User schema -- a number that
   * appeared on the dashboard without a single row anywhere saying where it
   * came from. It is a real welcome credit now: one ledger entry, visible to
   * the customer, countable by the business. Set to 0 to stop giving it.
   */
  get WELCOME_POINTS() {
    return Math.floor(num("REWARD_WELCOME_POINTS", 100, { max: 100000 }));
  },
};

/** Points -> rupees, rounded down to the paisa (never in the customer's favour by rounding). */
function rupeesFor(points) {
  const p = Math.floor(Number(points) || 0);
  if (p <= 0) return 0;
  return Math.floor(p * rewards.POINT_VALUE_RUPEES * 100) / 100;
}

/** Rupees -> the points needed to cover them, rounded UP (never a free fraction). */
function pointsFor(rupees) {
  const r = Number(rupees) || 0;
  if (r <= 0) return 0;
  return Math.ceil(r / rewards.POINT_VALUE_RUPEES);
}

/** Points earned by paying `amount` rupees. Whole points only, rounded down. */
function earnedFor(amount) {
  const paid = Number(amount);
  if (!Number.isFinite(paid) || paid <= 0) return 0;
  return Math.floor((paid / 100) * rewards.EARN_PER_100);
}

/**
 * Exported as the object itself, getters intact -- NOT spread or copied.
 *
 * `{ ...rewards }` and `Object.assign({}, rewards)` both CALL a getter and
 * store the result, which would freeze whatever the environment said the first
 * time this file was required. Every read has to go through the getter, so
 * that a test (or a deployment) changing REWARD_POINT_VALUE is seen.
 */
rewards.rupeesFor = rupeesFor;
rewards.pointsFor = pointsFor;
rewards.earnedFor = earnedFor;

module.exports = rewards;
