/**
 * Real booking -> UI -> revenue, through the HTTP API and Socket.IO on the TEST
 * database (npm run test:server, then this file):
 *
 *   customer books (saved in MongoDB, delivered live to the customer and vendor)
 *   -> vendor starts fuelling -> fill completes on its own -> still owed at the pump,
 *      NOT revenue (awaiting collection)
 *   -> vendor records the payment -> revenue counts it, live event to both sides
 *   -> repeating the collection does not count it again
 *   -> a PIN check-in (payment taken at the pump) counts once its fill completes
 *   -> a cancelled booking is never revenue
 *   -> 5 simultaneous collections record one payment
 *   -> reports, customers and the admin dashboard read the same numbers, and a
 *      fresh GET (a page refresh) returns the same stored bookings
 *
 * DEVELOPMENT TEST DATA: tagged vendor, customers and station, removed at the end.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const testDb = require("./helpers/testDb");
const API = testDb.apiUrl();
const MONGO = testDb.uri();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round(n * 100) / 100;

async function call(method, url, token, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "x-auth-token": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function waitFor(fn, ms, label) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for: ${label}`);
    await sleep(500);
  }
}

test("booking -> payment -> revenue, end to end", { timeout: 240_000 }, async (t) => {
  const reachable = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) }).then((r) => r.ok).catch(() => false);
  if (!reachable) {
    t.skip(`Test API not reachable at ${API} -- run "npm run test:server" first`);
    return;
  }

  const mongoose = require("mongoose");
  const jwt = require("jsonwebtoken");
  const { io } = require("socket.io-client");
  await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });

  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const BookingAttempt = require("../src/models/BookingAttempt");
  const InventoryMovement = require("../src/models/InventoryMovement");
  const Notification = require("../src/models/Notification");
  const PriceHistory = require("../src/models/PriceHistory");
  const { dateKey } = require("../src/config/businessTime");

  const tag = `revenue-${Date.now()}`;
  const tokenFor = (id) => jwt.sign({ user: { id: String(id) } }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "30m" });
  const created = { users: [], stations: [] };
  const sockets = [];

  try {
    const probe = await Station.create({ name: `${tag}-probe`, address: "Probe", status: "Inactive" });
    created.stations.push(probe._id);
    if ((await call("GET", `/api/stations/${probe._id}`)).status !== 200) assert.fail("the API is not on the test database");

    const mk = (suffix, extra) => User.create({ name: `${tag}-${suffix}`, email: `${tag}-${suffix}@fuelmart.test`, password: "x", isVerified: true, ...extra });
    const admin = await mk("admin", { role: "admin" });
    const vendor = await mk("vendor", { role: "vendor", vendorStatus: "active", activated: true });
    const [cA, cB, cC, cD] = await Promise.all(["a", "b", "c", "d"].map((s) => mk(s, { role: "customer" })));
    created.users.push(admin._id, vendor._id, cA._id, cB._id, cC._id, cD._id);
    const vt = tokenFor(vendor._id);

    const st = await call("POST", "/api/vendor-panel/stations", vt, {
      name: `${tag}-station`,
      address: "Revenue Road, Pune",
      fuelTypes: ["Petrol", "Diesel", "CNG"],
      prices: { petrol: 104, diesel: 92.5, cng: 88 },
      inventory: { petrol: 5000, diesel: 5000, cng: 800 },
      tankCapacity: { petrol: 10000, diesel: 10000, cng: 1000 },
      coordinates: { lat: 18.57, lng: 73.79 },
    });
    assert.equal(st.status, 201, JSON.stringify(st.body));
    const stationId = String(st.body._id);
    created.stations.push(stationId);

    const firstSlot = async (fuel, token) => {
      const r = await call("GET", `/api/bookings/availability?stationId=${stationId}&fuelType=${fuel}&date=${dateKey()}`, token);
      return (r.body.slots || []).find((s) => s.bookable)?.label || null;
    };
    const petrolSlot = await firstSlot("Petrol", tokenFor(cA._id));
    const dieselSlot = await firstSlot("Diesel", tokenFor(cB._id));
    const cngSlot = await firstSlot("CNG", tokenFor(cC._id));
    if (!petrolSlot || !dieselSlot || !cngSlot) {
      t.diagnostic("No bookable slot left today (India time): the live flow was not exercised in this run.");
      return;
    }

    // ---- sockets, connected before anything happens ----------------------------------
    const events = { customerA: [], vendor: [], admin: [], customerB: [] };
    const connect = (token, bucket) =>
      new Promise((resolve, reject) => {
        const s = io(API, { auth: { token }, reconnection: false, transports: ["websocket"] });
        sockets.push(s);
        s.on("connect", () => resolve(s));
        s.on("connect_error", reject);
        s.onAny((event, p) => bucket.push({ event, id: String(p?._id || ""), status: p?.status, paymentStatus: p?.paymentStatus }));
        setTimeout(() => reject(new Error("socket timeout")), 5000);
      });
    await connect(tokenFor(cA._id), events.customerA);
    await connect(vt, events.vendor);
    await connect(tokenFor(admin._id), events.admin);
    await connect(tokenFor(cB._id), events.customerB);

    const vendorRevenue = async () => (await call("GET", "/api/vendor-panel/revenue", vt)).body;
    const heard = (bucket, id, pred) => bucket.some((e) => e.id === String(id) && pred(e));

    let A;
    let expected = 0;

    await t.test("a new vendor starts at ₹0 with nothing awaiting collection", async () => {
      const r = await vendorRevenue();
      assert.equal(r.todaysRevenue, 0);
      assert.equal(r.monthlyRevenue, 0);
      assert.equal(r.allTimeRevenue, 0);
      assert.deepEqual(r.awaitingCollection, { count: 0, amount: 0 });
      assert.equal(r.profit, undefined, "no estimated profit is reported");
    });

    await t.test("booking A is saved in MongoDB and reaches the customer and vendor live", async () => {
      const r = await call("POST", "/api/bookings", tokenFor(cA._id), {
        stationId, fuelType: "Petrol", quantity: 1, bookingDate: dateKey(), timeSlot: petrolSlot, payMethod: "station", vehiclePlate: "MH12AB1234",
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      A = r.body.booking;
      const stored = await Booking.findById(A._id).lean();
      assert.ok(stored, "stored in MongoDB");
      assert.equal(stored.amount, round2(104 * 1 + (stored.taxes || 0)), "amount = price x quantity + fee");
      assert.equal(stored.paymentStatus, "due_at_station");

      await waitFor(() => heard(events.customerA, A._id, (e) => e.event === "booking:created"), 5000, "customer booking:created");
      await waitFor(() => heard(events.vendor, A._id, (e) => e.event === "booking:created"), 5000, "vendor booking:created");
      assert.equal(heard(events.customerB, A._id, () => true), false, "another customer hears nothing");

      const mine = await call("GET", "/api/bookings", tokenFor(cA._id));
      assert.ok(mine.body.some((b) => String(b._id) === String(A._id) && b.vehiclePlate === "MH12AB1234" && b.amount === stored.amount));
      const vendorList = await call("GET", `/api/vendor-panel/stations/${stationId}/bookings`, vt);
      assert.ok(vendorList.body.some((b) => String(b._id) === String(A._id) && b.paymentStatus === "due_at_station"), "vendor sees the same booking");
    });

    await t.test("fuelled but not collected: completed, still owed, not revenue", async () => {
      const start = await call("PATCH", `/api/vendor-panel/stations/${stationId}/bookings/${A._id}/status`, vt, { status: "serving" });
      assert.equal(start.status, 200, JSON.stringify(start.body));
      const done = await waitFor(async () => {
        const b = await Booking.findById(A._id).lean();
        return b.status === "completed" ? b : null;
      }, 60_000, "booking A completes on its own");
      assert.equal(done.paymentStatus, "due_at_station", "completing does not mark it paid");
      assert.equal(done.collectedAt, null);

      const r = await vendorRevenue();
      assert.equal(r.todaysRevenue, 0);
      assert.equal(r.transactions.today, 0);
      assert.deepEqual(r.awaitingCollection, { count: 1, amount: done.amount });
      await waitFor(() => heard(events.customerA, A._id, (e) => e.status === "completed"), 5000, "customer hears completion");
    });

    await t.test("recording the payment makes it revenue once, live to customer and vendor", async () => {
      const collect = await call("PATCH", `/api/vendor-panel/stations/${stationId}/bookings/${A._id}/collect`, vt);
      assert.equal(collect.status, 200, JSON.stringify(collect.body));
      assert.equal(collect.body.alreadyPaid, false);
      const stored = await Booking.findById(A._id).lean();
      assert.equal(stored.paymentStatus, "paid");
      assert.equal(String(stored.collectedBy), String(vendor._id));
      assert.ok(stored.collectedAt);
      expected = stored.amount;

      await waitFor(() => heard(events.customerA, A._id, (e) => e.paymentStatus === "paid"), 5000, "customer hears paid");
      await waitFor(() => heard(events.vendor, A._id, (e) => e.paymentStatus === "paid"), 5000, "vendor hears paid");

      const r = await vendorRevenue();
      assert.equal(r.todaysRevenue, expected);
      assert.equal(r.transactions.today, 1);
      assert.deepEqual(r.awaitingCollection, { count: 0, amount: 0 });
      assert.equal(r.fuelSales.Petrol.quantity, 1);

      const again = await call("PATCH", `/api/vendor-panel/stations/${stationId}/bookings/${A._id}/collect`, vt);
      assert.equal(again.status, 200);
      assert.equal(again.body.alreadyPaid, true);
      const r2 = await vendorRevenue();
      assert.equal(r2.todaysRevenue, expected, "a repeated collection is not counted twice");
      assert.equal(r2.transactions.today, 1);
    });

    let B;
    await t.test("a PIN check-in takes the payment, and counts as revenue only once the fill completes", async () => {
      const r = await call("POST", "/api/bookings", tokenFor(cB._id), {
        stationId, fuelType: "Diesel", quantity: 1, bookingDate: dateKey(), timeSlot: dieselSlot, payMethod: "station",
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      B = r.body.booking;
      const scan = await call("POST", "/api/bookings/verify", vt, { verificationCode: B.verificationCode });
      assert.equal(scan.status, 200, JSON.stringify(scan.body));
      assert.equal(scan.body.booking.paymentStatus, "paid");

      const whileFuelling = await vendorRevenue();
      assert.equal(whileFuelling.todaysRevenue, expected, "a fill still in progress is not revenue yet");

      const done = await waitFor(async () => {
        const b = await Booking.findById(B._id).lean();
        return b.status === "completed" ? b : null;
      }, 60_000, "booking B completes");
      assert.equal(done.paymentStatus, "paid");
      expected = round2(expected + done.amount);
      const after = await vendorRevenue();
      assert.equal(after.todaysRevenue, expected);
      assert.equal(after.transactions.today, 2);
    });

    await t.test("a cancelled booking is never revenue", async () => {
      const r = await call("POST", "/api/bookings", tokenFor(cC._id), {
        stationId, fuelType: "CNG", quantity: 1, bookingDate: dateKey(), timeSlot: cngSlot, payMethod: "station",
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const cancel = await call("PATCH", `/api/vendor-panel/stations/${stationId}/bookings/${r.body.booking._id}/status`, vt, { status: "cancelled" });
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
      const notCollectable = await call("PATCH", `/api/vendor-panel/stations/${stationId}/bookings/${r.body.booking._id}/collect`, vt);
      assert.equal(notCollectable.status, 409, "a cancelled booking cannot be collected");
      const rev = await vendorRevenue();
      assert.equal(rev.todaysRevenue, expected);
      assert.equal(rev.awaitingCollection.count, 0);
    });

    await t.test("5 simultaneous collections of one booking record a single payment", async () => {
      const D = await Booking.create({
        user: cD._id, station: stationId, fuelType: "Petrol", quantity: 2, price: 104, taxes: 5, amount: 213,
        bookingDate: dateKey(), timeSlot: petrolSlot, payMethod: "station", paymentStatus: "due_at_station",
        status: "completed", completionTime: new Date(),
      });
      const results = await Promise.all(
        Array.from({ length: 5 }, () => call("PATCH", `/api/vendor-panel/stations/${stationId}/bookings/${D._id}/collect`, vt)),
      );
      assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
      assert.equal(results.filter((r) => r.body.alreadyPaid === false).length, 1, "exactly one request recorded it");
      expected = round2(expected + 213);
      const rev = await vendorRevenue();
      assert.equal(rev.todaysRevenue, expected);
      assert.equal(rev.transactions.today, 3);
    });

    await t.test("dashboard, reports, customers and admin read the same source of truth", async () => {
      const dash = (await call("GET", "/api/vendor-panel/dashboard", vt)).body;
      assert.equal(dash.todaysRevenue, expected);
      assert.equal(dash.todaysTransactions, 3);
      assert.deepEqual(dash.awaitingCollection, { count: 0, amount: 0 });

      const reports = (await call("GET", "/api/vendor-panel/reports", vt)).body;
      const perf = reports.stationPerformance.find((s) => String(s.stationId) === stationId);
      assert.equal(perf.revenue, expected);
      assert.equal(perf.completedTransactions, 3);

      const customers = (await call("GET", "/api/vendor-panel/customers", vt)).body;
      const spent = (u) => customers.find((c) => String(c.user._id) === String(u._id))?.totalSpent ?? 0;
      assert.equal(spent(cA), (await Booking.findById(A._id).lean()).amount);
      assert.equal(spent(cC), 0, "the cancelled booking's customer spent nothing");

      const adminDash = await call("GET", "/api/v1/admin/dashboard", tokenFor(admin._id));
      assert.equal(adminDash.status, 200, JSON.stringify(adminDash.body));
      assert.ok(adminDash.body.revenue.today.revenue >= expected, "network revenue includes this station's real transactions");
      assert.ok(adminDash.body.revenue.today.transactions >= 3);
      assert.equal(typeof adminDash.body.today.bookings, "number");
      assert.ok(adminDash.body.fuelStock && adminDash.body.liveQueue);
    });

    await t.test("a page refresh reads the same stored bookings", async () => {
      const mine = (await call("GET", "/api/bookings", tokenFor(cA._id))).body;
      const a = mine.find((b) => String(b._id) === String(A._id));
      assert.equal(a.status, "completed");
      assert.equal(a.paymentStatus, "paid");
      const vendorList = (await call("GET", `/api/vendor-panel/stations/${stationId}/bookings`, vt)).body;
      const paid = vendorList.filter((b) => b.status === "completed" && b.paymentStatus === "paid");
      assert.equal(round2(paid.reduce((s, b) => s + b.amount, 0)), expected, "the listed paid bookings add up to the revenue shown");
    });
  } finally {
    sockets.forEach((s) => s.close());
    const ids = created.stations;
    await Booking.deleteMany({ $or: [{ station: { $in: ids } }, { user: { $in: created.users } }] });
    await BookingAttempt.deleteMany({ user: { $in: created.users } });
    await InventoryMovement.deleteMany({ station: { $in: ids } });
    await PriceHistory.deleteMany({ station: { $in: ids } });
    await Notification.deleteMany({ user: { $in: created.users } });
    await Station.deleteMany({ _id: { $in: ids } });
    await User.deleteMany({ email: new RegExp(`^${tag}-`) });
    await mongoose.disconnect();
  }
});
