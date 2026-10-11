/**
 * The admin console's platform-wide reads: the customer list and the recent
 * activity feed. Both are admin-only and read-only.
 *
 * Runs against the test API (helpers/testDb apiUrl, default :5055) and the
 * test database; skipped when that server is not running.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const API = require("./helpers/testDb").apiUrl();

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

const tokenFor = (u) => jwt.sign({ user: { id: String(u._id) } }, process.env.JWT_SECRET, { expiresIn: "1h" });
const call = async (url, token) => {
  const res = await fetch(`${API}${url}`, { headers: token ? { "x-auth-token": token } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test("admin overview endpoints", async (t) => {
  try {
    const ping = await fetch(`${API}/api/health`);
    if (!ping.ok) throw new Error("no test server");
  } catch {
    t.skip(`Test API not running at ${API} (npm run test:server)`);
    return;
  }
  await mongoose.connect(require("./helpers/testDb").uri(), { serverSelectionTimeoutMS: 2500 });

  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");

  const tag = `adminview-${Date.now()}`;
  let admin = null;
  let vendor = null;
  let station = null;
  let buyer = null;
  let quiet = null;

  try {
    admin = await User.create({ name: `${tag}-a`, email: `${tag}-a@example.com`, password: "x", role: "admin", isVerified: true });
    vendor = await User.create({
      name: `${tag}-v`, email: `${tag}-v@example.com`, password: "x", role: "vendor",
      vendorStatus: "active", activated: true, businessName: `${tag} Fuels`,
    });
    buyer = await User.create({ name: `${tag}-buyer`, email: `${tag}-buyer@example.com`, password: "x", role: "customer", isVerified: true, phone: "9000000001" });
    quiet = await User.create({ name: `${tag}-quiet`, email: `${tag}-quiet@example.com`, password: "x", role: "customer", isVerified: false });
    station = await Station.create({
      name: `${tag} Station`, address: "Overview Road", owner: vendor._id, status: "Active",
      fuelTypes: ["Petrol"], prices: { petrol: 100 }, inventory: { petrol: 900 },
    });
    const w = nozzleScheduler.computeWindow("Petrol", nozzleScheduler.parseStartDateTime("2099-08-01", "10:00 AM"));
    await Booking.create({
      user: buyer._id, station: station._id, fuelType: "Petrol", quantity: 5, price: 100, amount: 505,
      bookingDate: "2099-08-01", timeSlot: "10:00 AM", bookingStartTime: w.start, bookingEndTime: w.end,
      payMethod: "station", paymentStatus: "paid", status: "completed",
      collectedAt: new Date(), collectionMethod: "cash", collectedBy: vendor._id,
    });

    await t.test("customers: admin only, with each customer's own activity", async () => {
      assert.equal((await call("/api/v1/admin/customers")).status, 401, "no token");
      assert.equal((await call("/api/v1/admin/customers", tokenFor(buyer))).status, 403, "a customer");
      assert.equal((await call("/api/v1/admin/customers", tokenFor(vendor))).status, 403, "a vendor");

      const res = await call(`/api/v1/admin/customers?search=${tag}-buyer`, tokenFor(admin));
      assert.equal(res.status, 200);
      const row = res.body.customers.find((c) => c.email === `${tag}-buyer@example.com`);
      assert.ok(row, "the customer is listed");
      assert.equal(row.bookings, 1);
      assert.equal(row.completed, 1);
      assert.equal(row.spent, 505);
      assert.equal(row.isVerified, true);
      assert.equal(row.phone, "9000000001");
      assert.ok(!("password" in row), "no password field");
      assert.ok(res.body.total >= 2, "counts every customer, not just this page");
    });

    await t.test("a customer with no bookings still appears, with zeros", async () => {
      const res = await call(`/api/v1/admin/customers?search=${tag}-quiet`, tokenFor(admin));
      const row = res.body.customers.find((c) => c.email === `${tag}-quiet@example.com`);
      assert.ok(row);
      assert.equal(row.bookings, 0);
      assert.equal(row.spent, 0);
      assert.equal(row.lastBookingAt, null);
      assert.equal(row.isVerified, false);
    });

    await t.test("activity: newest first, with bookings, payments, vendors and stations", async () => {
      assert.equal((await call("/api/v1/admin/activity")).status, 401);
      assert.equal((await call("/api/v1/admin/activity", tokenFor(buyer))).status, 403);

      const res = await call("/api/v1/admin/activity?limit=25", tokenFor(admin));
      assert.equal(res.status, 200);
      const entries = res.body.entries;
      assert.ok(Array.isArray(entries) && entries.length > 0);
      const kinds = new Set(entries.map((e) => e.kind));
      for (const kind of ["booking", "payment", "vendor", "station"]) assert.ok(kinds.has(kind), `has ${kind} entries`);
      // Sorted newest first.
      const times = entries.map((e) => new Date(e.at).getTime());
      assert.deepEqual(times, [...times].sort((a, b) => b - a));
      assert.ok(entries.some((e) => e.kind === "vendor" && e.title.includes(`${tag} Fuels`)), "this vendor's registration");
      assert.ok(entries.some((e) => e.kind === "payment" && e.detail.includes("Cash")), "the cash collection");
    });
  } finally {
    if (station) await Booking.deleteMany({ station: station._id });
    if (station) await Station.deleteMany({ _id: station._id });
    await User.deleteMany({ email: new RegExp(`^${tag}-`) });
    await mongoose.disconnect();
  }
});
