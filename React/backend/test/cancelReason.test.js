/**
 * A customer's cancellation may carry a reason from a fixed list; anything
 * else is ignored and the cancellation still goes through.
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

test("cancel reasons against MongoDB", async (t) => {
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
  const bookingController = require("../src/controllers/bookingController");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");
  const { dateKey } = require("../src/config/businessTime");

  const tag = `cancelreason-${Date.now()}`;
  const DAY = dateKey(new Date(Date.now() + 86400000));
  let customer = null;
  let station = null;
  let n = 0;

  const book = async () => {
    const slot = ["10:00 AM", "11:00 AM", "12:00 PM"][n++];
    const w = nozzleScheduler.computeWindow("Petrol", nozzleScheduler.parseStartDateTime(DAY, slot));
    return Booking.create({
      user: customer._id, station: station._id, fuelType: "Petrol", quantity: 5, price: 100, amount: 505,
      bookingDate: DAY, timeSlot: slot, bookingStartTime: w.start, bookingEndTime: w.end,
      payMethod: "station", paymentStatus: "due_at_station", status: "upcoming",
    });
  };
  const cancel = async (b, body) => {
    const res = fakeRes();
    await bookingController.cancelBooking(
      { params: { id: String(b._id) }, user: { id: String(customer._id) }, body, app: { get: () => null } },
      res,
    );
    return res;
  };

  try {
    customer = await User.create({ name: `${tag}-c`, email: `${tag}-c@example.com`, password: "x", role: "customer", isVerified: true });
    station = await Station.create({
      name: `${tag} Station`, address: "Cancel Reason Road", status: "Active",
      fuelTypes: ["Petrol"], prices: { petrol: 100 }, inventory: { petrol: 1000 },
    });

    await t.test("a listed reason is saved with the cancellation", async () => {
      const b = await book();
      const res = await cancel(b, { reason: "long_wait" });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      const saved = await Booking.findById(b._id).lean();
      assert.equal(saved.status, "cancelled");
      assert.equal(saved.cancelReason, "long_wait");
      assert.equal(saved.cancelledBy, "customer");
    });

    await t.test("no reason, or an unknown one: cancelled, nothing stored", async () => {
      for (const body of [undefined, { reason: "because <script>" }]) {
        const b = await book();
        const res = await cancel(b, body);
        assert.equal(res.statusCode, 200);
        const saved = await Booking.findById(b._id).lean();
        assert.equal(saved.status, "cancelled");
        assert.equal(saved.cancelReason, undefined);
      }
    });
  } finally {
    if (station) {
      await Booking.deleteMany({ station: station._id });
      await Station.deleteMany({ _id: station._id });
    }
    await User.deleteMany({ email: new RegExp(`^${tag}-`) });
    await mongoose.disconnect();
  }
});
