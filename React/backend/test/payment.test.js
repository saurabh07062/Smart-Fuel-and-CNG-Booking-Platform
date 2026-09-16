/**
 * Payment tests.
 *
 * The paise conversion is pure and always runs. The pay-at-station lifecycle
 * needs MongoDB and skips when it is unreachable.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { toPaise, inspectConfig } = require("../src/controllers/paymentController");

const MONGO = require("./helpers/testDb").uri();

// ------------------------------------------------------ paise conversion

test("toPaise: rounds float artefacts to an integer", () => {
  // 4775.40 * 100 === 477539.99999999994 in IEEE-754. Razorpay rejects a
  // non-integer amount, so this must round, not truncate.
  const { paise } = toPaise(4775.4);
  assert.equal(paise, 477540);
  assert.ok(Number.isInteger(paise));
});

test("toPaise: every realistic booking amount yields an integer", () => {
  const prices = [106.12, 106.45, 105.9, 106.8, 96.72, 89.62, 92.98, 86.5, 73.59];
  let checked = 0;

  for (const p of prices) {
    for (let q = 1; q <= 60; q++) {
      const amount = Math.round(p * q * 100) / 100;
      const { paise, error } = toPaise(amount);
      assert.equal(error, undefined, `unexpected error for ${amount}`);
      assert.ok(Number.isInteger(paise), `${amount} -> ${paise} is not an integer`);
      checked++;
    }
  }
  assert.equal(checked, prices.length * 60);
});

test("toPaise: never rounds down and undercharges", () => {
  assert.equal(toPaise(4775.4).paise, 477540);
  assert.equal(toPaise(319.35).paise, 31935);
  assert.equal(toPaise(2235.45).paise, 223545);
});

test("toPaise: rejects junk instead of sending NaN to Razorpay", () => {
  for (const bad of [undefined, null, "", "abc", NaN, Infinity, -5, 0]) {
    const { error, paise } = toPaise(bad);
    assert.ok(error, `${String(bad)} should be rejected`);
    assert.equal(paise, undefined);
  }
});

test("toPaise: enforces the Rs.1 minimum", () => {
  assert.ok(toPaise(0.5).error, "50 paise is below the Razorpay minimum");
  assert.equal(toPaise(1).paise, 100);
});

test("toPaise: accepts numeric strings from JSON bodies", () => {
  assert.equal(toPaise("250.75").paise, 25075);
});

// --------------------------------------------------------- config check

test("inspectConfig: rejects a key that is not a Razorpay key id", () => {
  const prev = process.env.RAZORPAY_KEY_ID;
  process.env.RAZORPAY_KEY_ID = "768461323715225";
  process.env.RAZORPAY_KEY_SECRET ||= "x";

  const cfg = inspectConfig();
  assert.equal(cfg.ok, false);
  assert.match(cfg.reason, /does not look like a Razorpay key/);

  process.env.RAZORPAY_KEY_ID = prev;
});

test("inspectConfig: accepts well-formed test and live keys", () => {
  const prevId = process.env.RAZORPAY_KEY_ID;
  const prevSecret = process.env.RAZORPAY_KEY_SECRET;
  process.env.RAZORPAY_KEY_SECRET = "somesecret";

  process.env.RAZORPAY_KEY_ID = "rzp_test_1234567890abcd";
  assert.deepEqual(inspectConfig(), { ok: true, mode: "test" });

  process.env.RAZORPAY_KEY_ID = "rzp_live_1234567890abcd";
  assert.deepEqual(inspectConfig(), { ok: true, mode: "live" });

  process.env.RAZORPAY_KEY_ID = prevId;
  process.env.RAZORPAY_KEY_SECRET = prevSecret;
});

// ------------------------------------------- pay-at-station lifecycle

test("pay at station: booking is owed, then settled when served", async (t) => {
  const mongoose = require("mongoose");
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch (err) {
    t.skip(`MongoDB not reachable at ${MONGO}: ${err.message}`);
    return;
  }

  const bcrypt = require("bcryptjs");
  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const BookingAttempt = require("../src/models/BookingAttempt");
  const { createCustomerBooking } = require("../src/services/booking/bookingCreate");
  const bookingService = require("../src/services/booking/booking");

  const tag = `paytest-${Date.now()}`;
  const password = "paytest1234";

  const vendor = await User.create({
    name: `${tag}-vendor`,
    email: `${tag}-vendor@example.com`,
    password: await bcrypt.hash(password, 8),
    role: "vendor",
    vendorStatus: "active",
    isVerified: true,
  });

  const customer = await User.create({
    name: `${tag}-cust`,
    email: `${tag}-cust@example.com`,
    password: await bcrypt.hash(password, 8),
    role: "customer",
    isVerified: true,
  });

  const station = await Station.create({
    name: `${tag}-station`,
    address: "Pay Test Road, Pune",
    owner: vendor._id,
    coordinates: { lat: 18.52, lng: 73.85 },
    fuelTypes: ["Petrol"],
    prices: { petrol: 106.12, diesel: 0, cng: 0 },
    inventory: { petrol: 100000, diesel: 0, cng: 0 },
    status: "Active",
  });

  const book = (body) =>
    createCustomerBooking({
      user: { id: String(customer._id) },
      body: { stationId: String(station._id), fuelType: "petrol", timeSlot: "8:00 AM", ...body },
    });

  let failure = null;
  try {
    // --- book with pay-at-station; the client-sent price must be ignored ---
    const booked = await book({ quantity: 23, bookingDate: "2099-02-02", payMethod: "station", price: 1, amount: 1 });

    assert.equal(booked.payMethod, "station");
    assert.equal(booked.paymentStatus, "due_at_station", "a station booking must start as owed, not paid");
    assert.equal(booked.price, 106.12, "unit price comes from the station, not the request");
    assert.equal(booked.amount, 2445.76, "23 x 106.12 + 5 convenience fee, calculated on the server");

    // The stored amount must survive conversion to integer paise.
    const { paise, error } = toPaise(booked.amount);
    assert.equal(error, undefined);
    assert.ok(Number.isInteger(paise), `${booked.amount} -> ${paise}`);

    // --- serve it and collect ---
    const served = await bookingService.markServed({
      bookingId: booked._id,
      servedBy: vendor._id,
      collectPayment: true,
    });

    assert.equal(served.status, "completed");
    assert.equal(served.collected.amount, booked.amount);

    const after = await Booking.findById(booked._id);
    assert.equal(after.paymentStatus, "paid", "collecting at the pump marks it paid");
    assert.equal(String(after.collectedBy), String(vendor._id));
    assert.ok(after.collectedAt instanceof Date);

    // --- serving without collecting leaves it owed ---
    const b2 = await book({ quantity: 5, bookingDate: "2099-02-02", payMethod: "station" });
    const served2 = await bookingService.markServed({
      bookingId: b2._id,
      servedBy: vendor._id,
      collectPayment: false,
    });

    assert.equal(served2.collected.outstanding, true);
    const after2 = await Booking.findById(b2._id);
    assert.equal(after2.paymentStatus, "due_at_station", "serving without collecting must not mark it paid");

    // --- online payment is switched off by default: refused, nothing reserved ---
    const prevOnline = process.env.ONLINE_PAYMENTS_ENABLED;
    delete process.env.ONLINE_PAYMENTS_ENABLED;
    const committedBefore = (await Station.findById(station._id).lean()).inventoryCommitted?.petrol ?? 0;
    await assert.rejects(
      book({ quantity: 5, bookingDate: "2099-02-03", payMethod: "online" }),
      (err) => err.reason === "ONLINE_PAYMENT_DISABLED" || err.code === "ONLINE_PAYMENT_DISABLED",
    );
    assert.equal(await Booking.countDocuments({ station: station._id, bookingDate: "2099-02-03" }), 0);
    assert.equal((await Station.findById(station._id).lean()).inventoryCommitted?.petrol ?? 0, committedBefore);

    // --- switched on: an online booking starts pending, not owed-at-station ---
    process.env.ONLINE_PAYMENTS_ENABLED = "true";
    try {
      const b3 = await book({ quantity: 5, bookingDate: "2099-02-03", payMethod: "online" });
      assert.equal(b3.payMethod, "online");
      assert.equal(b3.paymentStatus, "pending");
    } finally {
      if (prevOnline === undefined) delete process.env.ONLINE_PAYMENTS_ENABLED;
      else process.env.ONLINE_PAYMENTS_ENABLED = prevOnline;
    }
  } catch (err) {
    failure = err;
  } finally {
    await Booking.deleteMany({ station: station._id });
    await BookingAttempt.deleteMany({ user: customer._id });
    await require("../src/models/InventoryMovement").deleteMany({ station: station._id });
    await Station.deleteOne({ _id: station._id });
    await User.deleteMany({ email: { $regex: `^${tag}-` } });
    await mongoose.disconnect();
    // bookingCreate pulls in services/lock and services/rateLimiter, which can
    // open Redis sockets; close them or `node --test` waits on this file forever.
    await require("../src/services/core/lock").close();
    await require("../src/services/security/rateLimiter").close();
  }

  if (failure) throw failure;
});
