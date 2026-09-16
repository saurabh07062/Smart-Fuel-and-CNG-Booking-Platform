/**
 * Phase 10: delivery lead time.
 *
 * services/inventory/leadTime.js (measured from deliveries recorded with their order
 * date), the vendor inventory endpoint that records it, and the forecast
 * endpoint's choice between an entered, measured or assumed lead time.
 *
 * DEVELOPMENT TEST DATA: a tagged vendor and station (no map position) and
 * their inventory movements, removed at the end.
 *
 *   node --test test/leadTime.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { daysBetweenKeys, chooseLeadTime, LEAD_TIME } = require("../src/services/inventory/leadTime");
const { dateKey } = require("../src/config/businessTime");

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgoKey = (n) => dateKey(new Date(Date.now() - n * DAY_MS));

test("daysBetweenKeys counts India calendar days", () => {
  assert.equal(daysBetweenKeys("2026-09-01", "2026-09-04"), 3);
  assert.equal(daysBetweenKeys("2026-02-27", "2026-03-01"), 2);
  assert.equal(daysBetweenKeys("2026-09-04", "2026-09-01"), -3);
  assert.equal(daysBetweenKeys("2026-02-30", "2026-03-01"), null);
});

test("chooseLeadTime: entered beats measured beats an assumed default", () => {
  const measured = { ready: true, medianDays: 3, sdDays: 1.5 };
  assert.deepEqual(chooseLeadTime({ enteredDays: 5, measured }), { usedDays: 5, sdDays: 0, basis: "entered" });
  assert.deepEqual(chooseLeadTime({ enteredDays: 0, measured }), { usedDays: 0, sdDays: 0, basis: "entered" });
  assert.deepEqual(chooseLeadTime({ measured }), { usedDays: 3, sdDays: 1.5, basis: "measured" });
  assert.deepEqual(chooseLeadTime({ measured: { ready: false, medianDays: 4 } }), {
    usedDays: LEAD_TIME.defaultDays,
    sdDays: 0,
    basis: "assumed",
  });
});

test("lead time against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const InventoryMovement = require("../src/models/InventoryMovement");
  const { measuredLeadTime } = require("../src/services/inventory/leadTime");
  const vendorPanel = require("../src/controllers/vendorPanelController");

  const tag = `lead-${Date.now()}`;
  const vendor = await User.create({
    name: `${tag}-vendor`,
    email: `${tag}-v@example.com`,
    password: "not-a-real-hash",
    role: "vendor",
    vendorStatus: "active",
  });
  const station = await Station.create({
    name: `${tag}-station`,
    address: "Lead Time Test",
    owner: vendor._id,
    status: "Active",
    fuelTypes: ["Petrol", "CNG"],
    prices: { petrol: 100, cng: 80 },
    inventory: { petrol: 1000, cng: 100 },
  });

  const fakeRes = () => ({
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  });
  const inv = async (body) => {
    const res = fakeRes();
    await vendorPanel.updateInventory(
      { params: { id: String(station._id) }, body, user: { id: String(vendor._id), role: "vendor" }, app: { get: () => null } },
      res,
    );
    return res;
  };
  const forecastReq = async (query) => {
    const res = fakeRes();
    await vendorPanel.getForecast({ params: { id: String(station._id) }, query, user: { id: String(vendor._id), role: "vendor" } }, res);
    return res;
  };

  try {
    await t.test("orderedOn is validated: deliveries only, a real date, not after today, within 60 days", async () => {
      for (const body of [
        { fuelType: "petrol", quantity: 100, orderedOn: "2026-02-30" },
        { fuelType: "petrol", quantity: 100, orderedOn: "yesterday" },
        { fuelType: "petrol", quantity: 100, orderedOn: daysAgoKey(-1) },
        { fuelType: "petrol", quantity: 100, orderedOn: daysAgoKey(61) },
        { fuelType: "petrol", quantity: 900, action: "set", orderedOn: daysAgoKey(2) },
        { fuelType: "petrol", capacity: 5000, orderedOn: daysAgoKey(2) },
      ]) {
        const res = await inv(body);
        assert.equal(res.statusCode, 400, JSON.stringify(body));
      }
      assert.equal(await InventoryMovement.countDocuments({ station: station._id }), 0, "nothing recorded from a rejected request");
    });

    await t.test("before any measured delivery, the forecast's lead time is an assumed default, said so", async () => {
      const res = await forecastReq({ fuel: "petrol" });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.leadTime.basis, "assumed");
      assert.equal(res.body.leadTime.usedDays, LEAD_TIME.defaultDays);
      assert.equal(res.body.leadTime.measured.samples, 0);
      assert.equal(res.body.reorder.leadTimeBasis, "assumed");
    });

    await t.test("deliveries record their lead time; one without an order date is counted but not measured", async () => {
      const lead = [2, 3, 5];
      for (const days of lead) {
        const res = await inv({ fuelType: "Petrol", quantity: 200, orderedOn: daysAgoKey(days), note: `order ${days}` });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(res.body.deliveryLeadTimeDays, days);
      }
      assert.equal((await inv({ fuelType: "petrol", quantity: 50 })).statusCode, 200);
      await inv({ fuelType: "cng", quantity: 20, orderedOn: daysAgoKey(9) });

      const m = await measuredLeadTime(station._id, "petrol");
      assert.equal(m.ready, true);
      assert.equal(m.samples, 3);
      assert.equal(m.deliveries, 4);
      assert.equal(m.deliveriesWithoutOrderDate, 1);
      assert.equal(m.medianDays, 3);
      assert.equal(m.meanDays, 3.33);
      assert.equal(m.sdDays, 1.53);
      assert.ok(m.deliveryIntervalMedianDays < 1, "reported separately from lead time");

      const cng = await measuredLeadTime(station._id, "cng");
      assert.equal(cng.samples, 1);
      assert.equal(cng.ready, false, "one CNG delivery is not enough to rely on");

      const history = fakeRes();
      await vendorPanel.getInventoryMovements(
        { params: { id: String(station._id) }, query: { fuel: "petrol" }, user: { id: String(vendor._id), role: "vendor" } },
        history,
      );
      const withLead = history.body.filter((row) => row.leadTimeDays !== null);
      assert.deepEqual(withLead.map((row) => row.leadTimeDays).sort(), [2, 3, 5]);
      assert.ok(withLead.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.orderedOn)));
    });

    await t.test("the forecast uses the measured median and spread, unless a lead time is entered", async () => {
      let res = await forecastReq({ fuel: "petrol" });
      assert.equal(res.body.leadTime.basis, "measured");
      assert.equal(res.body.leadTime.usedDays, 3);
      assert.equal(res.body.leadTime.sdDays, 1.53);
      assert.equal(res.body.reorder.leadTimeDays, 3);
      assert.equal(res.body.reorder.leadTimeSdDays, 1.53);

      res = await forecastReq({ fuel: "petrol", leadTimeDays: "6" });
      assert.equal(res.body.leadTime.basis, "entered");
      assert.equal(res.body.reorder.leadTimeDays, 6);
      assert.equal(res.body.reorder.leadTimeSdDays, 0);
      assert.equal(res.body.leadTime.measured.medianDays, 3, "the measurement is still shown for comparison");

      res = await forecastReq({ fuel: "cng" });
      assert.equal(res.body.leadTime.basis, "assumed", "CNG has only one measured delivery");
    });
  } finally {
    await InventoryMovement.deleteMany({ station: station._id });
    await Station.deleteOne({ _id: station._id });
    await User.deleteOne({ _id: vendor._id });
    await mongoose.disconnect();
  }
});
