const mongoose = require("mongoose");

/**
 * One movement of reward points, and why it happened.
 *
 *   welcome          points given when the account was created
 *   earned           a booking completed and fuel was dispensed
 *   redeemed         points were spent as a discount on a booking
 *   redeem_reversed  a booking with a discount was cancelled; the points came back
 *   earn_reversed    a completed booking was refunded; the points it earned were taken back
 *   adjustment       an admin correction, with a reason
 *
 * `points` is SIGNED: a credit is positive, a spend is negative. The customer's
 * balance (User.rewards) is the sum of this collection for that user, and
 * `balanceAfter` records what the balance was immediately after the row was
 * written -- so the statement reads like a bank statement, and a drift between
 * the ledger and the balance is visible rather than silent.
 *
 * WHY A LEDGER AND NOT JUST A NUMBER
 *
 * A number on the user document can only answer "how many?". It cannot answer
 * "where did these come from?", "was this discount actually given?" or "has
 * this booking already paid out?" -- and the last of those is the question that
 * decides whether a double click pays twice. The unique indexes at the bottom
 * answer it with the database rather than with careful code.
 *
 * Rows are never updated and never deleted. A mistake is corrected by another
 * row (type "adjustment"), exactly as in services/inventory/stockLedger.js.
 */
const RewardLedgerSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    type: {
      type: String,
      enum: ["welcome", "earned", "redeemed", "redeem_reversed", "earn_reversed", "adjustment"],
      required: true,
    },

    /** Signed whole points: credits positive, spends negative. Never zero. */
    points: {
      type: Number,
      required: true,
      validate: {
        validator: (v) => Number.isInteger(v) && v !== 0,
        message: "points must be a non-zero whole number",
      },
    },

    /** The balance right after this row. A ledger that can be checked by addition. */
    balanceAfter: { type: Number, required: true, min: 0 },

    /**
     * What the points were worth in rupees at the time.
     *
     * Stored, not recomputed: the rate (config/rewards.js POINT_VALUE_RUPEES)
     * can change, and a receipt must keep saying the discount it actually gave.
     */
    rupees: { type: Number, default: 0, min: 0 },

    /** The booking that caused this. Null for a welcome credit or an admin adjustment. */
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null },
    /** Set when the booking was part of a fleet, so a group can be read as one. */
    fleetGroup: { type: mongoose.Schema.Types.ObjectId, ref: "FleetBooking", default: null },

    /** Who made it happen, when it was not the customer themselves (an admin adjustment). */
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    /** Shown to the customer in their statement. */
    note: { type: String, trim: true, maxlength: 200, default: null },
  },
  { timestamps: true },
);

/** The customer's own statement, newest first. */
RewardLedgerSchema.index({ user: 1, createdAt: -1 });

/**
 * Exactly once per booking, per kind of movement.
 *
 * These four indexes are the whole anti-double-pay mechanism:
 *
 *   - a booking earns once, however many completion paths race (the vendor's
 *     "completed" click, PIN verification, the no-show sweep)
 *   - a booking's discount is recorded once
 *   - a cancellation returns those points once, however many times the
 *     cancel button is pressed
 *   - a refund claws back once
 *
 * A second writer gets duplicate-key error 11000, which the service treats as
 * "already done" rather than as a failure. Partial, so the many rows with no
 * booking (welcome credits, adjustments) do not collide with each other.
 */
for (const type of ["earned", "redeemed", "redeem_reversed", "earn_reversed"]) {
  RewardLedgerSchema.index(
    { booking: 1, type: 1 },
    {
      unique: true,
      name: `uniq_reward_${type}_per_booking`,
      partialFilterExpression: { type, booking: { $type: "objectId" } },
    },
  );
}

/** One welcome credit per account, forever. */
RewardLedgerSchema.index(
  { user: 1, type: 1 },
  { unique: true, name: "uniq_reward_welcome_per_user", partialFilterExpression: { type: "welcome" } },
);

module.exports = mongoose.model("RewardLedger", RewardLedgerSchema);
