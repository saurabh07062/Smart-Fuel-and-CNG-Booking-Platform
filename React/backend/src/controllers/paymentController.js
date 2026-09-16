/**
 * Razorpay payments.
 *
 * Three things this file is careful about, each of which was a live bug:
 *
 * 1. Rupees -> paise must go through Math.round(). `amount * 100` is a float
 *    operation: 4775.40 * 100 === 477539.99999999994, and Razorpay rejects a
 *    non-integer amount. Roughly one booking in ten hits this.
 *
 * 2. No hardcoded key fallbacks. A `|| "<literal secret>"` fallback both leaks
 *    the secret into source control and turns a missing-config problem into a
 *    silent signature mismatch that looks like a customer payment failure.
 *
 * 3. Razorpay's real error is surfaced. Collapsing a 401 "Authentication
 *    failed" into a generic 500 "Payment creation failed" is why this was hard
 *    to diagnose from the outside.
 */

const Razorpay = require("razorpay");
const crypto = require("crypto");
const Booking = require("../models/Booking");
const { PAYABLE_STATUSES, recordCapturedPayment } = require("../services/payment/paymentRecording");
const { onlinePaymentsEnabled, ONLINE_PAYMENT_DISABLED_MSG } = require("../config/payments");

const MIN_PAISE = 100; // Razorpay rejects anything under ₹1
const MAX_PAISE = 1_500_00_000; // ₹15,00,000 — well above any fuel booking

/**
 * Built lazily. Constructing Razorpay at module load with undefined keys
 * throws and takes the whole server down at require() time, which turns a
 * misconfiguration into a boot failure.
 */
let client = null;
function getClient() {
  if (client) return client;

  const { RAZORPAY_KEY_ID: id, RAZORPAY_KEY_SECRET: secret } = process.env;
  if (!id || !secret) {
    throw configError(
      "Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env",
    );
  }

  client = new Razorpay({ key_id: id, key_secret: secret });
  return client;
}

function configError(msg) {
  const err = new Error(msg);
  err.code = "PAYMENT_NOT_CONFIGURED";
  err.status = 503;
  return err;
}

/**
 * Is the configuration even plausible? Real key IDs are `rzp_test_…` or
 * `rzp_live_…`. Catching the shape locally gives a far better message than
 * a 401 from Razorpay after a network round trip.
 */
function inspectConfig() {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;

  if (!id || !secret) {
    return { ok: false, reason: "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set" };
  }
  if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(id)) {
    return {
      ok: false,
      reason:
        `RAZORPAY_KEY_ID does not look like a Razorpay key. ` +
        `Expected "rzp_test_…" or "rzp_live_…", got "${id}". ` +
        `Copy the Key Id from Razorpay Dashboard → Settings → API Keys.`,
    };
  }
  return { ok: true, mode: id.startsWith("rzp_live_") ? "live" : "test" };
}

/** Rupees -> integer paise, or a validation error. */
function toPaise(amountInRupees) {
  const amount = Number(amountInRupees);

  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "amount must be a positive number of rupees" };
  }

  // Round, do not truncate: 477539.99999999994 must become 477540, not 477539
  // (which would silently undercharge by a paisa).
  const paise = Math.round(amount * 100);

  if (paise < MIN_PAISE) return { error: `amount must be at least ₹${MIN_PAISE / 100}` };
  if (paise > MAX_PAISE) return { error: "amount exceeds the maximum allowed" };

  return { paise };
}

/**
 * POST /api/razorpay/create-order
 * Body: { amount } or { bookingId } — prefer bookingId, see below.
 */
exports.createOrder = async (req, res) => {
  try {
    // Bookings are paid at the petrol pump while online payment is off (config/payments.js).
    if (!onlinePaymentsEnabled()) {
      return res.status(503).json({ msg: ONLINE_PAYMENT_DISABLED_MSG, code: "ONLINE_PAYMENT_DISABLED" });
    }

    const cfg = inspectConfig();
    if (!cfg.ok) return res.status(503).json({ msg: cfg.reason, code: "PAYMENT_NOT_CONFIGURED" });

    // The server always decides the amount -- a client-supplied figure would
    // let anyone pay ₹1 for a ₹5000 booking. The frontend sends `booking_id`,
    // older callers `bookingId`; both are accepted. A bare amount is not.
    const bookingId = req.body?.bookingId || req.body?.booking_id;
    if (!bookingId) {
      return res.status(400).json({ msg: "bookingId is required to create a payment order" });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ msg: "Booking not found" });
    if (String(booking.user) !== String(req.user.id)) {
      return res.status(403).json({ msg: "Not your booking" });
    }
    if (booking.paymentStatus === "paid") {
      return res.status(409).json({ msg: "This booking is already paid" });
    }
    if (booking.payMethod !== "online") {
      return res.status(409).json({ msg: "This booking is paid at the station, not online" });
    }
    if (!PAYABLE_STATUSES.includes(booking.status)) {
      return res.status(409).json({ msg: `This booking is ${booking.status} and cannot be paid for` });
    }

    const amountInRupees = booking.amount;

    const { paise, error } = toPaise(amountInRupees);
    if (error) return res.status(400).json({ msg: error });

    const order = await getClient().orders.create({
      amount: paise,
      currency: "INR",
      receipt: booking ? `booking_${booking._id}` : `receipt_${Date.now()}`,
      notes: booking ? { bookingId: String(booking._id) } : undefined,
    });

    // Attach the order only if nothing changed since the read. Two concurrent
    // create-order calls would otherwise each create an order and the second
    // would overwrite the first -- and a customer who paid the first could
    // never have that payment verified against the booking.
    const attached = await Booking.updateOne(
      {
        _id: booking._id,
        paymentStatus: { $ne: "paid" },
        status: { $in: ["upcoming", "serving"] },
        razorpayOrderId: booking.razorpayOrderId ?? null,
      },
      { $set: { razorpayOrderId: order.id } },
    );
    if (!attached.modifiedCount) {
      console.warn(`[payment] create-order lost a race for booking ${booking._id}; order ${order.id} not attached`);
      return res.status(409).json({
        msg: "A payment for this booking was just started or completed. Please refresh and try again.",
        code: "PAYMENT_ORDER_CONFLICT",
      });
    }

    res.json({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      bookingId: booking ? String(booking._id) : null,
    });
  } catch (err) {
    if (err.code === "PAYMENT_NOT_CONFIGURED") {
      return res.status(503).json({ msg: err.message, code: err.code });
    }

    // Razorpay errors carry statusCode + error.description. Passing those
    // through is the difference between "Payment creation failed" and
    // "Authentication failed — your API key is wrong".
    const status = err.statusCode || 502;
    const description =
      err.error?.description || err.message || "Payment provider rejected the request";

    console.error(
      `[payment] create-order failed (${status}): ${description}`,
      err.error || "",
    );

    res.status(status === 401 ? 503 : status).json({
      msg:
        status === 401
          ? "Payment provider rejected our credentials. Check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET."
          : description,
      code: status === 401 ? "PAYMENT_AUTH_FAILED" : "PAYMENT_ERROR",
    });
  }
};

