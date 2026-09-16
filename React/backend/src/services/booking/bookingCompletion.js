/**
 * Completing a booking -- the one place it happens.
 *
 * Fuel leaves the tank when a booking completes, so completion and the stock
 * change belong together. There are several ways to complete a booking
 * (vendor "completed", PIN verification, the auto-complete sweep, admin
 * status change, mark-served) and all of them come through here.
 *
 * Exactly-once: the booking moves to "completed", is stamped
 * `inventoryDeductedAt` and has its stock reservation cleared in a single
 * conditional update. A second caller racing the first (a vendor click during
 * the sweep, a double tap) matches nothing and changes no stock.
 *
 * The stock side (services/inventory/stockLedger.js recordSale) takes the quantity off
 * the tank, floored at zero, and off the station's committed stock if the
 * booking held a reservation; records the sale; and alerts the vendor if the
 * fuel just dropped into a low tier.
 *
 * Limitation: the booking update and the station update are two writes. The
 * deployment has no MongoDB replica set, so they cannot share a transaction;
 * if the process dies between them the booking is completed but the stock is
 * not reduced. Counted and logged so it is visible.
 */

const Booking = require("../../models/Booking");
const metrics = require("../core/metrics");

const COMPLETABLE_STATUSES = ["upcoming", "serving"];

/**
 * Mark a booking completed and take its fuel out of stock, once.
 *
 * @param {object} p
 * @param {string} p.bookingId
 * @param {string[]} [p.fromStatuses]  statuses it may complete from
 * @param {object} [p.set]  extra fields to write with the completion
 *   (payment collection, collectedBy, ...)
 * @returns {Promise<import("mongoose").Document|null>} the completed booking,
 *   or null if it was not in a completable state (already completed, cancelled,
 *   not found, or another caller got there first)
 */
async function completeBooking({ bookingId, fromStatuses = COMPLETABLE_STATUSES, set = {} }) {
  const now = new Date();
  const before = await Booking.findOneAndUpdate(
    { _id: bookingId, status: { $in: fromStatuses }, inventoryDeductedAt: null },
    { $set: { completionTime: now, ...set, status: "completed", inventoryDeductedAt: now, stockReserved: false } },
    { new: false },
  ).lean();
  if (!before) return null;

  metrics.inc("booking_completed_count");
  const completed = await Booking.findById(before._id);
  try {
    await require("../inventory/stockLedger").recordSale(completed, { releaseCommitment: before.stockReserved === true });
  } catch (err) {
    metrics.inc("inventory_deduction_error_count");
    console.error(`[completion] booking ${before._id} completed but stock was not deducted:`, err.message);
  }
  return completed;
}

module.exports = { completeBooking, COMPLETABLE_STATUSES };
