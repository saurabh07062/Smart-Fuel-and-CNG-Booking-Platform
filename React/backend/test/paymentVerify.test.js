/**
 * POST /api/razorpay/verify-payment (paymentController.verifyPayment):
 * a correctly signed payment marks only a live booking paid. A cancelled,
 * expired or no-show booking -- including one cancelled between the read and
 * the write -- is refused and stays unpaid.
 *
 * Signatures are made with a throwaway secret set for this file only; Razorpay
 * is never called. DEVELOPMENT TEST DATA, test database only: tagged customers
 * and their bookings, removed at the end.
 *
 *   node --test test/paymentVerify.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const { verifyPayment } = require("../src/controllers/paymentController");

const fakeRes = () => ({
  statusCode: 200,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

test("verify-payment against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const User = require("../src/models/User");
  const Booking = require("../src/models/Booking");

  const prevSecret = process.env.RAZORPAY_KEY_SECRET;
  const SECRET = crypto.randomBytes(16).toString("hex"); // this run only
  process.env.RAZORPAY_KEY_SECRET = SECRET;

  const tag = `payverify-${Date.now()}`;
  const stationId = new mongoose.Types.ObjectId();
  let n = 0;

  const sign = (orderId, paymentId, secret = SECRET) =>
    crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

  /** A fresh customer (one live booking each) with one online booking awaiting payment. */
  async function onlineBooking(fields = {}) {
    n += 1;
    const user = await User.create({
      name: `${tag}-c${n}`,
      email: `${tag}-c${n}@example.com`,
      password: "not-a-real-hash",
      role: "customer",
    });
    const booking = await Booking.create({
      user: user._id,
      station: stationId,
      fuelType: "Petrol",
      quantity: 5,
      price: 100,
      amount: 505,
      bookingDate: "2099-03-03",
      timeSlot: "8:00 AM",
      payMethod: "online",
      paymentStatus: "pending",
      razorpayOrderId: `order_${tag}_${n}`,
      ...fields,
    });
    return { user, booking };
  }

  async function verify(user, booking, overrides = {}) {
    const paymentId = `pay_${tag}_${booking._id}`;
    const body = {
      razorpay_order_id: booking.razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: sign(booking.razorpayOrderId, paymentId),
      booking_id: String(booking._id),
      ...overrides,
    };
    const res = fakeRes();
    await verifyPayment({ body, user: { id: String(user._id), role: "customer" } }, res);
    return res;
  }

  const paymentOf = async (booking) => (await Booking.findById(booking._id).lean()).paymentStatus;

  // Refusals log a warning by design; keep them out of the test output.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    await t.test("a signed payment for a live booking marks it paid", async () => {
      const { user, booking } = await onlineBooking();
      const res = await verify(user, booking);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.bookingId, String(booking._id));
      assert.equal(await paymentOf(booking), "paid");
    });

    await t.test("verifying the same payment again answers success and writes nothing new", async () => {
      const { user, booking } = await onlineBooking({ status: "serving" });
      assert.equal((await verify(user, booking)).statusCode, 200);
      const before = await Booking.findById(booking._id).lean();
      const again = await verify(user, booking);
      assert.equal(again.statusCode, 200);
      assert.equal(again.body.success, true);
      const after = await Booking.findById(booking._id).lean();
      assert.equal(after.paymentStatus, "paid");
      assert.equal(String(after.updatedAt), String(before.updatedAt));
    });

    for (const status of ["cancelled", "expired", "no_show"]) {
      await t.test(`a ${status} booking is refused (409) and stays unpaid`, async () => {
        const { user, booking } = await onlineBooking({ status });
        warnings.length = 0;
        const res = await verify(user, booking);
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.success, false);
        assert.equal(res.body.code, "BOOKING_NOT_PAYABLE");
        assert.equal(res.body.status, status);
        assert.equal(await paymentOf(booking), "pending");
        assert.ok(warnings.some((w) => w.includes("REFUND NEEDED") && w.includes(String(booking._id))));
      });
    }

    await t.test("a booking cancelled between the read and the write is still refused", async () => {
      const { user, booking } = await onlineBooking();
      const stale = await Booking.findById(booking._id); // read while upcoming
      await Booking.updateOne({ _id: booking._id }, { $set: { status: "cancelled", cancelledBy: "customer" } });

      const realFindById = Booking.findById;
      let first = true;
      Booking.findById = function patched(...args) {
        if (first) {
          first = false;
          return Promise.resolve(stale); // the controller's first read sees the old status
        }
        return realFindById.apply(this, args);
      };
      let res;
      try {
        res = await verify(user, booking);
      } finally {
        Booking.findById = realFindById;
      }
      assert.equal(first, false, "the stale read was used");
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.status, "cancelled");
      assert.equal(await paymentOf(booking), "pending");
    });

    await t.test("an already-paid booking that has since completed still answers success", async () => {
      const { user, booking } = await onlineBooking({ status: "completed", paymentStatus: "paid" });
      const res = await verify(user, booking);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
    });

    await t.test("a missing booking id is 400, not a silent success", async () => {
      const { user, booking } = await onlineBooking();
      const res = await verify(user, booking, { booking_id: undefined });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.equal(await paymentOf(booking), "pending");
    });

    await t.test("bad signature, someone else's booking, and a different order are all refused", async () => {
      const { user, booking } = await onlineBooking();
      const other = await onlineBooking();

      const forged = await verify(user, booking, { razorpay_signature: sign(booking.razorpayOrderId, "x", "wrong") });
      assert.equal(forged.statusCode, 400);

      const notMine = await verify(other.user, booking);
      assert.equal(notMine.statusCode, 403);

      const paymentId = `pay_${tag}_swap`;
      const swapped = await verify(user, booking, {
        razorpay_order_id: other.booking.razorpayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: sign(other.booking.razorpayOrderId, paymentId),
      });
      assert.equal(swapped.statusCode, 400);

      assert.equal(await paymentOf(booking), "pending");
      assert.equal(await paymentOf(other.booking), "pending");
    });
  } finally {
    console.warn = realWarn;
    if (prevSecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = prevSecret;
    const users = await User.find({ email: { $regex: `^${tag}-` } }).select("_id").lean();
    await Booking.deleteMany({ user: { $in: users.map((u) => u._id) } });
    await User.deleteMany({ _id: { $in: users.map((u) => u._id) } });
    await mongoose.disconnect();
  }
});
