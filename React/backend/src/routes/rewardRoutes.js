const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const rewardService = require("../services/rewards/rewardService");
const rewards = require("../config/rewards");

/**
 * Reward points over HTTP.
 *
 *   GET  /api/v1/rewards              the customer's balance, rules and statement
 *   GET  /api/v1/rewards/quote        what may be spent on a bill of ₹x
 *   POST /api/v1/rewards/adjust       an admin correction, with a reason
 *
 * WHOSE POINTS
 *
 * Always the signed-in customer's, from the session (req.user.id) -- never a
 * user id from the query or the body. There is no endpoint for reading someone
 * else's balance, because nothing in the app needs one: the admin adjustment
 * below names a customer but reports only what it changed.
 *
 * Nothing here spends points. Spending happens as part of creating a booking
 * (services/booking/bookingCreate.js), so a discount cannot exist without the
 * booking it discounts.
 */

/** The rules, so the app states the same numbers the server enforces. */
const rulesBlock = () => ({
  earnPer100: rewards.EARN_PER_100,
  pointValue: rewards.POINT_VALUE_RUPEES,
  minRedeem: rewards.MIN_REDEEM_POINTS,
  maxDiscountPercent: rewards.MAX_DISCOUNT_PERCENT,
});

/**
 * Balance, rules and statement in one request.
 *
 * One call rather than three: the rewards screen shows all of it at once, and
 * a balance read separately from the statement that explains it can disagree
 * with it on screen.
 */
router.get("/", auth, requireRole("customer"), async (req, res) => {
  try {
    const { entries, total, balance } = await rewardService.statement(req.user.id, {
      limit: req.query.limit,
      skip: req.query.skip,
    });
    res.json({
      success: true,
      balance,
      worth: rewards.rupeesFor(balance),
      rules: rulesBlock(),
      entries,
      total,
    });
  } catch (err) {
    console.error("[rewards] statement failed:", err.message);
    res.status(500).json({ success: false, msg: "Could not load your reward points." });
  }
});

/**
 * What this customer could spend on a bill of `amount`.
 *
 * Reserves nothing: the figure is checked again when the booking is created,
 * against the balance at that moment. A stale quote costs a discount, never
 * money.
 */
router.get("/quote", auth, requireRole("customer"), async (req, res) => {
  const amount = Number(req.query.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ success: false, msg: "A positive amount is required." });
  }
  try {
    const quote = await rewardService.quote(req.user.id, amount);
    res.json({ success: true, ...quote, rules: rulesBlock() });
  } catch (err) {
    console.error("[rewards] quote failed:", err.message);
    res.status(500).json({ success: false, msg: "Could not work out your discount." });
  }
});

/**
 * An admin correction: a goodwill credit, or taking back points given in error.
 *
 * Admin only, and the reason is required -- an unexplained movement in a points
 * ledger is indistinguishable from a bug. The admin is recorded on the row.
 */
router.post("/adjust", auth, requireRole("admin"), async (req, res) => {
  const { userId, points, note } = req.body || {};
  if (!mongoose.isValidObjectId(userId)) {
    return res.status(400).json({ success: false, msg: "A valid customer id is required." });
  }
  try {
    const result = await rewardService.adjust({ userId, points, actor: req.user.id, note });
    res.json({ success: true, balance: result.balance, entry: result.entry });
  } catch (err) {
    if (err instanceof rewardService.RewardError) {
      return res.status(err.status).json({ success: false, reason: err.reason, msg: err.message });
    }
    console.error("[rewards] adjustment failed:", err.message);
    res.status(500).json({ success: false, msg: "Could not adjust the points." });
  }
});

module.exports = router;
