/**
 * POST /api/webhooks/razorpay -- Razorpay's server-to-server payment events.
 *
 * Settles a booking even when Checkout's client-side verify call never
 * arrives (tab closed, network dropped). Four guarantees:
 *
 * 1. Authentic: HMAC-SHA256 of the RAW request body with
 *    RAZORPAY_WEBHOOK_SECRET must match X-Razorpay-Signature. The route is
 *    mounted before express.json() (src/app.js) -- a re-serialised body would
 *    not match. No secret configured means 503, never "accept unsigned".
 * 2. Once: each X-Razorpay-Event-Id is claimed in the WebhookEvent ledger; a
 *    redelivery of a processed event answers 200 without doing anything.
 * 3. Retried on failure: a handler error releases the claim and answers 500,
 *    so Razorpay delivers again.
 * 4. Same rules as verify: services/payment/paymentRecording.js.
 *
 * Handled: payment.captured, payment.failed. Anything else is acknowledged
 * (200) and ignored, so Razorpay does not retry events we do not use.
 */

const crypto = require("crypto");
const Booking = require("../models/Booking");
const WebhookEvent = require("../models/WebhookEvent");
const { recordCapturedPayment, recordFailedPayment } = require("../services/payment/paymentRecording");

const PROVIDER = "razorpay";
const HANDLED_EVENTS = Object.freeze(["payment.captured", "payment.failed"]);
/** A "processing" claim older than this belongs to a request that died; a retry may take it over. */
const STALE_CLAIM_MS = 5 * 60 * 1000;

function signatureMatches(rawBody, signature, secret) {
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(rawBody).digest("hex"), "utf8");
  const given = Buffer.from(String(signature), "utf8");
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/**
 * Claim an event id for processing.
 * @returns {Promise<"claimed"|"processed"|"in_progress">}
 */
async function claimEvent(eventId, event) {
  await WebhookEvent.init(); // the unique index must exist before it can dedupe
  try {
    await WebhookEvent.create({ provider: PROVIDER, eventId, event, status: "processing", claimedAt: new Date() });
    return "claimed";
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  const takenOver = await WebhookEvent.findOneAndUpdate(
    { provider: PROVIDER, eventId, status: "processing", claimedAt: { $lt: new Date(Date.now() - STALE_CLAIM_MS) } },
    { $set: { claimedAt: new Date() } },
  );
  if (takenOver) return "claimed";
  const existing = await WebhookEvent.findOne({ provider: PROVIDER, eventId }).select("status").lean();
  return existing?.status === "processed" ? "processed" : "in_progress";
}

async function handleEvent(event, payload) {
  const payment = payload?.payload?.payment?.entity || {};
  const orderId = payment.order_id;
  const paymentId = payment.id;
  if (!orderId || !paymentId) return { outcome: "no_order", bookingId: null };

  if (event === "payment.failed") {
    return recordFailedPayment({ orderId, reason: payment.error_description || payment.error_reason });
  }

  // payment.captured
  const booking = await Booking.findOne({ razorpayOrderId: orderId });
  if (!booking) {
    console.warn(`[webhook] payment ${paymentId} captured for unknown order ${orderId}`);
    return { outcome: "unknown_order", bookingId: null };
  }
  if (payment.currency && payment.currency !== "INR") {
    console.warn(`[webhook] payment ${paymentId} for booking ${booking._id} is in ${payment.currency}; not marked paid`);
    return { outcome: "currency_mismatch", bookingId: String(booking._id) };
  }
  const { outcome } = await recordCapturedPayment({
    booking,
    orderId,
    paymentId,
    amountPaise: payment.amount,
    source: "webhook",
  });
  return { outcome, bookingId: String(booking._id) };
}

exports.razorpayWebhook = async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[webhook] RAZORPAY_WEBHOOK_SECRET is not set; refusing the delivery (Razorpay will retry)");
    return res.status(503).json({ ok: false, code: "WEBHOOK_NOT_CONFIGURED", msg: "Webhook is not configured" });
  }

  const raw = req.body;
  if (!Buffer.isBuffer(raw) || raw.length === 0) {
    return res.status(400).json({ ok: false, msg: "Empty webhook body" });
  }

  const signature = req.get("x-razorpay-signature");
  if (!signature || !signatureMatches(raw, signature, secret)) {
    console.warn(`[webhook] rejected a delivery with ${signature ? "an invalid" : "no"} signature from ${req.ip}`);
    return res.status(400).json({ ok: false, msg: "Invalid webhook signature" });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ ok: false, msg: "Webhook body is not JSON" });
  }

  const event = payload?.event;
  if (!HANDLED_EVENTS.includes(event)) {
    return res.json({ ok: true, ignored: event || null });
  }

  const eventId = req.get("x-razorpay-event-id");
  if (!eventId) {
    return res.status(400).json({ ok: false, msg: "Missing X-Razorpay-Event-Id" });
  }

  try {
    const claim = await claimEvent(eventId, event);
    if (claim === "processed") return res.json({ ok: true, duplicate: true });
    if (claim === "in_progress") {
      // Another delivery of this event is running now; a non-2xx makes Razorpay
      // come back later, by which time it has finished (or its claim is stale).
      return res.status(409).json({ ok: false, msg: "This event is already being processed" });
    }
  } catch (err) {
    console.error(`[webhook] could not claim event ${eventId}:`, err.message);
    return res.status(500).json({ ok: false, msg: "Webhook processing failed" });
  }

  try {
    const result = await handleEvent(event, payload);
    await WebhookEvent.updateOne(
      { provider: PROVIDER, eventId },
      { $set: { status: "processed", outcome: result.outcome, booking: result.bookingId, processedAt: new Date() } },
    );
    return res.json({ ok: true, outcome: result.outcome });
  } catch (err) {
    console.error(`[webhook] ${event} ${eventId} failed:`, err);
    // Release the claim so Razorpay's retry processes it.
    await WebhookEvent.deleteOne({ provider: PROVIDER, eventId, status: "processing" }).catch(() => {});
    return res.status(500).json({ ok: false, msg: "Webhook processing failed" });
  }
};

exports.HANDLED_EVENTS = HANDLED_EVENTS;
exports.STALE_CLAIM_MS = STALE_CLAIM_MS;
