/**
 * Refuelling invoices.
 *
 * Pure parts (fee split, amount in words, financial year, GSTIN) always run.
 * The HTTP part needs the API on the test database:
 *   npm run test:server        then        node --test test/invoice.test.js
 *
 * DEVELOPMENT TEST DATA: tagged users, stations and bookings, removed at the end.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const testDb = require("./helpers/testDb");
const API = testDb.apiUrl();
const MONGO = testDb.uri();
const svc = require("../src/services/invoice/invoiceService");

test("fee split adds back up to the inclusive fee", () => {
  for (const fee of [5, 10, 7.5, 1, 0]) {
    const s = svc.splitInclusiveFee(fee);
    assert.equal(Math.round((s.taxable + s.cgst + s.sgst) * 100) / 100, fee);
  }
  assert.deepEqual(svc.splitInclusiveFee(5), { total: 5, taxable: 4.24, cgst: 0.38, sgst: 0.38 });
});

test("amount in words, financial year and GSTIN", () => {
  assert.match(svc.amountInWords(1020), /One Thousand Twenty/);
  assert.match(svc.amountInWords(1020.5), /Fifty Paise/);
  assert.equal(svc.financialYear(new Date("2026-04-01T06:00:00Z")), "2026-27");
  assert.equal(svc.financialYear(new Date("2027-03-31T06:00:00Z")), "2026-27");
  assert.equal(svc.normaliseGstin("27aapfu0939f1zv"), "27AAPFU0939F1ZV");
  assert.equal(svc.normaliseGstin("23AIFT1101007"), null);
});

async function call(url, token) {
  const res = await fetch(`${API}${url}`, { headers: token ? { "x-auth-token": token } : {} });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* the HTML page */
  }
  return { status: res.status, body, headers: res.headers };
}

