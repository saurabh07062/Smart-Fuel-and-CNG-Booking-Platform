/**
 * Clearing one fuel's inventory at a station: stock, tank capacity and the
 * whole stock history go, but only for that fuel, only for the owner, and
 * never while bookings still hold stock.
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

test("inventory reset against MongoDB", async (t) => {
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
  const InventoryMovement = require("../src/models/InventoryMovement");
  const vendorPanel = require("../src/controllers/vendorPanelController");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");

  const tag = `invreset-${Date.now()}`;
  const stationIds = [];
  let vendor = null;
  let other = null;
  let customer = null;

  const makeStation = async () => {
    const s = await Station.create({
      name: `${tag} Station ${stationIds.length}`,
      address: "Reset Road",
      owner: vendor._id,
      status: "Active",
      fuelTypes: ["Petrol", "Diesel"],
      prices: { petrol: 100, diesel: 90 },
      inventory: { petrol: 4000, diesel: 2500 },
      inventoryCommitted: { petrol: 20, diesel: 0 },
      tankCapacity: { petrol: 10000, diesel: 5000 },
    });
    stationIds.push(s._id);
    for (const fuel of ["petrol", "diesel"]) {
      await InventoryMovement.create([
        { station: s._id, fuel, type: "delivery", quantity: 1000, stockAfter: 4000, unit: "L" },
        // A sale belongs to one booking: the database allows only one per booking.
        { station: s._id, fuel, type: "sale", quantity: -5, stockAfter: 3995, unit: "L", booking: new mongoose.Types.ObjectId() },
      ]);
    }
    return s;
  };
  const reset = async (station, fuel, user = vendor) => {
    const res = fakeRes();
    await vendorPanel.resetInventory(
      { params: { id: String(station._id), fuel }, user: { id: String(user._id), role: user.role }, app: { get: () => null } },
      res,
    );
    return res;
  };

  try {
    vendor = await User.create({ name: `${tag}-v`, email: `${tag}-v@example.com`, password: "x", role: "vendor", vendorStatus: "active", activated: true });
    other = await User.create({ name: `${tag}-o`, email: `${tag}-o@example.com`, password: "x", role: "vendor", vendorStatus: "active", activated: true });
    customer = await User.create({ name: `${tag}-c`, email: `${tag}-c@example.com`, password: "x", role: "customer", isVerified: true });

    await t.test("clears that fuel's stock, capacity and history, and leaves the other fuel alone", async () => {
      const s = await makeStation();
      const res = await reset(s, "Petrol");
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.historyRemoved, 2);
      assert.match(res.body.msg, /Petrol inventory cleared/);

      const after = await Station.findById(s._id).lean();
      assert.equal(after.inventory.petrol, 0);
      assert.equal(after.inventoryCommitted.petrol, 0);
      assert.equal(after.tankCapacity.petrol, null);
      assert.equal(await InventoryMovement.countDocuments({ station: s._id, fuel: "petrol" }), 0);

      // Diesel untouched.
      assert.equal(after.inventory.diesel, 2500);
      assert.equal(after.tankCapacity.diesel, 5000);
      assert.equal(await InventoryMovement.countDocuments({ station: s._id, fuel: "diesel" }), 2);
    });

    await t.test("refused while a booking still holds that fuel's stock", async () => {
      const s = await makeStation();
      const w = nozzleScheduler.computeWindow("Petrol", nozzleScheduler.parseStartDateTime("2099-07-01", "10:00 AM"));
      const booking = await Booking.create({
        user: customer._id, station: s._id, fuelType: "Petrol", quantity: 5, price: 100, amount: 505,
        bookingDate: "2099-07-01", timeSlot: "10:00 AM", bookingStartTime: w.start, bookingEndTime: w.end,
        payMethod: "station", paymentStatus: "due_at_station", status: "upcoming",
      });

      const res = await reset(s, "petrol");
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.reason, "ACTIVE_BOOKINGS");
      assert.equal(res.body.activeBookings, 1);
      const after = await Station.findById(s._id).lean();
      assert.equal(after.inventory.petrol, 4000, "nothing removed");
      assert.equal(await InventoryMovement.countDocuments({ station: s._id, fuel: "petrol" }), 2);

      // That booking's fuel is the only one blocked: diesel still clears.
      assert.equal((await reset(s, "diesel")).statusCode, 200);
      await Booking.deleteOne({ _id: booking._id });
    });

    await t.test("another vendor cannot clear this station, and an unknown fuel is refused", async () => {
      const s = await makeStation();
      assert.equal((await reset(s, "petrol", other)).statusCode, 404);
      assert.equal((await reset(s, "kerosene")).statusCode, 400);
      assert.equal((await Station.findById(s._id).lean()).inventory.petrol, 4000);
    });
  } finally {
    await InventoryMovement.deleteMany({ station: { $in: stationIds } });
    await Booking.deleteMany({ station: { $in: stationIds } });
    await Station.deleteMany({ _id: { $in: stationIds } });
    await User.deleteMany({ email: new RegExp(`^${tag}-`) });
    await mongoose.disconnect();
  }
});
