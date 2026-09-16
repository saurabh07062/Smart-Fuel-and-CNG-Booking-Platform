/**
 * Booking -> payment at the petrol pump, through the HTTP API on the TEST
 * database:
 *
 *   customer books a slot (nothing charged, owed at the pump)
 *   -> online payment is refused (switched off, config/payments.js)
 *   -> the attendant checks the customer in with the PIN: the money is
 *      collected there, and fueling starts
 *   -> fueling completes on its own; the booking stays paid; stock deducted
 *
 * Needs the API running on the test database:
 *   npm run test:server        then        node --test test/payAtPumpFlow.test.js
 * It proves the API it talks to uses this process's (test) database before
 * writing anything else.
 *
 * DEVELOPMENT TEST DATA: one tagged vendor, customer and station, removed at the end.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const testDb = require("./helpers/testDb");
const API = testDb.apiUrl();
const MONGO = testDb.uri();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, token, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "x-auth-token": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test("booking -> pay at the petrol pump -> completion", { timeout: 180_000 }, async (t) => {
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
  const BookingAttempt = require("../src/models/BookingAttempt");
  const InventoryMovement = require("../src/models/InventoryMovement");
  const Notification = require("../src/models/Notification");
  const { dateKey } = require("../src/config/businessTime");

  const tag = `paypump-${Date.now()}`;
  const tokenFor = (id) =>
    jwt.sign({ user: { id: String(id) } }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "30m" });
  const created = { users: [], stations: [] };

  try {
    // ---- the API must be on the same database as this process ----------------
    const probe = await Station.create({ name: `${tag}-probe`, address: "Probe", status: "Inactive" });
    created.stations.push(probe._id);
    if ((await call("GET", `/api/stations/${probe._id}`)).status !== 200) {
      assert.fail(`The API at ${API} is not using the test database. Start it with "npm run test:server". Nothing else was written.`);
    }

    const vendor = await User.create({
      name: `${tag}-vendor`,
      email: `${tag}-vendor@fuelmart.test`,
      password: "x",
      role: "vendor",
      vendorStatus: "active",
      activated: true,
    });
    const customer = await User.create({
      name: `${tag}-customer`,
      email: `${tag}-c@fuelmart.test`,
      password: "x",
      role: "customer",
      isVerified: true,
    });
    created.users.push(vendor._id, customer._id);
    const station = await Station.create({
      name: `${tag}-station`,
      address: "Pump Pay Road, Pune",
      owner: vendor._id,
      status: "Active",
      fuelTypes: ["Petrol"],
      prices: { petrol: 101.5 },
      inventory: { petrol: 5000 },
      tankCapacity: { petrol: 10000 },
      coordinates: { lat: 18.62, lng: 73.72 },
    });
    created.stations.push(station._id);
    const stationId = String(station._id);
    const customerToken = tokenFor(customer._id);
    const vendorToken = tokenFor(vendor._id);

    let slot = null;
    await t.test("the customer finds the station with a free slot today", async () => {
      const r = await call(
        "GET",
        "/api/stations/nearby?latitude=18.615&longitude=73.715&fuelType=PETROL&radius=5&quantity=10",
        customerToken,
      );
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const found = r.body.stations.find((s) => String(s.stationId) === stationId);
      assert.ok(found, "the station is in the results");
      if (found.canBook) slot = found.preferredSlot.slot;
      else assert.equal(found.unavailableCode, "NO_SLOT_TODAY", JSON.stringify(found));
    });

    if (!slot) {
      t.diagnostic("No bookable slot left today (India time): booking, check-in and completion not exercised in this run.");
      return;
    }

    const bookingBody = { stationId, fuelType: "Petrol", quantity: 10, bookingDate: dateKey(), timeSlot: slot };

    await t.test("online payment is switched off: refused, nothing booked or reserved", async () => {
      for (const payMethod of ["online", "upi", "card", "wallet"]) {
        const r = await call("POST", "/api/bookings", customerToken, { ...bookingBody, payMethod });
        assert.equal(r.status, 400, `${payMethod}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.reason, "ONLINE_PAYMENT_DISABLED");
      }
      assert.equal(await Booking.countDocuments({ user: customer._id }), 0);
      assert.equal((await Station.findById(stationId).lean()).inventoryCommitted?.petrol ?? 0, 0);

      const status = await call("GET", "/api/razorpay/status");
      assert.equal(status.body.onlinePaymentsEnabled, false);
      assert.equal(status.body.configured, false);
    });

    let booking;
    await t.test("the customer books to pay at the pump: owed, not paid, priced by the server", async () => {
      const r = await call("POST", "/api/bookings", customerToken, { ...bookingBody, payMethod: "station" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      booking = r.body.booking;
      assert.equal(booking.status, "upcoming");
      assert.equal(booking.payMethod, "station");
      assert.equal(booking.paymentStatus, "due_at_station");
      assert.equal(booking.price, 101.5);
      assert.equal(booking.amount, 1020, "10 L x 101.50 + 5 convenience fee");
      assert.match(booking.verificationCode, /^\d{4}$/);
      assert.equal((await Station.findById(stationId).lean()).inventoryCommitted.petrol, 10, "stock held for the booking");

      const order = await call("POST", "/api/razorpay/create-order", customerToken, { bookingId: booking._id });
      assert.equal(order.status, 503);
      assert.equal(order.body.code, "ONLINE_PAYMENT_DISABLED");
    });

    await t.test("a booking made without choosing a method is also pay-at-the-pump", async () => {
      const db = await Booking.findById(booking._id).lean();
      assert.equal(db.collectedAt, null);
      assert.equal(db.collectedBy, null);
      // The customer cannot settle it themselves: only the station checks in.
      const self = await call("POST", "/api/bookings/verify", customerToken, { verificationCode: booking.verificationCode });
      assert.equal(self.status, 403);
      assert.equal((await Booking.findById(booking._id).lean()).paymentStatus, "due_at_station");
    });

    await t.test("the vendor sees it as owed at the pump", async () => {
      const list = await call("GET", `/api/vendor-panel/stations/${stationId}/bookings`, vendorToken);
      assert.equal(list.status, 200);
      const row = list.body.find((b) => String(b._id) === String(booking._id));
      assert.ok(row, "the owning vendor sees the booking");
      assert.equal(row.paymentStatus, "due_at_station");
    });

    await t.test("PIN check-in at the pump collects the payment and starts fueling", async () => {
      const r = await call("POST", "/api/bookings/verify", vendorToken, { verificationCode: booking.verificationCode });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.booking.status, "serving");
      assert.equal(r.body.booking.paymentStatus, "paid");

      const db = await Booking.findById(booking._id).lean();
      assert.equal(db.paymentStatus, "paid");
      assert.equal(String(db.collectedBy), String(vendor._id), "collected by the attendant's account");
      assert.ok(db.collectedAt instanceof Date);
      assert.equal(db.amount, 1020, "the amount collected is the booked amount");
      assert.equal((await Station.findById(stationId).lean()).inventory.petrol, 5000, "no fuel leaves the tank before fueling completes");
    });

    await t.test("fueling completes on its own; the booking stays paid; stock is deducted once", async () => {
      let current = null;
      for (let i = 0; i < 30; i++) {
        await sleep(3000);
        current = (await call("GET", `/api/bookings/${booking._id}`, customerToken)).body;
        if (current.status === "completed") break;
      }
      assert.equal(current.status, "completed", "fueling completed");
      assert.equal(current.paymentStatus, "paid");

      const s = await Station.findById(stationId).lean();
      assert.equal(s.inventory.petrol, 4990, "the booked 10 L left the tank");
      assert.equal(s.inventoryCommitted.petrol, 0);
      assert.equal(await InventoryMovement.countDocuments({ booking: booking._id, type: "sale" }), 1);
    });
  } finally {
    const stationIds = created.stations;
    await Booking.deleteMany({ $or: [{ station: { $in: stationIds } }, { user: { $in: created.users } }] });
    await BookingAttempt.deleteMany({ user: { $in: created.users } });
    await InventoryMovement.deleteMany({ station: { $in: stationIds } });
    await Notification.deleteMany({ user: { $in: created.users } });
    await Station.deleteMany({ _id: { $in: stationIds } });
    await User.deleteMany({ $or: [{ _id: { $in: created.users } }, { email: new RegExp(`^${tag}`) }] });
    await mongoose.disconnect();
  }
});