test("invoice issue, numbering, access and verification", { timeout: 60_000 }, async (t) => {
  const reachable = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    t.skip(`Test API not reachable at ${API} -- run "npm run test:server" first`);
    return;
  }
  const mongoose = require("mongoose");
  const jwt = require("jsonwebtoken");
  await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const Invoice = require("../src/models/Invoice");
  const Counter = require("../src/models/Counter");
  const { completeBooking } = require("../src/services/booking/bookingCompletion");
  const { dateKey } = require("../src/config/businessTime");

  const tag = `invoice-${Date.now()}`;
  const tokenFor = (id) =>
    jwt.sign({ user: { id: String(id) } }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "30m" });
  const users = [];
  const stations = [];
  const mkUser = async (role, extra = {}) => {
    const u = await User.create({
      name: `${tag}-${role}-${users.length}`,
      email: `${tag}-${users.length}@fuelmart.test`,
      password: "x",
      role,
      isVerified: true,
      ...extra,
    });
    users.push(u._id);
    return u;
  };

  try {
    const probe = await Station.create({ name: `${tag}-probe`, address: "Probe", status: "Inactive" });
    stations.push(probe._id);
    if ((await call(`/api/stations/${probe._id}`)).status !== 200) {
      assert.fail(`The API at ${API} is not using the test database. Nothing else was written.`);
    }

    const vendor = await mkUser("vendor", {
      vendorStatus: "active",
      activated: true,
      businessName: "Test Fuels",
      gstNumber: "27AAPFU0939F1ZV",
    });
    const otherVendor = await mkUser("vendor", { vendorStatus: "active", activated: true });
    const customer = await mkUser("customer");
    const otherCustomer = await mkUser("customer");
    const admin = await mkUser("admin");
    const station = await Station.create({
      name: `${tag}-station`,
      address: "Invoice Road, Pune",
      owner: vendor._id,
      status: "Active",
      fuelTypes: ["Petrol"],
      prices: { petrol: 101.5 },
      inventory: { petrol: 5000 },
      tankCapacity: { petrol: 10000 },
      coordinates: { lat: 18.62, lng: 73.72 },
    });
    stations.push(station._id);

    const mkBooking = (status) =>
      Booking.create({
        user: customer._id,
        station: station._id,
        fuelType: "Petrol",
        quantity: 10,
        price: 101.5,
        amount: 1020,
        taxes: 5,
        bookingDate: dateKey(),
        timeSlot: "10:00",
        status,
      });

    // One active booking per customer: each is completed before the next exists.
    const first = await mkBooking("serving");
    let second;
    let pending;

    await t.test("completion issues the invoice, numbered in sequence", async () => {
      assert.ok(await completeBooking({ bookingId: first._id }));
      second = await mkBooking("serving");
      assert.ok(await completeBooking({ bookingId: second._id }));
      pending = await mkBooking("upcoming");
      const a = await Invoice.findOne({ booking: first._id }).lean();
      const b = await Invoice.findOne({ booking: second._id }).lean();
      assert.ok(a && b, "both invoices issued");
      assert.equal(Number(b.invoiceNo.split("/").pop()), Number(a.invoiceNo.split("/").pop()) + 1);
      assert.match(a.invoiceNo, /^FM\/[0-9A-F]{6}\/\d{4}-\d{2}\/\d{6}$/);
      assert.match(a.verifyCode, /^FM-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      assert.equal(a.amount, 1020);
      assert.equal(a.data.totals.total, 1020);
      const lineSum = a.data.lines.reduce((s, l) => s + l.total, 0);
      assert.equal(Math.round(lineSum * 100) / 100, 1020);
    });

    await t.test("issuing again returns the same invoice", async () => {
      const again = await svc.ensureInvoice(first._id);
      assert.equal(await Invoice.countDocuments({ booking: first._id }), 1);
      assert.equal(again.invoiceNo, (await Invoice.findOne({ booking: first._id })).invoiceNo);
    });

    const url = `/api/invoices/${first._id}`;
    await t.test("access: customer, owner and admin yes; others 404; signed out 401", async () => {
      for (const u of [customer, vendor, admin]) {
        assert.equal((await call(`${url}?format=json`, tokenFor(u._id))).status, 200, u.role);
      }
      for (const u of [otherCustomer, otherVendor]) {
        assert.equal((await call(url, tokenFor(u._id))).status, 404, u.role);
      }
      assert.equal((await call(url)).status, 401);
    });

    await t.test("not completed: 409", async () => {
      const r = await call(`/api/invoices/${pending._id}`, tokenFor(customer._id));
      assert.equal(r.status, 409);
      assert.equal(r.body.reason, "NOT_COMPLETED");
    });

    await t.test("the page shows the invoice details", async () => {
      const inv = await Invoice.findOne({ booking: first._id }).lean();
      const r = await call(url, tokenFor(customer._id));
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type"), /text\/html/);
      assert.match(r.headers.get("content-security-policy"), /nonce-/);
      for (const text of [inv.invoiceNo, inv.verifyCode, "Test Fuels", "27AAPFU0939F1ZV", "27101241", "998599"]) {
        assert.ok(r.body.includes(text), `page contains ${text}`);
      }
    });

    await t.test("public verification shows no personal data", async () => {
      const inv = await Invoice.findOne({ booking: first._id }).lean();
      const ok = await call(`/api/invoices/verify/${inv.verifyCode}`);
      assert.equal(ok.status, 200);
      assert.equal(ok.body.valid, true);
      assert.equal(ok.body.invoiceNo, inv.invoiceNo);
      assert.equal(ok.body.user, undefined);
      assert.equal((await call("/api/invoices/verify/FM-0000-0000-0000")).status, 404);
    });
  } finally {
    await Invoice.deleteMany({ station: { $in: stations } });
    for (const id of stations) await Counter.deleteMany({ _id: new RegExp(`^invoice:${id}:`) });
    await Booking.deleteMany({ station: { $in: stations } });
    await require("../src/models/InventoryMovement").deleteMany({ station: { $in: stations } });
    await require("../src/models/Notification").deleteMany({ user: { $in: users } });
    await Station.deleteMany({ _id: { $in: stations } });
    await User.deleteMany({ _id: { $in: users } });
    await mongoose.disconnect();
  }
});