/** GET /api/razorpay/get-key — the publishable key id for Razorpay Checkout. */
exports.getKey = (req, res) => {
  const cfg = inspectConfig();
  if (!cfg.ok) {
    return res.status(503).json({ msg: cfg.reason, code: "PAYMENT_NOT_CONFIGURED" });
  }
  // Only the key *id* is public. The secret never leaves the server.
  res.json({ key: process.env.RAZORPAY_KEY_ID, mode: cfg.mode });
};

/**
 * POST /api/razorpay/verify-payment
 *
 * Confirms the HMAC that Razorpay Checkout returns. This is the only thing
 * standing between a real payment and a forged one, so there is no fallback
 * secret and no path that marks a booking paid without a signature match.
 */
exports.verifyPayment = async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      return res.status(503).json({
        success: false,
        msg: "Razorpay is not configured on the server.",
        code: "PAYMENT_NOT_CONFIGURED",
      });
    }

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      booking_id,
      bookingId,
    } = req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        msg: "razorpay_order_id, razorpay_payment_id and razorpay_signature are all required",
      });
    }

    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    // timingSafeEqual needs equal-length buffers, and throws otherwise —
    // check the length first rather than letting it throw into the 500 handler.
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(String(razorpay_signature), "utf8");
    const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

    if (!valid) {
      console.warn(`[payment] signature mismatch for order ${razorpay_order_id}`);
      return res.status(400).json({ success: false, msg: "Invalid payment signature" });
    }

    // A payment is only ever recorded against a booking. Without one there is
    // nothing to mark paid, and answering "success" would tell the customer
    // their payment counted when nothing was recorded.
    const id = booking_id || bookingId;
    if (!id) {
      return res.status(400).json({ success: false, msg: "booking_id is required to verify a payment" });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ success: false, msg: "Booking not found" });
    if (String(booking.user) !== String(req.user.id)) {
      return res.status(403).json({ success: false, msg: "Not your booking" });
    }

    // The order this payment settles must be the order we created for this
    // booking (create-order stores it, priced by the server). Without that
    // match, a genuinely paid ₹1 order could mark a ₹5000 booking paid.
    if (booking.razorpayOrderId !== razorpay_order_id) {
      console.warn(
        `[payment] order mismatch: booking ${id} expects ${booking.razorpayOrderId}, got ${razorpay_order_id}`,
      );
      return res
        .status(400)
        .json({ success: false, msg: "This payment does not belong to that booking" });
    }

    // Shared with the webhook (services/payment/paymentRecording.js): only a
    // live booking becomes paid, the status is part of the write so a racing
    // cancel or expiry wins, and an already-paid booking is answered as-is.
    const { outcome, status } = await recordCapturedPayment({
      booking,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      source: "checkout",
    });

    if (outcome === "paid" || outcome === "already_paid") {
      return res.json({ success: true, msg: "Payment verified successfully", bookingId: id });
    }

    // Genuine money, but the booking is no longer live: logged for a refund,
    // never marked paid.
    return res.status(409).json({
      success: false,
      code: "BOOKING_NOT_PAYABLE",
      status: status || null,
      msg:
        `Your payment was received, but this booking is ${status || "no longer available"}. ` +
        "It has not been confirmed; the amount will be refunded.",
    });
  } catch (err) {
    console.error("[payment] verify failed:", err);
    res.status(500).json({ success: false, msg: "Payment verification failed" });
  }
};

/** GET /api/razorpay/status — config health, without leaking the secret. */
exports.status = (req, res) => {
  const cfg = inspectConfig();
  const enabled = onlinePaymentsEnabled();
  const usable = enabled && cfg.ok;
  res.status(usable ? 200 : 503).json({
    onlinePaymentsEnabled: enabled,
    configured: usable,
    mode: usable ? cfg.mode : null,
    keyId: usable ? process.env.RAZORPAY_KEY_ID : null,
    secretSet: Boolean(process.env.RAZORPAY_KEY_SECRET),
    reason: enabled ? cfg.reason || null : "Online payment is switched off: bookings are paid at the petrol pump.",
  });
};

exports.inspectConfig = inspectConfig;
exports.toPaise = toPaise;
