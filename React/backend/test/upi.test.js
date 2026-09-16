/**
 * UPI intent-link construction.
 *
 * A malformed UPI URI fails silently at the pump — the app either refuses to
 * open or opens with the wrong amount — so these pin the format tightly.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const upi = require("../src/services/payment/upi");

/** Parse a upi:// URI's query the way a UPI app would. */
function params(uri) {
  return new URL(uri.replace("upi://", "https://")).searchParams;
}

test("builds a valid intent with the required NPCI fields", () => {
  const { uri } = upi.buildUpiUri({
    vpa: "saurabh07062-3@okicici",
    payeeName: "Saurabh yadav",
    amount: 101.72,
  });

  assert.ok(uri.startsWith("upi://pay?"));
  const p = params(uri);
  assert.equal(p.get("pa"), "saurabh07062-3@okicici");
  assert.equal(p.get("pn"), "Saurabh yadav");
  assert.equal(p.get("am"), "101.72");
  assert.equal(p.get("cu"), "INR");
});

test("amount is always 2dp and free of float artefacts", () => {
  // 4775.4 * 100 is 477539.99999999994 — toFixed(2) is what keeps the QR honest.
  assert.equal(params(upi.buildUpiUri({ vpa: "a@okicici", payeeName: "X", amount: 4775.4 }).uri).get("am"), "4775.40");
  assert.equal(params(upi.buildUpiUri({ vpa: "a@okicici", payeeName: "X", amount: 50 }).uri).get("am"), "50.00");
  assert.equal(params(upi.buildUpiUri({ vpa: "a@okicici", payeeName: "X", amount: 0.5 }).uri).get("am"), "0.50");
});

test("omitting the amount yields a static any-amount QR", () => {
  const { uri } = upi.buildUpiUri({ vpa: "a@okicici", payeeName: "X" });
  assert.equal(params(uri).get("am"), null);
  assert.equal(params(uri).get("pa"), "a@okicici");
});

test("an ampersand in the payee name cannot truncate the link", () => {
  // Unencoded, "Fuel & Go" would end the pn value and drop every later param.
  const { uri } = upi.buildUpiUri({
    vpa: "shop@okaxis",
    payeeName: "Fuel & Go",
    amount: 50,
    note: "Pay & fill",
    ref: "AB-12/34",
  });

  const p = params(uri);
  assert.equal([...p].length, 6, "no parameter should be lost");
  assert.equal(p.get("cu"), "INR");
  assert.equal(p.get("am"), "50.00");
  assert.ok(!p.get("pn").includes("&"));
});

test("reference is stripped to alphanumerics banks accept", () => {
  const { uri } = upi.buildUpiUri({
    vpa: "a@okicici",
    payeeName: "X",
    amount: 10,
    ref: "FM-2026/03#7416",
  });
  assert.equal(params(uri).get("tr"), "FM2026037416");
});

test("rejects malformed VPAs rather than emitting a dead QR", () => {
  for (const bad of ["nope", "", "@bank", "user@", "user@b", null, undefined, "a b@okicici"]) {
    const r = upi.buildUpiUri({ vpa: bad, payeeName: "X", amount: 10 });
    assert.ok(r.error, `${String(bad)} should be rejected`);
    assert.equal(r.uri, undefined);
  }
});

test("accepts the real-world VPA shapes", () => {
  for (const good of [
    "saurabh07062-3@okicici",
    "user.name@oksbi",
    "9876543210@paytm",
    "shop_1@okaxis",
    "abc@ybl",
  ]) {
    assert.ok(upi.isValidVpa(good), `${good} should be valid`);
  }
});

test("rejects a non-positive amount", () => {
  assert.ok(upi.buildUpiUri({ vpa: "a@okicici", payeeName: "X", amount: 0 }).error);
  assert.ok(upi.buildUpiUri({ vpa: "a@okicici", payeeName: "X", amount: -5 }).error);
  assert.ok(upi.buildUpiUri({ vpa: "a@okicici", payeeName: "X", amount: "abc" }).error);
});

