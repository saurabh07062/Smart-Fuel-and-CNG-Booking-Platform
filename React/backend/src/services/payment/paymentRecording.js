/**
 * Recording Razorpay payment outcomes on a booking -- the one implementation
 * shared by Checkout's verify call (controllers/paymentController.js) and the
 * server-to-server webhook (controllers/webhookController.js), so whichever
 * arrives first decides, and the second is a no-op.
 *
 * Every write is conditional:
 *   - only a live booking (PAYABLE_STATUSES) becomes paid; a cancel or expiry
 *     racing the payment wins, and the payment is logged for a refund
 *   - a paid booking is never touched again, so an out-of-order
 *     payment.failed cannot undo a capture
 */

const Booking = require("../../models/Booking");

/** A booking that can still take a payment: create-order, verify and the webhook agree on this. */
const PAYABLE_STATUSES = Object.freeze(["upcoming", "serving"]);

/**
 * A captured payment for `booking`'s Razorpay order.
 *
 * @param {object}  args
 * @param {object}  args.booking      the booking document whose razorpayOrderId is `orderId`
 * @param {string}  args.orderId
 * @param {string}  args.paymentId
 * @param {number} [args.amountPaise] captured amount, when the caller knows it (webhook)
 * @param {string}  args.source       "checkout" | "webhook", for the logs
 * @returns {Promise<{outcome: "paid"|"already_paid"|"not_payable"|"amount_mismatch", status: string|null}>}
 */
async function recordCapturedPayment({ booking, orderId, paymentId, amountPaise, source }) {
  if (booking.paymentStatus === "paid") return { outcome: "already_paid", status: booking.status };

  if (amountPaise !== undefined) {
    const expected = Math.round(Number(booking.amount) * 100);
    if (Number(amountPaise) !== expected) {
      console.warn(
        `[payment] AMOUNT MISMATCH (${source}): payment ${paymentId} captured ${amountPaise} paise ` +
          `for booking ${booking._id}, which costs ${expected}; not marked paid`,
      );
      return { outcome: "amount_mismatch", status: booking.status };
    }
  }

  const marked = await Booking.updateOne(
    {
      _id: booking._id,
      razorpayOrderId: orderId,
      paymentStatus: { $ne: "paid" },
      status: { $in: PAYABLE_STATUSES },
    },
    { $set: { paymentStatus: "paid", razorpayPaymentId: paymentId }, $unset: { paymentFailureReason: 1 } },
  );
  if (marked.modifiedCount) return { outcome: "paid", status: booking.status };

  const now = await Booking.findById(booking._id).select("status paymentStatus").lean();
  if (now?.paymentStatus === "paid") return { outcome: "already_paid", status: now.status };

  // Genuine money for a booking that is no longer live. Keep the payment id on
  // the booking (if none is recorded yet) so a refund can be issued against it.
  await Booking.updateOne(
    { _id: booking._id, razorpayOrderId: orderId, paymentStatus: { $ne: "paid" }, razorpayPaymentId: { $exists: false } },
    { $set: { razorpayPaymentId: paymentId } },
  );
  console.warn(
    `[payment] REFUND NEEDED (${source}): payment ${paymentId} (order ${orderId}) ` +
      `arrived for booking ${booking._id}, which is ${now?.status || "gone"}`,
  );
  return { outcome: "not_payable", status: now?.status || null };
}

/**
 * A failed payment attempt for a Razorpay order. Only an unpaid online
 * booking is marked failed; the customer may still retry and pay.
 *
 * @returns {Promise<{outcome: "failed"|"ignored", bookingId: string|null}>}
 */
async function recordFailedPayment({ orderId, reason }) {
  const booking = await Booking.findOneAndUpdate(
    { razorpayOrderId: orderId, paymentStatus: { $in: ["pending", "failed"] } },
    { $set: { paymentStatus: "failed", paymentFailureReason: String(reason || "Payment failed").slice(0, 300) } },
    { new: true, projection: { _id: 1 } },
  ).lean();
  return { outcome: booking ? "failed" : "ignored", bookingId: booking ? String(booking._id) : null };
}

/**
 * The attendant received the money for a pay-at-the-pump booking that is being
 * fuelled or has finished. One conditional write, so a double click, a second
 * attendant or a replayed request records it once.
 *
 * @returns {Promise<{outcome: "collected"|"already_paid"|"not_found"|"not_pay_at_station"|"not_collectable", booking?: object}>}
 */
async function recordStationCollection({ bookingId, stationId = null, collectedBy = null, now = new Date() }) {
  const scope = { _id: bookingId, ...(stationId ? { station: stationId } : {}) };
  const booking = await Booking.findOneAndUpdate(
    {
      ...scope,
      payMethod: "station",
      paymentStatus: "due_at_station",
      status: { $in: ["serving", "completed"] },
    },
    { $set: { paymentStatus: "paid", collectedBy, collectedAt: now } },
    { returnDocument: "after" },
  );
  if (booking) return { outcome: "collected", booking };

  const current = await Booking.findOne(scope);
  if (!current) return { outcome: "not_found" };
  if (current.paymentStatus === "paid") return { outcome: "already_paid", booking: current };
  if (current.payMethod !== "station") return { outcome: "not_pay_at_station", booking: current };
  return { outcome: "not_collectable", booking: current };
}

module.exports = { PAYABLE_STATUSES, recordCapturedPayment, recordFailedPayment, recordStationCollection };
