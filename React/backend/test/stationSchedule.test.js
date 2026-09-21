/**
 * Vendor slot timings: PATCH /api/vendor-panel/stations/:id/schedule saves the
 * opening hours per day, and the customer booking slots follow them.
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

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const every = (hours) => Object.fromEntries(DAYS.map((d) => [d, { ...hours }]));

test("vendor slot timings against MongoDB", async (t) => {
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
  const { atBusinessTime, dateKey } = require("../src/config/businessTime");

  const tag = `schedule-${Date.now()}`;
  const DATE = "2099-03-10"; // a Tuesday, far from "now"
  let vendor = null;
  let other = null;
  let customer = null;
  let station = null;

  const patch = async (body, user = vendor) => {
    const res = fakeRes();
    await vendorPanel.updateSchedule({ params: { id: String(station._id) }, user: { id: String(user._id), role: user.role }, body }, res);
    return res;
  };
  const openLabels = async () => {
    const fresh = await Station.findById(station._id).lean();
    const rows = await nozzleScheduler.generateAvailability(station._id, "petrol", DATE, {
      station: fresh,
      now: atBusinessTime("2099-03-09", 12, 0),
    });
    return rows.filter((r) => r.reason !== "CLOSED").map((r) => r.label);
  };

  try {
    vendor = await User.create({ name: `${tag}-v`, email: `${tag}-v@example.com`, password: "x", role: "vendor", vendorStatus: "active", activated: true });
    other = await User.create({ name: `${tag}-o`, email: `${tag}-o@example.com`, password: "x", role: "vendor", vendorStatus: "active", activated: true });
    customer = await User.create({ name: `${tag}-c`, email: `${tag}-c@example.com`, password: "x", role: "customer", isVerified: true });
    station = await Station.create({
      name: `${tag} Station`,
      address: "Schedule Test Road",
      owner: vendor._id,
      status: "Active",
      fuelTypes: ["Petrol"],
      prices: { petrol: 100 },
      inventory: { petrol: 1000 },
    });

    await t.test("a new station is open 24 hours: slots run round the clock", async () => {
      const labels = await openLabels();
      assert.equal(labels.length, 48);
      assert.equal(labels[0], "12:00 AM");
      assert.equal(labels.at(-1), "11:30 PM");
    });

    await t.test("set hours: slots only while open, and the card label follows", async () => {
      const res = await patch(every({ is24h: false, isClosed: false, open: "08:00", close: "20:00" }));
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.openingHours, "08:00 - 20:00");
      const labels = await openLabels();
      assert.equal(labels[0], "8:00 AM");
      assert.equal(labels.at(-1), "7:30 PM", "the last slot starts before closing");
      assert.equal(labels.length, 24);
    });

    await t.test("closed on one day: no slots that day, 'Varies by day' on the card", async () => {
      const res = await patch({ ...every({ is24h: true, isClosed: false, open: "06:00", close: "22:00" }), tuesday: { isClosed: true, is24h: false, open: "06:00", close: "22:00" } });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.openingHours, "Varies by day");
      assert.deepEqual(await openLabels(), []);
    });

    await t.test("bad input is refused and nothing changes", async () => {
      const before = await Station.findById(station._id).lean();
      assert.equal((await patch(every({ is24h: false, isClosed: false, open: "20:00", close: "08:00" }))).statusCode, 400);
      assert.equal((await patch(every({ is24h: false, isClosed: false, open: "8am", close: "20:00" }))).statusCode, 400);
      const { monday, ...missingMonday } = every({ is24h: true, isClosed: false, open: "06:00", close: "22:00" });
      assert.ok(monday);
      assert.equal((await patch(missingMonday)).statusCode, 400);
      const after = await Station.findById(station._id).lean();
      assert.deepEqual(after.operatingSchedule, before.operatingSchedule);
    });

    await t.test("another vendor's station and a customer are refused", async () => {
      const body = every({ is24h: true, isClosed: false, open: "06:00", close: "22:00" });
      assert.equal((await patch(body, other)).statusCode, 404);
      assert.equal((await patch(body, customer)).statusCode, 404);
    });

    await t.test("upcoming bookings outside the new hours are kept and counted", async () => {
      const day = dateKey(new Date(Date.now() + 86400000));
      const start = nozzleScheduler.parseStartDateTime(day, "11:00 PM");
      const w = nozzleScheduler.computeWindow("Petrol", start);
      const booking = await Booking.create({
        user: customer._id, station: station._id, fuelType: "Petrol", quantity: 5, price: 100, amount: 505,
        bookingDate: day, timeSlot: "11:00 PM", bookingStartTime: w.start, bookingEndTime: w.end,
        payMethod: "station", paymentStatus: "due_at_station", status: "upcoming",
      });
      const res = await patch(every({ is24h: false, isClosed: false, open: "06:00", close: "22:00" }));
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.outsideHours, 1);
      assert.equal((await Booking.findById(booking._id).lean()).status, "upcoming", "not cancelled");
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
