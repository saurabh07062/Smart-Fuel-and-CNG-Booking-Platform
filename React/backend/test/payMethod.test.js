/**
 * Payment-method normalisation.
 *
 * These exist because narrowing the payMethod enum to 'online' | 'station'
 * silently broke every legacy client value (`cod`, `wallet`, `card`, `uppi`),
 * and the only symptom was "Failed to create booking". Any future change to
 * the vocabulary has to keep these passing.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalisePayMethod,
  isKnownPayMethod,
  initialPaymentStatus,
  payMethodLabel,
  PAY_METHODS,
} = require("../src/services/payment/payMethod");

test("legacy frontend values all map to a valid enum member", () => {
  // These four are what frontend/js/pages/booking.js actually sends.
  for (const legacy of ["wallet", "card", "uppi", "cod"]) {
    const got = normalisePayMethod(legacy);
    assert.ok(
      PAY_METHODS.includes(got),
      `${legacy} -> ${got} is not a valid payMethod`,
    );
  }
});

test("cash-style aliases mean pay at the station", () => {
  for (const v of ["cod", "cash", "Cash on Delivery", "pay_at_station", "POD", "station"]) {
    assert.equal(normalisePayMethod(v), "station", `${v} should be station`);
  }
});

test("gateway-style aliases mean pay online", () => {
  for (const v of ["wallet", "card", "upi", "uppi", "GPay", "PhonePe", "razorpay", "netbanking"]) {
    assert.equal(normalisePayMethod(v), "online", `${v} should be online`);
  }
});

test("unknown and empty values fall back to station, never online", () => {
  // Failing towards "money still owed" is safe; failing towards "already
  // paid" would let someone drive off without paying.
  for (const v of [undefined, null, "", "  ", "bitcoin", "???", 42]) {
    assert.equal(normalisePayMethod(v), "station", `${String(v)} should fall back to station`);
  }
});

test("normalisation is case- and separator-insensitive", () => {
  assert.equal(normalisePayMethod("CASH_ON_DELIVERY"), "station");
  assert.equal(normalisePayMethod("cash on delivery"), "station");
  assert.equal(normalisePayMethod("Cash-On-Delivery"), "station");
  assert.equal(normalisePayMethod("  NetBanking  "), "online");
});

test("normalisation is idempotent", () => {
  for (const v of ["cod", "wallet", "station", "online", "garbage"]) {
    const once = normalisePayMethod(v);
    assert.equal(normalisePayMethod(once), once, `${v} is not idempotent`);
  }
});

test("isKnownPayMethod distinguishes a real alias from a fallback", () => {
  assert.equal(isKnownPayMethod("cod"), true);
  assert.equal(isKnownPayMethod("wallet"), true);
  assert.equal(isKnownPayMethod("bitcoin"), false);
  assert.equal(isKnownPayMethod(undefined), false);
});

test("initial payment status follows the method", () => {
  assert.equal(initialPaymentStatus("cod"), "due_at_station");
  assert.equal(initialPaymentStatus("station"), "due_at_station");
  assert.equal(initialPaymentStatus("wallet"), "pending");
  assert.equal(initialPaymentStatus("card"), "pending");
  assert.equal(initialPaymentStatus("online"), "pending");
  // Unknown -> station -> owed, matching the safe fallback above.
  assert.equal(initialPaymentStatus("nonsense"), "due_at_station");
});

test("labels preserve what the customer actually picked", () => {
  assert.equal(payMethodLabel("wallet"), "FuelMart Wallet");
  assert.equal(payMethodLabel("uppi"), "UPI");
  assert.equal(payMethodLabel("card"), "Credit/Debit Card");
  assert.equal(payMethodLabel("cod"), "Cash at station");
  // Unknown still produces something printable rather than undefined.
  assert.ok(payMethodLabel("mystery"));
});

test("the Booking schema setter applies normalisation on write", () => {
  // Guards the actual wiring, not just the helper: a booking constructed with
  // a legacy value must validate.
  const mongoose = require("mongoose");
  const Booking = require("../src/models/Booking");

  for (const legacy of ["cod", "wallet", "card", "uppi"]) {
    const b = new Booking({
      user: new mongoose.Types.ObjectId(),
      station: new mongoose.Types.ObjectId(),
      fuelType: "petrol",
      quantity: 1,
      price: 101.72,
      amount: 101.72,
      bookingDate: "2099-01-01",
      payMethod: legacy,
    });

    assert.ok(PAY_METHODS.includes(b.payMethod), `${legacy} stored as ${b.payMethod}`);

    const err = b.validateSync();
    assert.equal(
      err?.errors?.payMethod,
      undefined,
      `${legacy} was rejected by the enum: ${err?.errors?.payMethod?.message}`,
    );
  }
});
