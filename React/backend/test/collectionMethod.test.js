/**
 * Collecting a pay-at-the-pump payment records HOW it was paid: cash, or UPI
 * scanned at the pump. The method is required and validated.
 * Runs against the test database (helpers/testDb) only.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

const fakeRes = () => ({
  statusCode: 200,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
  send(b) { this.body = b; return this; },
});

test("collection method against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const vendorPanel = require("../src/controllers/vendorPanelController");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");

  const tag = `collectmethod-${Date.now()}`;
  const DAY = "2099-04-01";
  let vendor = null;
  const stationIds = [];
  let n = 0;

  // One customer and one station per booking: a customer may hold only one
  // active booking, and a nozzle serves one car at a time.
  const book = async (status) => {
    const i = n++;
    const station = await Station.create({
      name: `${tag} Station ${i}`, address: "Collect Road", owner: vendor._id, status: "Active",
      fuelTypes: ["Petrol"], prices: { petrol: 100 }, inventory: { petrol: 1000 },
    });
    stationIds.push(station._id);
    const slot = ["10:00 AM", "10:30 AM", "11:00 AM", "11:30 AM", "12:00 PM", "12:30 PM", "1:00 PM"][i];
    const customer = await User.create({ name: `${tag}-c${i}`, email: `${tag}-c${i}@example.com`, password: "x", role: "customer", isVerified: true });
    const w = nozzleScheduler.computeWindow("Petrol", nozzleScheduler.parseStartDateTime(DAY, slot));
    return Booking.create({
      user: customer._id, station: station._id, fuelType: "Petrol", quantity: 5, price: 100, amount: 505,
      bookingDate: DAY, timeSlot: slot, bookingStartTime: w.start, bookingEndTime: w.end,
      payMethod: "station", paymentStatus: "due_at_station", status,
    });
  };
  const collect = async (b, body) => {
    const res = fakeRes();
    await vendorPanel.collectBookingPayment(
      {
        params: { stationId: String(b.station), bookingId: String(b._id) },
        user: { id: String(vendor._id), role: "vendor" },
        body,
        app: { get: () => null },
      },
      res,
    );
    return res;
  };

  try {
    vendor = await User.create({ name: `${tag}-v`, email: `${tag}-v@example.com`, password: "x", role: "vendor", vendorStatus: "active", activated: true });

    await t.test("no method, or an unknown one: refused, still owed", async () => {
      const b = await book("serving");
      let res = await collect(b, {});
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.reason, "METHOD_REQUIRED");
      res = await collect(b, { method: "cheque" });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.reason, "METHOD_INVALID");
      const saved = await Booking.findById(b._id).lean();
      assert.equal(saved.paymentStatus, "due_at_station");
      assert.equal(saved.collectionMethod ?? null, null);
    });

    await t.test("cash is recorded, once", async () => {
      const b = await book("serving");
      const res = await collect(b, { method: "Cash" });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.match(res.body.msg, /Cash/);
      const saved = await Booking.findById(b._id).lean();
      assert.equal(saved.paymentStatus, "paid");
      assert.equal(saved.collectionMethod, "cash");
      assert.equal(String(saved.collectedBy), String(vendor._id));
      // A second tap does not change the method.
      const again = await collect(b, { method: "upi" });
      assert.equal(again.body.alreadyPaid, true);
      assert.equal((await Booking.findById(b._id).lean()).collectionMethod, "cash");
    });

    await t.test("online (UPI at the pump) is recorded on a completed fill", async () => {
      const b = await book("completed");
      const res = await collect(b, { method: "upi" });
      assert.equal(res.statusCode, 200);
      assert.match(res.body.msg, /Online \(UPI\)/);
      assert.equal((await Booking.findById(b._id).lean()).collectionMethod, "upi");
    });

    await t.test("a checked-in car still waiting for the nozzle can be collected", async () => {
      const b = await book("upcoming");
      await Booking.updateOne({ _id: b._id }, { $set: { arrivalTime: new Date() } });
      const res = await collect(b, { method: "upi" });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal((await Booking.findById(b._id).lean()).collectionMethod, "upi");
    });

    await t.test("a car not yet at the pump cannot be collected", async () => {
      const b = await book("upcoming");
      const res = await collect(b, { method: "cash" });
      assert.equal(res.statusCode, 409);
      assert.equal((await Booking.findById(b._id).lean()).paymentStatus, "due_at_station");
    });

    await t.test("complete-and-collect without a method changes nothing", async () => {
      const b = await book("serving");
      const res = fakeRes();
      await vendorPanel.updateBookingStatus(
        {
          params: { stationId: String(b.station), bookingId: String(b._id) },
          user: { id: String(vendor._id), role: "vendor" },
          body: { status: "completed", collectPayment: true },
          app: { get: () => null },
        },
        res,
      );
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.reason, "METHOD_REQUIRED");
      const saved = await Booking.findById(b._id).lean();
      assert.equal(saved.status, "serving");
      assert.equal(saved.paymentStatus, "due_at_station");
    });
  } finally {
    await Booking.deleteMany({ station: { $in: stationIds } });
    await Station.deleteMany({ _id: { $in: stationIds } });
    await User.deleteMany({ email: new RegExp(`^${tag}-`) });
    await mongoose.disconnect();
  }
});