test("station UPI id takes precedence over the platform fallback", () => {
  const prev = process.env.UPI_ID;
  process.env.UPI_ID = "platform@okicici";

  const own = upi.resolvePayee({ name: "S", upiId: "vendor@paytm", upiName: "Vendor Co" });
  assert.equal(own.vpa, "vendor@paytm");
  assert.equal(own.source, "station");

  const fallback = upi.resolvePayee({ name: "S" });
  assert.equal(fallback.vpa, "platform@okicici");
  assert.equal(fallback.source, "platform");

  process.env.UPI_ID = prev;
});

test("an invalid station VPA falls through to the platform payee", () => {
  const prev = process.env.UPI_ID;
  process.env.UPI_ID = "platform@okicici";

  // A vendor typo must not produce a dead QR when a working fallback exists.
  const r = upi.resolvePayee({ name: "S", upiId: "not-a-vpa" });
  assert.equal(r.vpa, "platform@okicici");

  process.env.UPI_ID = prev;
});

test("no payee anywhere returns an actionable error, not a broken link", async () => {
  const prev = process.env.UPI_ID;
  delete process.env.UPI_ID;

  const r = await upi.buildBookingPayment({ amount: 100, verificationCode: "1234" }, { name: "S" });
  assert.ok(r.error);
  assert.match(r.error, /No UPI ID configured/);
  assert.equal(r.uri, undefined);

  if (prev) process.env.UPI_ID = prev;
});

test("buildBookingPayment carries the booking amount and reference", async () => {
  const r = await upi.buildBookingPayment(
    { amount: 2440.76, verificationCode: "7416" },
    { name: "FuelMart Shivajinagar", upiId: "station@okicici", upiName: "FuelMart Shivajinagar" },
  );

  assert.equal(r.vpa, "station@okicici");
  assert.equal(r.amount, 2440.76);
  assert.equal(r.reference, "7416");

  const p = params(r.uri);
  assert.equal(p.get("am"), "2440.76");
  assert.equal(p.get("tr"), "7416");
});

test("Station schema validates upiId", () => {
  const mongoose = require("mongoose");
  const Station = require("../src/models/Station");

  const ok = new Station({ name: "t", address: "a", upiId: "saurabh07062-3@okicici" });
  assert.equal(ok.validateSync()?.errors?.upiId, undefined);

  const bad = new Station({ name: "t", address: "a", upiId: "not-a-vpa" });
  assert.ok(bad.validateSync()?.errors?.upiId, "invalid VPA should be rejected");

  // Unset is fine — the platform fallback covers it.
  const none = new Station({ name: "t", address: "a" });
  assert.equal(none.validateSync()?.errors?.upiId, undefined);
});

// ------------------------------------------------- server-side rendering

test("QR is rendered server-side so no client library is needed", async () => {
  // The client used to depend on a CDN-hosted QR library. When that CDN was
  // unreachable the customer got a blank white box at the pump. The payload
  // must therefore always carry a ready-to-display image.
  const uri = "upi://pay?pa=a@okicici&pn=X&cu=INR&am=10.00";
  const dataUri = await upi.toQrDataUri(uri);

  assert.ok(dataUri, "expected a data URI");
  assert.match(dataUri, /^data:image\/png;base64,/);
  assert.ok(dataUri.length > 500, "data URI looks too small to be a real QR");
});

test("buildBookingPayment includes qrDataUri alongside the raw uri", async () => {
  const r = await upi.buildBookingPayment(
    { amount: 106.12, verificationCode: "931735" },
    { name: "S", upiId: "saurabh07062-3@okicici", upiName: "Saurabh yadav" },
  );

  assert.ok(r.uri, "raw uri is still provided for the deep link");
  assert.match(r.qrDataUri, /^data:image\/png;base64,/);
});

test("the rendered QR encodes exactly the intent URI", async () => {
  // Re-render independently and compare bytes: identical output proves the
  // served image decodes to the URI we think it does.
  const QRCode = require("qrcode");
  const opts = {
    width: 220,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#0F172A", light: "#FFFFFF" },
  };

  const uri = "upi://pay?pa=a@okicici&pn=X&cu=INR&am=42.00&tr=ABC123";
  const [ours, reference] = await Promise.all([
    upi.toQrDataUri(uri),
    QRCode.toDataURL(uri, opts),
  ]);

  assert.equal(ours, reference, "rendered QR does not match the URI it should encode");
});

test("a QR failure returns null rather than throwing into the route", async () => {
  assert.equal(await upi.toQrDataUri(null), null);
  assert.equal(await upi.toQrDataUri(""), null);
});
