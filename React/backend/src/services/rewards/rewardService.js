/**
 * Reward points: earning them, spending them, and putting them back.
 *
 * The one place points move. Every caller -- booking creation, booking
 * completion, cancellation, the API, the admin panel -- comes through here, for
 * the same reason every stock change goes through the stock ledger: a balance
 * that is written in two places eventually disagrees with itself.
 *
 * THE RULE THAT MAKES THIS SAFE
 *
 * A balance is never computed and then written. Every movement is a single
 * conditional `$inc` on the user document:
 *
 *     spending:  { _id: user, rewards: { $gte: points } }  ->  $inc -points
 *     crediting: { _id: user }                             ->  $inc +points
 *
 * Two requests spending the same points race on the database, and exactly one
 * finds the balance sufficient. There is no read-modify-write window to lose,
 * and `min: 0` on the schema is the floor under it, not the check.
 *
 * EXACTLY ONCE
 *
 * The movement is written to the user first and the ledger row second. If the
 * ledger insert collides (duplicate key -- this booking already earned, this
 * cancellation already refunded) the balance change is UNDONE immediately, so
 * a double call cannot pay twice. The unique indexes in models/RewardLedger.js
 * are what decides; this code only reacts to them.
 *
 * WHAT IS NOT HERE
 *
 * Money. Points are a discount on a bill that is still paid at the pump; they
 * are not a wallet, not withdrawable, and never leave this collection.
 */

const mongoose = require("mongoose");
const User = require("../../models/User");
const RewardLedger = require("../../models/RewardLedger");
const rewards = require("../../config/rewards");
const metrics = require("../core/metrics");

const DUPLICATE = 11000;
const round2 = (n) => Math.round(n * 100) / 100;

/** The error every public function throws for a refusal the caller must report. */
class RewardError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.name = "RewardError";
    this.status = status;
    this.reason = reason;
  }
}

/* ────────────────────────── reading ────────────────────────── */

/** The customer's balance. The user document is the balance; the ledger explains it. */
async function balanceOf(userId) {
  const user = await User.findById(userId).select("rewards").lean();
  return Math.max(0, Number(user?.rewards) || 0);
}

/**
 * The statement: what moved, when, and why.
 *
 * @returns {Promise<{entries: object[], balance: number, total: number}>}
 */
