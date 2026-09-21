/**
 * Booking integrity, end to end against the running API and MongoDB.
 *
 * Replaces test/booking-race.test.js, which exercised the retired
 * POST /api/v1/slots/book path. Everything here goes through the one real
 * booking endpoint, POST /api/bookings.
 *
 * DEVELOPMENT TEST DATA: every user, station and booking below is created
 * with a unique tag on a far-future date and removed at the end.
 *
 *   node --test test/bookingIntegrity.test.js   (needs the API running)
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const API = require("./helpers/testDb").apiUrl();
const MONGO = require("./helpers/testDb").uri();

async function ping() {
  try {
    const r = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

const tokenFor = (u) => jwt.sign({ user: { id: String(u._id) } }, process.env.JWT_SECRET, { expiresIn: "1h" });

async function call(method, url, token, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "x-auth-token": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test("booking integrity through POST /api/bookings", async (t) => {
  if (!(await ping())) {
    t.skip(`API not reachable at ${API} — start the stack to run this test`);
    return;
  }
  await mongoose.connect(MONGO);

  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const BookingAttempt = require("../src/models/BookingAttempt");
  const SecurityEvent = require("../src/models/SecurityEvent");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");

  const tag = `integrity-${Date.now()}`;
  const date = "2099-06-01";

  const [vendor, otherVendor] = await User.insertMany(
    ["vendor", "vendor2"].map((n) => ({
      name: `${tag}-${n}`,
      email: `${tag}-${n}@example.com`,
      password: "not-a-real-hash",
      role: "vendor",
      vendorStatus: "active",
      activated: true,
      isVerified: true,
    })),
  );
  const customers = await User.insertMany(
    Array.from({ length: 14 }, (_, i) => ({
      name: `${tag}-c${i}`,
      email: `${tag}-c${i}@example.com`,
      password: "not-a-real-hash",
      role: "customer",
      isVerified: true,
    })),
  );
  const station = await Station.create({
    name: `${tag}-station`,
    address: "Integrity Test Road, Pune",
    owner: vendor._id,
    coordinates: { lat: 18.52, lng: 73.85 },
    fuelTypes: ["Petrol", "CNG"],
    prices: { petrol: 100, diesel: 90, cng: 80 },
    inventory: { petrol: 50, diesel: 0, cng: 1000 },
    status: "Active",
  });

  const book = (customer, overrides = {}) =>
    call("POST", "/api/bookings", tokenFor(customer), {
      stationId: String(station._id),
      fuelType: "Petrol",
      quantity: 5,
      bookingDate: date,
      timeSlot: "9:00 AM",
      payMethod: "station",
      ...overrides,
    });

  try {
    await t.test("the server prices the booking; client price, taxes and amount are ignored", async () => {
      const r = await book(customers[0], { price: 1, taxes: 0, amount: 1 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.booking.price, 100);
      assert.equal(r.body.booking.taxes, 5);
      assert.equal(r.body.booking.amount, 505);
      assert.match(r.body.booking.verificationCode, /^\d{4}$/);
    });

    await t.test("times that are not bookable slot labels are rejected", async () => {
      for (const timeSlot of ["9:07 AM", "18:45-19:00", ""]) {
        const r = await book(customers[1], { timeSlot });
        assert.equal(r.status, 400, timeSlot);
        assert.equal(r.body.reason, "INVALID_SLOT");
      }
    });

    await t.test("stock is checked net of already-committed bookings", async () => {
      // 50 L petrol in stock, 5 L already booked above: 46 L cannot fit.
      const r = await book(customers[1], { quantity: 46, timeSlot: "3:00 PM" });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.reason, "INSUFFICIENT_STOCK");
    });

    await t.test("10 customers racing for one CNG window: it fills to capacity (6), never beyond, never overlapping", async () => {
      const racers = customers.slice(2, 12);
      const results = await Promise.all(racers.map((c) => book(c, { fuelType: "CNG", quantity: 5, timeSlot: "10:00 AM" })));

      const ok = results.filter((r) => r.status === 200);
      const refused = results.filter((r) => ["SLOT_FULL", "NOZZLE_BUSY"].includes(r.body.reason));
      const persisted = await Booking.countDocuments({ station: station._id, bookingDate: date, timeSlot: "10:00 AM", status: "upcoming" });

      console.log(`\n  10 concurrent: ${ok.length} confirmed, ${refused.length} refused, db upcoming=${persisted}\n`);
      // floor(1800 s / 300 s) = 6 CNG fills fit the window on its one CNG nozzle.
      assert.equal(persisted, ok.length, "every confirmed booking is stored, nothing else");
      assert.ok(ok.length >= 1 && ok.length <= 6, `${ok.length} confirmed: never more than the window holds`);
      const spans = (await Booking.find({ station: station._id, bookingDate: date, timeSlot: "10:00 AM", status: "upcoming" }).lean())
        .map((b) => [new Date(b.bookingStartTime).getTime(), new Date(b.bookingEndTime).getTime()])
        .sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] >= spans[i - 1][1], "no two overlap on the CNG nozzle");
      assert.equal(ok.length + refused.length, racers.length, "every request gets a definite answer");
    });

    await t.test("the database refuses a second active booking at the same start, even bypassing the lock", async () => {
      const start = nozzleScheduler.parseStartDateTime(date, "10:00 AM");
      const window = nozzleScheduler.computeWindow("cng", start);
      const duplicate = {
        user: customers[13]._id,
        station: station._id,
        fuelType: "CNG",
        quantity: 5,
        price: 80,
        amount: 405,
        bookingDate: date,
        timeSlot: "10:00 AM",
        bookingStartTime: window.start,
        bookingEndTime: window.end,
      };
      await assert.rejects(Booking.create({ ...duplicate, status: "upcoming" }), (err) => err.code === 11000);
      // A cancelled row is outside the guard, so history is never blocked.
      const cancelled = await Booking.create({ ...duplicate, status: "cancelled" });
      assert.ok(cancelled._id);
    });

    await t.test("rapid repeated attempts are blocked by the risk engine and logged", async () => {
      const spammer = customers[12];
      const early = [];
      for (let i = 0; i < 7; i++) early.push(await book(spammer, { fuelType: "CNG", timeSlot: "10:00 AM" }));
      assert.ok(early.every((r) => r.body.reason === "SLOT_FULL"), JSON.stringify(early.map((r) => r.body.reason)));

      const blocked = await book(spammer, { fuelType: "CNG", timeSlot: "10:00 AM" });
      assert.equal(blocked.status, 429, JSON.stringify(blocked.body));
      assert.equal(blocked.body.reason, "RISK_BLOCKED");
      assert.ok(Array.isArray(blocked.body.reasons) && blocked.body.reasons.length >= 2);

      const attempts = await BookingAttempt.countDocuments({ user: spammer._id });
      assert.equal(attempts, 8, "every attempt, including rejected ones, is recorded");
      assert.equal(await SecurityEvent.countDocuments({ user: spammer._id, action: "blocked" }), 1);
    });

    await t.test("the retired /api/v1/slots/book endpoint cannot create bookings", async () => {
      const r = await call("POST", "/api/v1/slots/book", tokenFor(customers[13]), {
        stationId: String(station._id),
        fuelType: "petrol",
        quantity: 5,
        bookingDate: date,
        timeSlot: "11:00 AM",
      });
      assert.equal(r.status, 410);
      assert.equal(await Booking.countDocuments({ user: customers[13]._id, status: "upcoming" }), 0);
    });

    await t.test("verification requires an owning vendor and today's live booking", async () => {
      const today = require("../src/config/businessTime").dateKey();
      const petrolBefore = (await Station.findById(station._id).lean()).inventory.petrol;
      const start = new Date(Date.now() + 60 * 60_000);
      const todays = await Booking.create({
        user: customers[13]._id,
        station: station._id,
        fuelType: "Petrol",
        quantity: 5,
        price: 100,
        taxes: 5,
        amount: 505,
        bookingDate: today,
        timeSlot: "11:30 PM",
        bookingStartTime: start,
        bookingEndTime: new Date(start.getTime() + 40_000),
        payMethod: "station",
        paymentStatus: "due_at_station",
        verificationCode: "4821",
        status: "upcoming",
      });

      assert.equal((await call("POST", "/api/bookings/verify", null, { verificationCode: "4821" })).status, 401, "anonymous");
      assert.equal((await call("POST", "/api/bookings/verify", tokenFor(customers[0]), { verificationCode: "4821" })).status, 403, "a customer");
      assert.equal((await call("POST", "/api/bookings/verify", tokenFor(otherVendor), { verificationCode: "4821" })).status, 404, "another station's vendor");
      assert.equal((await call("POST", "/api/bookings/verify", tokenFor(vendor), { verificationCode: "0000" })).status, 404, "wrong code");

      const future = await Booking.findOne({ station: station._id, bookingDate: date, status: "upcoming" });
      const notToday = await call("POST", "/api/bookings/verify", tokenFor(vendor), { bookingId: String(future._id) });
      assert.equal(notToday.status, 409, "a booking for another day cannot be completed today");

      const ok = await call("POST", "/api/bookings/verify", tokenFor(vendor), { verificationCode: "4821" });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const checkedIn = await Booking.findById(todays._id);
      assert.equal(checkedIn.status, "serving", "scanning at the pump is the check-in: fueling starts");
      assert.ok(checkedIn.arrivalTime && checkedIn.fuelingStartTime);
      assert.equal(checkedIn.paymentStatus, "paid");
      assert.equal(String(checkedIn.collectedBy), String(vendor._id));
      assert.equal(
        (await Station.findById(station._id).lean()).inventory.petrol,
        petrolBefore,
        "no fuel leaves stock until fueling completes",
      );

      const again = await call("POST", "/api/bookings/verify", tokenFor(vendor), { bookingId: String(todays._id) });
      assert.equal(again.status, 409, "a booking cannot be checked in twice");

      const done = await call("PATCH", `/api/vendor-panel/stations/${station._id}/bookings/${todays._id}/status`, tokenFor(vendor), {
        status: "completed",
      });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      const saved = await Booking.findById(todays._id);
      assert.equal(saved.status, "completed");
      assert.ok(saved.inventoryDeductedAt, "completion is stamped as deducted");
      assert.equal(
        (await Station.findById(station._id).lean()).inventory.petrol,
        petrolBefore - 5,
        "completing the fueling takes the fuel out of stock",
      );

      const afterDone = await call("POST", "/api/bookings/verify", tokenFor(vendor), { bookingId: String(todays._id) });
      assert.equal(afterDone.status, 409, "a completed booking cannot be checked in");
    });
  } finally {
    const userIds = [vendor, otherVendor, ...customers].map((u) => u._id);
    await Booking.deleteMany({ station: station._id });
    await BookingAttempt.deleteMany({ user: { $in: userIds } });
    await SecurityEvent.deleteMany({ user: { $in: userIds } });
    // Bookings made through the API notify the station's vendor.
    await require("../src/models/Notification").deleteMany({ user: { $in: userIds } });
    await require("../src/models/InventoryMovement").deleteMany({ station: station._id });
    await Station.deleteOne({ _id: station._id });
    await User.deleteMany({ _id: { $in: userIds } });
    await mongoose.disconnect();
  }
});
