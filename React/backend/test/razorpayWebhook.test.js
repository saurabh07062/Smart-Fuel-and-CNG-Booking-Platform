/**
 * POST /api/webhooks/razorpay over HTTP, through the real src/app.js (which
 * proves the route receives the raw body): signature checked, payment.captured
 * and payment.failed recorded under the same rules as verify-payment, each
 * event id processed once.
 *
 * Signatures use a throwaway secret set for this file only; Razorpay is never
 * called. DEVELOPMENT TEST DATA, test database only: tagged customers, their
 * bookings and webhook ledger rows, removed at the end.
 *
 *   node --test test/razorpayWebhook.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const testDb = require("./helpers/testDb");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("Razorpay webhook against MongoDB", async (t) => {
  const MONGO = testDb.uri();
  testDb.isolateRedis();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const prevSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const SECRET = crypto.randomBytes(16).toString("hex"); // this run only
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;

  const User = require("../src/models/User");
  const Booking = require("../src/models/Booking");
  const WebhookEvent = require("../src/models/WebhookEvent");
  const { STALE_CLAIM_MS } = require("../src/controllers/webhookController");
  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const tag = `rzpwebhook-${Date.now()}`;
  const stationId = new mongoose.Types.ObjectId();
  let n = 0;
  let events = 0;

  async function onlineBooking(fields = {}) {
    n += 1;
    const user = await User.create({
      name: `${tag}-c${n}`,
      email: `${tag}-c${n}@example.com`,
      password: "not-a-real-hash",
      role: "customer",
    });
    return Booking.create({
      user: user._id,
      station: stationId,
      fuelType: "Petrol",
      quantity: 5,
      price: 100,
      amount: 505.25,
      bookingDate: "2099-04-04",
      timeSlot: "8:00 AM",
      payMethod: "online",
      paymentStatus: "pending",
      razorpayOrderId: `order_${tag}_${n}`,
      ...fields,
    });
  }

  const paymentEvent = (event, booking, entity = {}) => ({
    entity: "event",
    event,
    payload: {
      payment: {
        entity: {
          id: `pay_${tag}_${booking._id}_${event}`,
          order_id: booking.razorpayOrderId,
          amount: 50525,
          currency: "INR",
          status: event === "payment.captured" ? "captured" : "failed",
          ...entity,
        },
      },
    },
  });

  /** Deliver `body` like Razorpay does. The raw text is pretty-printed on purpose: the signature is over these exact bytes. */
  async function deliver(body, { eventId = `evt_${tag}_${++events}`, secret = SECRET, signature, raw } = {}) {
    const text = raw ?? JSON.stringify(body, null, 2);
    const headers = { "Content-Type": "application/json" };
    if (eventId) headers["X-Razorpay-Event-Id"] = eventId;
    const sig = signature === undefined ? crypto.createHmac("sha256", secret).update(text).digest("hex") : signature;
    if (sig) headers["X-Razorpay-Signature"] = sig;
    const res = await fetch(`${base}/api/webhooks/razorpay`, { method: "POST", headers, body: text });
    return { status: res.status, body: await res.json(), eventId };
  }

  const fresh = (booking) => Booking.findById(booking._id).lean();

  const warnings = [];
  const errors = [];
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (...args) => warnings.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));

  try {
    await t.test("no webhook secret configured: 503, nothing recorded", async () => {
      const booking = await onlineBooking();
      delete process.env.RAZORPAY_WEBHOOK_SECRET;
      try {
        const res = await deliver(paymentEvent("payment.captured", booking));
        assert.equal(res.status, 503);
        assert.equal(res.body.code, "WEBHOOK_NOT_CONFIGURED");
      } finally {
        process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
      }
      assert.equal((await fresh(booking)).paymentStatus, "pending");
    });

    await t.test("a missing, forged or wrong-secret signature is rejected (400)", async () => {
      const booking = await onlineBooking();
      const body = paymentEvent("payment.captured", booking);
      assert.equal((await deliver(body, { signature: "" })).status, 400);
      assert.equal((await deliver(body, { signature: "a".repeat(64) })).status, 400);
      assert.equal((await deliver(body, { secret: "not-the-secret" })).status, 400);
      // Signed, then altered in transit: the amount changed after signing.
      const signedText = JSON.stringify(body);
      const signature = crypto.createHmac("sha256", SECRET).update(signedText).digest("hex");
      const tampered = signedText.replace("50525", "100");
      assert.equal((await deliver(null, { raw: tampered, signature })).status, 400);

      assert.equal((await fresh(booking)).paymentStatus, "pending");
      assert.equal(await WebhookEvent.countDocuments({ eventId: { $regex: `^evt_${tag}_` }, status: "processed" }), 0);
    });

    await t.test("payment.captured marks a live booking paid and keeps the payment id", async () => {
      const booking = await onlineBooking();
      const body = paymentEvent("payment.captured", booking);
      const res = await deliver(body);
      assert.equal(res.status, 200);
      assert.equal(res.body.outcome, "paid");
      const after = await fresh(booking);
      assert.equal(after.paymentStatus, "paid");
      assert.equal(after.razorpayPaymentId, body.payload.payment.entity.id);
      const row = await WebhookEvent.findOne({ provider: "razorpay", eventId: res.eventId }).lean();
      assert.equal(row.status, "processed");
      assert.equal(row.outcome, "paid");
      assert.equal(String(row.booking), String(booking._id));
    });

    await t.test("the same event id delivered again is acknowledged and does nothing", async () => {
      const booking = await onlineBooking();
      const body = paymentEvent("payment.captured", booking);
      const first = await deliver(body);
      assert.equal(first.body.outcome, "paid");
      const before = await fresh(booking);

      const again = await deliver(body, { eventId: first.eventId });
      assert.equal(again.status, 200);
      assert.equal(again.body.duplicate, true);
      const after = await fresh(booking);
      assert.equal(String(after.updatedAt), String(before.updatedAt));
      assert.equal(await WebhookEvent.countDocuments({ provider: "razorpay", eventId: first.eventId }), 1);
    });

    await t.test("a different event for an already-paid booking is a no-op (verify got there first)", async () => {
      const booking = await onlineBooking({ paymentStatus: "paid", status: "completed" });
      const res = await deliver(paymentEvent("payment.captured", booking));
      assert.equal(res.status, 200);
      assert.equal(res.body.outcome, "already_paid");
    });

    for (const status of ["cancelled", "expired"]) {
      await t.test(`payment.captured for a ${status} booking: not paid, payment id kept, refund logged`, async () => {
        const booking = await onlineBooking({ status });
        const body = paymentEvent("payment.captured", booking);
        warnings.length = 0;
        const res = await deliver(body);
        assert.equal(res.status, 200, "acknowledged, so Razorpay does not retry");
        assert.equal(res.body.outcome, "not_payable");
        const after = await fresh(booking);
        assert.equal(after.paymentStatus, "pending");
        assert.equal(after.razorpayPaymentId, body.payload.payment.entity.id);
        assert.ok(warnings.some((w) => w.includes("REFUND NEEDED") && w.includes(String(booking._id))));
      });
    }

    await t.test("a captured amount that is not the booking's price is not marked paid", async () => {
      const booking = await onlineBooking();
      const res = await deliver(paymentEvent("payment.captured", booking, { amount: 100 }));
      assert.equal(res.body.outcome, "amount_mismatch");
      assert.equal((await fresh(booking)).paymentStatus, "pending");
    });

    await t.test("payment.failed marks an unpaid booking failed; a later capture still pays it", async () => {
      const booking = await onlineBooking();
      const failed = await deliver(
        paymentEvent("payment.failed", booking, { error_description: "Payment declined by the bank" }),
      );
      assert.equal(failed.body.outcome, "failed");
      let after = await fresh(booking);
      assert.equal(after.paymentStatus, "failed");
      assert.equal(after.paymentFailureReason, "Payment declined by the bank");

      const retried = await deliver(paymentEvent("payment.captured", booking, { id: `pay_${tag}_retry` }));
      assert.equal(retried.body.outcome, "paid");
      after = await fresh(booking);
      assert.equal(after.paymentStatus, "paid");
      assert.equal(after.paymentFailureReason, undefined);
    });

    await t.test("payment.failed arriving after the capture never un-pays the booking", async () => {
      const booking = await onlineBooking();
      assert.equal((await deliver(paymentEvent("payment.captured", booking))).body.outcome, "paid");
      const late = await deliver(paymentEvent("payment.failed", booking, { error_description: "late" }));
      assert.equal(late.status, 200);
      assert.equal(late.body.outcome, "ignored");
      assert.equal((await fresh(booking)).paymentStatus, "paid");
    });

    await t.test("an unknown order is acknowledged; an unhandled event is ignored without a ledger row", async () => {
      const booking = await onlineBooking();
      const unknown = await deliver(paymentEvent("payment.captured", booking, { order_id: `order_${tag}_nobody` }));
      assert.equal(unknown.status, 200);
      assert.equal(unknown.body.outcome, "unknown_order");

      const other = await deliver({ event: "order.paid", payload: {} });
      assert.equal(other.status, 200);
      assert.equal(other.body.ignored, "order.paid");
      assert.equal(await WebhookEvent.countDocuments({ eventId: other.eventId }), 0);
      assert.equal((await fresh(booking)).paymentStatus, "pending");
    });

    await t.test("a signed delivery without an event id is rejected (400)", async () => {
      const booking = await onlineBooking();
      const res = await deliver(paymentEvent("payment.captured", booking), { eventId: null });
      assert.equal(res.status, 400);
      assert.equal((await fresh(booking)).paymentStatus, "pending");
    });

    await t.test("an event still being processed answers 409; a stale claim is taken over", async () => {
      await WebhookEvent.init();
      const booking = await onlineBooking();
      const body = paymentEvent("payment.captured", booking);

      const busyId = `evt_${tag}_busy`;
      await WebhookEvent.create({ provider: "razorpay", eventId: busyId, event: "payment.captured", claimedAt: new Date() });
      const busy = await deliver(body, { eventId: busyId });
      assert.equal(busy.status, 409);
      assert.equal((await fresh(booking)).paymentStatus, "pending");

      const staleId = `evt_${tag}_stale`;
      await WebhookEvent.create({
        provider: "razorpay",
        eventId: staleId,
        event: "payment.captured",
        claimedAt: new Date(Date.now() - STALE_CLAIM_MS - 60_000),
      });
      const takeover = await deliver(body, { eventId: staleId });
      assert.equal(takeover.status, 200);
      assert.equal(takeover.body.outcome, "paid");
      assert.equal((await WebhookEvent.findOne({ eventId: staleId }).lean()).status, "processed");
    });
  } finally {
    console.warn = realWarn;
    console.error = realError;
    if (prevSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
    else process.env.RAZORPAY_WEBHOOK_SECRET = prevSecret;
    await new Promise((resolve) => server.close(resolve));
    const users = await User.find({ email: { $regex: `^${tag}-` } }).select("_id").lean();
    await Booking.deleteMany({ user: { $in: users.map((u) => u._id) } });
    await User.deleteMany({ _id: { $in: users.map((u) => u._id) } });
    await WebhookEvent.deleteMany({ eventId: { $regex: `^evt_${tag}_` } });
    await mongoose.disconnect();
  }
});
