/**
 * Coverage for the Vendor Management System pieces added in this pass:
 * services/inventory/inventoryThreshold.js, services/vendor/vendorScoring.js (pure, no DB),
 * and the ownership-scoping fix in controllers/vendorPanelController.js
 * (integration, real DB) that stops one vendor from reading or modifying
 * another vendor's station through the vendor-panel API.
 *
 * Follows the same pattern as test/newServices.test.js: pure functions run
 * with no DB, the controller behaviour connects to MongoDB with tagged,
 * throwaway fixtures and cleans up unconditionally afterwards.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const {
  TIERS,
  classifyStock,
  classifyStationInventory,
} = require("../src/services/inventory/inventoryThreshold");
const {
  completenessScore,
  priorityScore,
  performanceScore,
} = require("../src/services/vendor/vendorScoring");

// ---------------------------------------------------------------------------
// inventoryThreshold: pure percentage-of-capacity classification.
// ---------------------------------------------------------------------------

test("classifyStock: zero or negative stock is out of stock regardless of capacity", () => {
  assert.equal(classifyStock(0, 10000).tier, TIERS.OUT);
  assert.equal(classifyStock(-5, 10000).tier, TIERS.OUT);
});

test("classifyStock: tiers follow percentage of capacity, not an absolute number", () => {
  // 400/5000 = 8% -> critical, even though 400 alone would look "fine"
  // against petrol/diesel's flat-2000 threshold this replaces.
  assert.equal(classifyStock(400, 5000).tier, TIERS.CRITICAL);
  // 1000/5000 = 20% -> low.
  assert.equal(classifyStock(1000, 5000).tier, TIERS.LOW);
  // 4000/5000 = 80% -> normal.
  assert.equal(classifyStock(4000, 5000).tier, TIERS.NORMAL);
});

test("classifyStock: boundary values land on the documented side", () => {
  // Values chosen to divide evenly so rounding can't shift them across a boundary.
  assert.equal(classifyStock(900, 10000).tier, TIERS.CRITICAL); // 9% < 10%
  assert.equal(classifyStock(1000, 10000).tier, TIERS.LOW); // exactly 10%, not < 10
  assert.equal(classifyStock(2400, 10000).tier, TIERS.LOW); // 24% < 25%
  assert.equal(classifyStock(2500, 10000).tier, TIERS.NORMAL); // exactly 25%, not < 25
});

test("classifyStock: no recorded capacity is 'capacity_unset', never an assumed percentage", () => {
  const r = classifyStock(500, null);
  assert.equal(r.percent, null);
  assert.equal(r.tier, TIERS.UNKNOWN);
  // Empty is still knowable without a capacity.
  assert.equal(classifyStock(0, null).tier, TIERS.OUT);
});

test("classifyStationInventory: only classifies fuels the station actually sells", () => {
  const station = {
    fuelTypes: ["Petrol"],
    inventory: { petrol: 200, diesel: 200, cng: 200 },
  };
  const result = classifyStationInventory(station);
  assert.deepEqual(Object.keys(result), ["petrol"]);
});

test("classifyStationInventory: each fuel is judged against its own recorded tank", () => {
  const station = {
    fuelTypes: ["Petrol", "Diesel", "CNG"],
    inventory: { petrol: 1200, diesel: 1200, cng: 1200 },
    tankCapacity: { petrol: 20000, diesel: null, cng: 1500 },
  };
  const result = classifyStationInventory(station);
  assert.equal(result.petrol.tier, TIERS.CRITICAL); // 6%
  assert.equal(result.cng.tier, TIERS.NORMAL); // 80%
  assert.equal(result.diesel.tier, TIERS.UNKNOWN); // no tank recorded
  assert.equal(result.diesel.percent, null);
  assert.equal(result.cng.unit, "kg");
  assert.equal(result.petrol.unit, "L");
});

// ---------------------------------------------------------------------------
// vendorScoring: pure arithmetic over plain vendor/station objects.
// ---------------------------------------------------------------------------

test("completenessScore: an empty application scores 0", () => {
  assert.equal(completenessScore(null), 0);
  assert.equal(completenessScore({}), 0);
});

test("completenessScore: all text fields filled but no station caps out well short of 100", () => {
  const vendor = {
    businessName: "Sharma Fuels",
    gstNumber: "GST123",
    phone: "9999999999",
    vendorAddress: "MG Road",
    vendorDescription: "A fuel station",
    logoFile: "logo.png",
    licenseFile: "lic.pdf",
    gstFile: "gst.pdf",
  };
  const score = completenessScore(vendor, []);
  assert.equal(score, 60, "text fields are worth 60% of the score; no station means the other 40% is unearned");
});

test("completenessScore: a fully set up application (fields + station) scores 100", () => {
  const vendor = {
    businessName: "Sharma Fuels",
    gstNumber: "GST123",
    phone: "9999999999",
    vendorAddress: "MG Road",
    vendorDescription: "A fuel station",
    logoFile: "logo.png",
    licenseFile: "lic.pdf",
    gstFile: "gst.pdf",
  };
  const station = { coordinates: { lat: 18.5, lng: 73.8 }, fuelTypes: ["Petrol"] };
  assert.equal(completenessScore(vendor, [station]), 100);
});

test("priorityScore: a longer-waiting application scores higher at equal completeness", () => {
  const vendor = { businessName: "X" };
  const now = new Date("2026-06-01");
  const freshlySubmitted = { ...vendor, createdAt: new Date("2026-05-30") };
  const longWaiting = { ...vendor, createdAt: new Date("2026-04-01") };

  const freshScore = priorityScore(freshlySubmitted, [], now).score;
  const oldScore = priorityScore(longWaiting, [], now).score;
  assert.ok(oldScore > freshScore, "an application waiting since April should outrank one submitted two days ago");
});

test("priorityScore: waiting time caps at 30 days so an ancient application doesn't dominate forever", () => {
  const vendor = { businessName: "X" };
  const now = new Date("2026-06-01");
  const at30Days = { ...vendor, createdAt: new Date("2026-05-02") };
  const at90Days = { ...vendor, createdAt: new Date("2026-03-03") };

  const score30 = priorityScore(at30Days, [], now).score;
  const score90 = priorityScore(at90Days, [], now).score;
  assert.equal(score30, score90, "past the 30-day cap, additional waiting time must not keep raising the score");
});

test("performanceScore: at equal revenue, a poor completion rate drags the score down", () => {
  const reliable = performanceScore({
    revenue: 20000,
    completedBookings: 19,
    totalBookings: 20,
    maxRevenue: 20000,
  });
  const unreliable = performanceScore({
    revenue: 20000,
    completedBookings: 4,
    totalBookings: 20,
    maxRevenue: 20000,
  });
  assert.equal(reliable.completionRate, 0.95);
  assert.equal(unreliable.completionRate, 0.2);
  assert.ok(
    reliable.score > unreliable.score,
    "identical revenue but a much better completion rate must score higher",
  );
});

test("performanceScore: revenue is the heaviest-weighted component", () => {
  const bigRevenuePoorCompletion = performanceScore({
    revenue: 20000,
    completedBookings: 4,
    totalBookings: 20,
    maxRevenue: 20000,
  });
  const smallRevenuePerfectCompletion = performanceScore({
    revenue: 5000,
    completedBookings: 20,
    totalBookings: 20,
    maxRevenue: 20000,
  });
  assert.ok(
    bigRevenuePoorCompletion.score > smallRevenuePerfectCompletion.score,
    "the platform's biggest earner should still lead even with a weak completion rate",
  );
});

test("performanceScore: a brand new vendor with no outcome data yet isn't penalised for it", () => {
  const brandNew = performanceScore({ revenue: 0, completedBookings: 0, totalBookings: 0, maxRevenue: 10000 });
  assert.equal(brandNew.completionRate, null);
  assert.ok(Number.isFinite(brandNew.score));
});

test("performanceScore: ratings are not part of the score (no invented neutral rating)", () => {
  const metrics = { revenue: 10000, completedBookings: 9, totalBookings: 10, maxRevenue: 20000 };
  const base = performanceScore(metrics);
  assert.equal(base.score, performanceScore({ ...metrics, avgRating: 1 }).score);
  assert.equal(base.score, 0.5 * 65 + 0.9 * 35);
});

// ---------------------------------------------------------------------------
// Integration: vendorPanelController ownership scoping against a real DB.
// ---------------------------------------------------------------------------

const MONGO = require("./helpers/testDb").uri();

/** Minimal Express res double, same shape test/newServices.test.js uses for middleware. */
function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("vendorPanelController: ownership scoping", async (t) => {
  let app = false;
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
    app = true;
  } catch (err) {
    t.skip(`MongoDB not reachable at ${MONGO} - skipping ownership-scoping coverage: ${err.message}`);
    return;
  }

  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const vendorPanel = require("../src/controllers/vendorPanelController");

  const tag = `vpc-${Date.now()}`;
  const vendorA = await User.create({
    name: `${tag}-vendorA`,
    email: `${tag}-a@example.com`,
    password: "not-a-real-hash",
    role: "vendor",
    vendorStatus: "active",
  });
  const vendorB = await User.create({
    name: `${tag}-vendorB`,
    email: `${tag}-b@example.com`,
    password: "not-a-real-hash",
    role: "vendor",
    vendorStatus: "active",
  });

  const stationA = await Station.create({
    name: `${tag}-stationA`,
    address: "Road A",
    owner: vendorA._id,
    fuelTypes: ["Petrol", "Diesel", "CNG"],
    prices: { petrol: 100, diesel: 90, cng: 80 },
    inventory: { petrol: 300, diesel: 10000, cng: 5000 }, // petrol: 3% -> critical
    tankCapacity: { petrol: 10000, diesel: 10000, cng: 5000 },
    status: "Active",
  });
  const stationB = await Station.create({
    name: `${tag}-stationB`,
    address: "Road B",
    owner: vendorB._id,
    fuelTypes: ["Petrol", "Diesel", "CNG"],
    prices: { petrol: 100, diesel: 90, cng: 80 },
    inventory: { petrol: 10000, diesel: 10000, cng: 5000 },
    tankCapacity: { petrol: 10000, diesel: 10000, cng: 5000 },
    status: "Active",
  });

  const createdIds = { users: [vendorA._id, vendorB._id], stations: [stationA._id, stationB._id] };
  // fake req.app.get('io') used by emitStationEvent -- absent app is fine, it no-ops via try/catch.
  const baseReq = { app: { get: () => null } };

  await t.test("getMyStations: a vendor only sees their own stations", async () => {
    const req = { ...baseReq, user: { id: String(vendorA._id), role: "vendor" } };
    const res = fakeRes();
    await vendorPanel.getMyStations(req, res);
    const names = res.body.map((s) => s.name);
    assert.ok(names.includes(stationA.name));
    assert.ok(!names.includes(stationB.name), "vendor A must not see vendor B's station in the list");
  });

  await t.test("updateFuelPrice: a vendor CAN update their own station's price", async () => {
    const req = {
      ...baseReq,
      user: { id: String(vendorA._id), role: "vendor" },
      params: { id: String(stationA._id) },
      body: { fuelType: "petrol", newPrice: 105.5 },
    };
    const res = fakeRes();
    await vendorPanel.updateFuelPrice(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.station.prices.petrol, 105.5);
  });

  await t.test("updateFuelPrice: a vendor CANNOT update another vendor's station price", async () => {
    const req = {
      ...baseReq,
      user: { id: String(vendorA._id), role: "vendor" },
      params: { id: String(stationB._id) },
      body: { fuelType: "petrol", newPrice: 1 },
    };
    const res = fakeRes();
    await vendorPanel.updateFuelPrice(req, res);
    assert.equal(res.statusCode, 404, "cross-vendor price update must be rejected as not found, not applied");

    const reloaded = await Station.findById(stationB._id).select("prices");
    assert.equal(reloaded.prices.petrol, 100, "station B's price must be unchanged after the rejected attempt");
  });

  await t.test("updateFuelPrice: rejects a negative or non-numeric price", async () => {
    const req = {
      ...baseReq,
      user: { id: String(vendorA._id), role: "vendor" },
      params: { id: String(stationA._id) },
      body: { fuelType: "petrol", newPrice: -10 },
    };
    const res = fakeRes();
    await vendorPanel.updateFuelPrice(req, res);
    assert.equal(res.statusCode, 400);
  });

  await t.test("updateInventory: a vendor CANNOT modify another vendor's inventory", async () => {
    const req = {
      ...baseReq,
      user: { id: String(vendorA._id), role: "vendor" },
      params: { id: String(stationB._id) },
      body: { fuelType: "diesel", quantity: 0, action: "set" },
    };
    const res = fakeRes();
    await vendorPanel.updateInventory(req, res);
    assert.equal(res.statusCode, 404);

    const reloaded = await Station.findById(stationB._id).select("inventory");
    assert.equal(reloaded.inventory.diesel, 10000, "station B's inventory must be unchanged after the rejected attempt");
  });

  await t.test("updateInventory: rejects a negative quantity", async () => {
    const req = {
      ...baseReq,
      user: { id: String(vendorA._id), role: "vendor" },
      params: { id: String(stationA._id) },
      body: { fuelType: "diesel", quantity: -50, action: "set" },
    };
    const res = fakeRes();
    await vendorPanel.updateInventory(req, res);
    assert.equal(res.statusCode, 400);
  });

  await t.test("getInventoryAlerts: only surfaces the requesting vendor's own low-stock fuels", async () => {
    const req = { ...baseReq, user: { id: String(vendorA._id), role: "vendor" } };
    const res = fakeRes();
    await vendorPanel.getInventoryAlerts(req, res);
    const stationIds = res.body.map((a) => String(a.stationId));
    assert.ok(stationIds.includes(String(stationA._id)), "vendor A's own critical petrol stock must be alerted");
    assert.ok(!stationIds.includes(String(stationB._id)), "vendor A must never see vendor B's inventory alerts");
    const petrolAlert = res.body.find((a) => String(a.stationId) === String(stationA._id) && a.fuelType === "Petrol");
    assert.equal(petrolAlert.tier, "critical");
    assert.equal(petrolAlert.unit, "L");
  });

  await t.test("updateInventory: records a tank capacity and refuses stock beyond it", async () => {
    const asA = (body) => ({
      ...baseReq,
      user: { id: String(vendorA._id), role: "vendor" },
      params: { id: String(stationA._id) },
      body,
    });

    let res = fakeRes();
    await vendorPanel.updateInventory(asA({ fuelType: "Petrol", capacity: 1000 }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.tankCapacity.petrol, 1000);
    assert.equal(res.body.inventory.petrol, 300, "a capacity-only update leaves stock alone");
    assert.equal(res.body.status.petrol.percent, 30);

    res = fakeRes();
    await vendorPanel.updateInventory(asA({ fuelType: "petrol", quantity: 800 }), res);
    assert.equal(res.statusCode, 409, "300 + 800 exceeds a 1000 L tank");
    assert.equal(res.body.reason, "EXCEEDS_CAPACITY");
    assert.equal((await Station.findById(stationA._id).lean()).inventory.petrol, 300);

    res = fakeRes();
    await vendorPanel.updateInventory(asA({ fuelType: "PETROL", quantity: 700 }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.inventory.petrol, 1000);

    res = fakeRes();
    await vendorPanel.updateInventory(asA({ fuelType: "petrol", capacity: 900 }), res);
    assert.equal(res.statusCode, 409, "a tank cannot be recorded smaller than the stock in it");

    res = fakeRes();
    await vendorPanel.updateInventory(asA({ fuelType: "petrol" }), res);
    assert.equal(res.statusCode, 400, "neither quantity nor capacity");
  });

  await t.test("getMyStations: returns the server-computed inventory status", async () => {
    const res = fakeRes();
    await vendorPanel.getMyStations({ ...baseReq, user: { id: String(vendorA._id), role: "vendor" } }, res);
    const a = res.body.find((s) => s.name === stationA.name);
    assert.ok(a.inventoryStatus?.petrol, JSON.stringify(a));
    assert.equal(a.inventoryStatus.petrol.capacity, 1000);
  });

  await t.test("createStation: no invented prices, stock, amenities or (0,0) position", async () => {
    const res = fakeRes();
    await vendorPanel.createStation(
      { ...baseReq, user: { id: String(vendorA._id), role: "vendor" }, body: { name: `${tag}-new`, address: "Road C", prices: { petrol: 101 } } },
      res,
    );
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    createdIds.stations.push(res.body._id);
    const s = await Station.findById(res.body._id).lean();
    assert.equal(s.prices.petrol, 101);
    assert.equal(s.prices.diesel, null);
    assert.equal(s.inventory.petrol, 0);
    assert.equal(s.tankCapacity.petrol, null);
    assert.deepEqual(s.amenities, []);
    assert.equal(s.location, undefined);
    assert.equal(s.coordinates, undefined);
  });

  await t.test("an admin CAN update any vendor's station (admin override)", async () => {
    const req = {
      ...baseReq,
      user: { id: "000000000000000000000000", role: "admin" },
      params: { id: String(stationB._id) },
      body: { fuelType: "diesel", newPrice: 91 },
    };
    const res = fakeRes();
    await vendorPanel.updateFuelPrice(req, res);
    assert.equal(res.statusCode, 200, "an admin token must be able to manage any station");
    assert.equal(res.body.station.prices.diesel, 91);
  });

  await t.test("updateStation: a vendor CANNOT rename another vendor's station", async () => {
    const req = {
      ...baseReq,
      user: { id: String(vendorA._id), role: "vendor" },
      params: { id: String(stationB._id) },
      body: { name: "Hijacked Name" },
    };
    const res = fakeRes();
    await vendorPanel.updateStation(req, res);
    assert.equal(res.statusCode, 404);

    const reloaded = await Station.findById(stationB._id).select("name");
    assert.equal(reloaded.name, stationB.name, "station B's name must be unchanged after the rejected attempt");
  });

  // --- cleanup: unconditional, so a failed assertion never leaves fixtures behind ---
  await require("../src/models/InventoryMovement").deleteMany({ station: { $in: createdIds.stations } });
  await require("../src/models/PriceHistory").deleteMany({ station: { $in: createdIds.stations } });
  await Station.deleteMany({ _id: { $in: createdIds.stations } });
  await User.deleteMany({ _id: { $in: createdIds.users } });
  await mongoose.disconnect();
});