async function statement(userId, { limit = 25, skip = 0 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const from = Math.max(Number(skip) || 0, 0);

  const [entries, total, balance] = await Promise.all([
    RewardLedger.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip(from)
      .limit(cap)
      .populate("booking", "orderId fuelType quantity amount bookingDate timeSlot")
      .lean(),
    RewardLedger.countDocuments({ user: userId }),
    balanceOf(userId),
  ]);

  return { entries: entries.map(publicEntry), total, balance };
}

/** One ledger row as the customer's app shows it. */
function publicEntry(row) {
  return {
    id: String(row._id),
    type: row.type,
    points: row.points,
    balanceAfter: row.balanceAfter,
    rupees: row.rupees || 0,
    note: row.note || null,
    at: row.createdAt,
    booking: row.booking
      ? {
          id: String(row.booking._id),
          orderId: row.booking.orderId || null,
          fuelType: row.booking.fuelType,
          quantity: row.booking.quantity,
          amount: row.booking.amount,
          bookingDate: row.booking.bookingDate,
          timeSlot: row.booking.timeSlot || null,
        }
      : null,
  };
}

/* ────────────────────────── quoting ────────────────────────── */

/**
 * What this customer may spend on a bill of `amount`, and what it is worth.
 *
 * Pure arithmetic on a balance; it reserves nothing and promises nothing. The
 * figure is checked again, against the balance at that moment, when the booking
 * is actually created -- so a quote going stale costs the customer a discount,
 * never the business money.
 *
 * @returns {{balance:number, maxPoints:number, maxDiscount:number, minPoints:number,
 *            pointValue:number, maxPercent:number, eligible:boolean, reason:string|null}}
 */
function quoteFor({ balance, amount }) {
  const bal = Math.max(0, Math.floor(Number(balance) || 0));
  const bill = Number(amount) || 0;
  const minPoints = rewards.MIN_REDEEM_POINTS;

  // The cap, in rupees, then in points: points may pay for part of a bill, never
  // all of it (config/rewards.js explains why).
  const discountCeiling = round2((bill * rewards.MAX_DISCOUNT_PERCENT) / 100);
  const pointsCeiling = Math.floor(discountCeiling / rewards.POINT_VALUE_RUPEES);
  const maxPoints = Math.max(0, Math.min(bal, pointsCeiling));

  let reason = null;
  if (bal < minPoints) reason = "BALANCE_BELOW_MINIMUM";
  else if (maxPoints < minPoints) reason = "BILL_TOO_SMALL";

  return {
    balance: bal,
    maxPoints: reason ? 0 : maxPoints,
    maxDiscount: reason ? 0 : rewards.rupeesFor(maxPoints),
    minPoints,
    pointValue: rewards.POINT_VALUE_RUPEES,
    maxPercent: rewards.MAX_DISCOUNT_PERCENT,
    eligible: !reason,
    reason,
  };
}

/** The quote for a user, read from their live balance. */
async function quote(userId, amount) {
  return quoteFor({ balance: await balanceOf(userId), amount });
}

/**
 * Check a requested redemption against a bill BEFORE anything is written.
 *
 * Called by booking creation, where the answer has to be a refusal the
 * customer can act on ("you have 40 points, the minimum is 50") rather than a
 * silently ignored field.
 *
 * @returns {Promise<{points:number, discount:number}|null>} null when nothing
 *   was asked for.
 * @throws {RewardError} 400/409 when what was asked for cannot be given.
 */
async function validateRedemption({ userId, amount, points }) {
  if (points === undefined || points === null || points === "" || Number(points) === 0) return null;

  const want = Number(points);
  if (!Number.isInteger(want) || want < 0) {
    throw new RewardError(400, "INVALID_POINTS", "redeemPoints must be a whole number of points.");
  }

  const q = await quote(userId, amount);
  if (want > q.balance) {
    throw new RewardError(
      409,
      "INSUFFICIENT_POINTS",
      `You have ${q.balance} reward point${q.balance === 1 ? "" : "s"}; ${want} were requested.`,
    );
  }
  if (want < q.minPoints) {
    throw new RewardError(400, "BELOW_MINIMUM_REDEEM", `The smallest redemption is ${q.minPoints} points.`);
  }
  if (!q.eligible) {
    throw new RewardError(
      400,
      q.reason,
      q.reason === "BALANCE_BELOW_MINIMUM"
        ? `You need at least ${q.minPoints} points to use them.`
        : "This booking is too small to use reward points on.",
    );
  }
  if (want > q.maxPoints) {
    throw new RewardError(
      400,
      "ABOVE_MAX_DISCOUNT",
      `Points may cover up to ${q.maxPercent}% of a bill — at most ${q.maxPoints} points here.`,
    );
  }

  return { points: want, discount: rewards.rupeesFor(want) };
}

/* ────────────────────────── moving points ────────────────────────── */

/**
 * The single primitive: change the balance and record why, or do neither.
 *
 * @param {object} p
 * @param {string} p.userId
 * @param {number} p.points  signed; negative spends and requires the balance
 * @param {string} p.type    a models/RewardLedger.js type
 * @returns {Promise<{entry: object, balance: number}|null>} null when the
 *   balance was insufficient (a spend) or the movement had already been
 *   recorded (a duplicate) -- both are ordinary outcomes, not errors.
 */
async function move({ userId, points, type, booking = null, fleetGroup = null, actor = null, rupees = 0, note = null }) {
  const delta = Math.trunc(Number(points) || 0);
  if (delta === 0) return null;

  // Spending requires the points to be there AT THE MOMENT OF THE WRITE.
  const guard = delta < 0 ? { _id: userId, rewards: { $gte: -delta } } : { _id: userId };
  const user = await User.findOneAndUpdate(guard, { $inc: { rewards: delta } }, { new: true }).select("rewards").lean();
  if (!user) {
    metrics.inc("reward_insufficient_count");
    return null;
  }

  try {
    const entry = await RewardLedger.create({
      user: userId,
      type,
      points: delta,
      balanceAfter: Math.max(0, Number(user.rewards) || 0),
      rupees: round2(Number(rupees) || 0),
      booking,
      fleetGroup,
      actor,
      note,
    });
    metrics.inc(delta > 0 ? "reward_credit_count" : "reward_debit_count");
    return { entry: publicEntry(entry.toObject()), balance: Math.max(0, Number(user.rewards) || 0) };
  } catch (err) {
    // The ledger refused it: this movement is already recorded (a double click,
    // two completion paths racing). Put the balance back exactly as it was --
    // the ledger, not this code, is the record of what has happened.
    await User.updateOne({ _id: userId }, { $inc: { rewards: -delta } }).catch((undoErr) =>
      console.error(`[rewards] could not undo a ${type} of ${delta} for user ${userId}:`, undoErr.message),
    );
    if (err?.code === DUPLICATE) {
      metrics.inc("reward_duplicate_count");
      return null;
    }
    throw err;
  }
}

/**
 * Spend points as a discount on a booking.
 *
 * Called by booking creation AFTER the booking document exists, so the ledger
 * row can name it: a discount with no booking attached cannot be refunded when
 * that booking is cancelled.
 *
 * @throws {RewardError} 409 when the balance moved between the check and here.
 */
async function redeem({ userId, points, booking, fleetGroup = null, note = null }) {
  const spend = Math.floor(Number(points) || 0);
  if (spend <= 0) return null;

  const result = await move({
    userId,
    points: -spend,
    type: "redeemed",
    booking,
    fleetGroup,
    rupees: rewards.rupeesFor(spend),
    note: note || `Discount on booking`,
  });

  if (!result) {
    throw new RewardError(409, "INSUFFICIENT_POINTS", "Your reward balance changed; please try again.");
  }
  return result;
}

/**
 * Pay out the points a completed booking earned.
 *
 * Called from services/booking/bookingCompletion.js, where fuel has actually
 * been dispensed. Earned on what the customer PAYS (the amount after any
 * points discount): points do not earn points.
 *
 * Never throws -- a booking must not fail to complete because a reward row
 * could not be written. Returns null when nothing was earned or it was already
 * paid.
 */
async function earnForBooking(booking) {
  try {
    if (!booking?.user || !booking?._id) return null;
    const payable = Number(booking.payableAmount ?? booking.amount);
    const points = rewards.earnedFor(payable);
    if (points <= 0) return null;

    return await move({
      userId: booking.user,
      points,
      type: "earned",
      booking: booking._id,
      fleetGroup: booking.fleetGroup || null,
      note: `Earned on ${booking.fuelType} booking${booking.orderId ? ` ${booking.orderId}` : ""}`,
    });
  } catch (err) {
    metrics.inc("reward_earn_error_count");
    console.error(`[rewards] booking ${booking?._id} completed but earned no points:`, err.message);
    return null;
  }
}

/**
 * Give back the points a booking's discount spent, because the booking is no
 * longer happening (cancelled, no-show, expired).
 *
 * The customer did not get the discount -- the bill was never paid -- so the
 * points are theirs again. Idempotent through the ledger: pressing cancel
 * twice returns them once.
 *
 * Never throws: a cancellation must not fail over a points row.
 */
async function reverseRedemption(booking) {
  try {
    const spent = Math.floor(Number(booking?.rewardPointsUsed) || 0);
    if (!booking?.user || !booking?._id || spent <= 0) return null;

    return await move({
      userId: booking.user,
      points: spent,
      type: "redeem_reversed",
      booking: booking._id,
      fleetGroup: booking.fleetGroup || null,
      rupees: Number(booking.rewardDiscount) || rewards.rupeesFor(spent),
      note: "Returned — booking did not go ahead",
    });
  } catch (err) {
    metrics.inc("reward_reversal_error_count");
    console.error(`[rewards] could not return the points on booking ${booking?._id}:`, err.message);
    return null;
  }
}

/**
 * Take back the points a completed booking earned, because it was refunded.
 *
 * The balance may already have been spent, which is why this is the one
 * movement allowed to come up short: it takes what is there and records what
 * it took, rather than forcing a negative balance. The shortfall is logged --
 * it is a business question, not a program error.
 */
async function reverseEarning(booking) {
  try {
    if (!booking?.user || !booking?._id) return null;
    const earned = await RewardLedger.findOne({ booking: booking._id, type: "earned" }).lean();
    const points = earned ? Math.abs(earned.points) : 0;
    if (points <= 0) return null;

    const balance = await balanceOf(booking.user);
    const take = Math.min(points, balance);
    if (take <= 0) {
      console.warn(`[rewards] booking ${booking._id} was refunded but its ${points} points are already spent.`);
      return null;
    }
    if (take < points) {
      console.warn(`[rewards] booking ${booking._id} refunded: taking ${take} of ${points} points (rest already spent).`);
    }

    return await move({
      userId: booking.user,
      points: -take,
      type: "earn_reversed",
      booking: booking._id,
      fleetGroup: booking.fleetGroup || null,
      note: "Reversed — booking refunded",
    });
  } catch (err) {
    metrics.inc("reward_reversal_error_count");
    console.error(`[rewards] could not reverse the points on booking ${booking?._id}:`, err.message);
    return null;
  }
}

/**
 * The welcome credit for a new account.
 *
 * Deliberately a ledger row rather than a schema default: a balance a customer
 * can see has to have an entry explaining it, and "we gave you 100 points when
 * you joined" is that entry. Once per account, by unique index.
 */
async function creditWelcome(userId) {
  try {
    const points = rewards.WELCOME_POINTS;
    if (points <= 0) return null;
    return await move({ userId, points, type: "welcome", note: "Welcome to FuelMart" });
  } catch (err) {
    // Signing up must never fail over this.
    console.error(`[rewards] welcome credit failed for user ${userId}:`, err.message);
    return null;
  }
}

/**
 * An admin correction, in either direction, with a reason that is required.
 *
 * Not idempotent, on purpose: an admin granting 50 points twice means to grant
 * 100. Each row stands on its own and names the admin who wrote it.
 */
async function adjust({ userId, points, actor, note }) {
  const delta = Math.trunc(Number(points) || 0);
  if (!mongoose.isValidObjectId(userId)) throw new RewardError(400, "INVALID_USER", "A valid customer id is required.");
  if (delta === 0) throw new RewardError(400, "INVALID_POINTS", "An adjustment must add or remove points.");
  const reason = String(note || "").trim();
  if (reason.length < 3) throw new RewardError(400, "REASON_REQUIRED", "Say why this adjustment is being made.");

  const result = await move({ userId, points: delta, type: "adjustment", actor, note: reason.slice(0, 200) });
  if (!result) {
    throw new RewardError(409, "INSUFFICIENT_POINTS", "That customer does not have enough points to remove.");
  }
  return result;
}

module.exports = {
  RewardError,
  balanceOf,
  statement,
  quote,
  quoteFor,
  validateRedemption,
  redeem,
  earnForBooking,
  reverseRedemption,
  reverseEarning,
  creditWelcome,
  adjust,
  publicEntry,
};
