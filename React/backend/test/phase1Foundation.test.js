/**
 * Phase 1 data foundation: business time (IST), the fuel standard, slot
 * expiry, queue durations, capacity-based inventory tiers, and exactly-once
 * booking completion with stock deduction.
 *
 * Pure tests need nothing. The completion tests use MongoDB with tagged
 * throwaway fixtures, removed at the end.
 *
 *   node --test test/phase1Foundation.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const bt = require("../src/config/businessTime");
const fuels = require("../src/config/fuels");
const { getServiceDurationSeconds } = require("../src/config/fuelDurations");
const { isSlotElapsed } = require("../src/services/booking/bookingCreate");
const { classifyStock, TIERS } = require("../src/services/inventory/inventoryThreshold");

// ---------------------------------------------------------------------------
// Business time
// ---------------------------------------------------------------------------

test("dateKey: the India date, not the UTC date", () => {
  // 20:00 UTC on 1 Jun is 01:30 IST on 2 Jun.
  assert.equal(bt.dateKey(new Date("2026-06-01T20:00:00Z")), "2026-06-02");
  assert.equal(bt.dateKey(new Date("2026-06-01T18:29:59Z")), "2026-06-01");
  assert.equal(bt.dateKey(new Date("2026-06-01T18:30:00Z")), "2026-06-02");
});

test("atBusinessTime / start and end of the India day", () => {
  assert.equal(bt.atBusinessTime("2026-06-02", 0, 0).toISOString(), "2026-06-01T18:30:00.000Z");
  const at = new Date("2026-06-01T20:00:00Z");
  assert.equal(bt.startOfBusinessDay(at).toISOString(), "2026-06-01T18:30:00.000Z");
  assert.equal(bt.endOfBusinessDay(at).toISOString(), "2026-06-02T18:29:59.999Z");
  assert.equal(bt.startOfBusinessMonth(new Date("2026-06-30T19:00:00Z")).toISOString(), "2026-06-30T18:30:00.000Z");
});

test("parseClock: 12h and 24h forms; rejects nonsense", () => {
  assert.deepEqual(bt.parseClock("10:00 AM"), { hours: 10, minutes: 0 });
  assert.deepEqual(bt.parseClock("12:30 am"), { hours: 0, minutes: 30 });
  assert.deepEqual(bt.parseClock("12:00 PM"), { hours: 12, minutes: 0 });
  assert.deepEqual(bt.parseClock("18:45"), { hours: 18, minutes: 45 });
  for (const bad of ["13:00 PM", "24:00", "10:60", "noon", "", null]) assert.equal(bt.parseClock(bad), null, String(bad));
  assert.equal(bt.parseDateKey("2026-02-30"), null);
});

// ---------------------------------------------------------------------------
// Fuel standard
// ---------------------------------------------------------------------------

test("fuels: every spelling maps to one key and one label", () => {
  for (const v of ["petrol", "PETROL", " Petrol "]) {
    assert.equal(fuels.normaliseFuel(v), "petrol");
    assert.equal(fuels.fuelLabel(v), "Petrol");
  }
  assert.equal(fuels.fuelLabel("cng"), "CNG");
  assert.equal(fuels.fuelUnit("CNG"), "kg");
  assert.equal(fuels.fuelUnit("diesel"), "L");
  assert.equal(fuels.normaliseFuel("hydrogen"), null);
});

test("Booking.fuelType is stored as the canonical label and rejects unknown fuels", () => {
  const Booking = require("../src/models/Booking");
  const b = new Booking({ fuelType: "PETROL" });
  assert.equal(b.fuelType, "Petrol");
  const bad = new Booking({ fuelType: "hydrogen" });
  assert.ok(bad.validateSync()?.errors?.fuelType, "unknown fuel must fail validation");
});

test("Booking.status no longer accepts the unused legacy statuses", () => {
  const Booking = require("../src/models/Booking");
  for (const s of ["pending", "accepted", "rejected", "preparing", "on_the_way"]) {
    assert.ok(new Booking({ status: s }).validateSync()?.errors?.status, s);
  }
});

// ---------------------------------------------------------------------------
// Slot expiry in IST, with an injected clock
// ---------------------------------------------------------------------------

test("isSlotElapsed: judged in India time, whatever the server TZ", () => {
  // 9:00 AM IST slot on 2 Jun = 03:30 UTC, and it ends 30 minutes later (04:00 UTC).
  assert.equal(isSlotElapsed("2026-06-02", "9:00 AM", new Date("2026-06-02T03:45:00Z")), false);
  assert.equal(isSlotElapsed("2026-06-02", "9:00 AM", new Date("2026-06-02T04:00:01Z")), true);
  // 20:00 UTC on 1 Jun is already 2 Jun in India but well before 9 AM.
  assert.equal(isSlotElapsed("2026-06-02", "9:00 AM", new Date("2026-06-01T20:00:00Z")), false);
});

// ---------------------------------------------------------------------------
// One service-duration source
// ---------------------------------------------------------------------------

test("service durations: one source (config/fuelDurations.js)", () => {
  assert.equal(getServiceDurationSeconds("petrol"), 40);
  assert.equal(getServiceDurationSeconds("cng"), 300);
});

// ---------------------------------------------------------------------------
// Inventory tiers
// ---------------------------------------------------------------------------

test("classifyStock: tiers only against a real capacity", () => {
  assert.equal(classifyStock(50, 1000).tier, TIERS.CRITICAL);
  assert.equal(classifyStock(200, 1000).tier, TIERS.LOW);
  assert.equal(classifyStock(900, 1000).tier, TIERS.NORMAL);
  assert.equal(classifyStock(900, null).tier, TIERS.UNKNOWN);
  assert.equal(classifyStock(900, 0).tier, TIERS.UNKNOWN);
  assert.equal(classifyStock(0, null).tier, TIERS.OUT);
});

// ---------------------------------------------------------------------------
// Completion: exactly once, stock floored at zero, status guarded
// ---------------------------------------------------------------------------

test("completeBooking against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const { completeBooking } = require("../src/services/booking/bookingCompletion");

  const tag = `phase1-${Date.now()}`;
  const station = await Station.create({
    name: `${tag}-station`,
    address: "Phase 1 Test Road",
    fuelTypes: ["Petrol", "CNG"],
    prices: { petrol: 100, cng: 80 },
    inventory: { petrol: 100, cng: 3 },
    status: "Active",
  });
  const bookingIds = [];
  const make = async (fields) => {
    const b = await Booking.create({
      user: new mongoose.Types.ObjectId(),
      station: station._id,
      fuelType: "Petrol",
      quantity: 10,
      price: 100,
      amount: 1005,
      bookingDate: "2099-01-01",
      timeSlot: "9:00 AM",
      status: "upcoming",
      ...fields,
    });
    bookingIds.push(b._id);
    return b;
  };
  const stock = async () => (await Station.findById(station._id).lean()).inventory;

  try {
    await t.test("20 concurrent completions of one booking deduct exactly once", async () => {
      const b = await make({});
      const results = await Promise.all(Array.from({ length: 20 }, () => completeBooking({ bookingId: b._id })));
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal((await stock()).petrol, 90);
      const saved = await Booking.findById(b._id).lean();
      assert.equal(saved.status, "completed");
      assert.ok(saved.inventoryDeductedAt);
      assert.ok(saved.completionTime);
    });

    await t.test("stock never goes below zero", async () => {
      const b = await make({ fuelType: "cng", quantity: 5, timeSlot: "9:30 AM" });
      assert.ok(await completeBooking({ bookingId: b._id }));
      assert.equal((await stock()).cng, 0);
    });

    await t.test("cancelled or waitlisted bookings are not completed", async () => {
      const cancelled = await make({ status: "cancelled", timeSlot: "10:00 AM" });
      const waitlisted = await make({ status: "waitlisted", timeSlot: "10:30 AM" });
      const before = (await stock()).petrol;
      assert.equal(await completeBooking({ bookingId: cancelled._id }), null);
      assert.equal(await completeBooking({ bookingId: waitlisted._id }), null);
      assert.equal((await stock()).petrol, before);
    });

    await t.test("fromStatuses narrows where completion may start; extra fields are written", async () => {
      const b = await make({ timeSlot: "11:00 AM" });
      assert.equal(await completeBooking({ bookingId: b._id, fromStatuses: ["serving"] }), null);
      const done = await completeBooking({ bookingId: b._id, set: { paymentStatus: "paid" } });
      assert.equal(done.paymentStatus, "paid");
    });
  } finally {
    await Booking.deleteMany({ _id: { $in: bookingIds } });
    await require("../src/models/InventoryMovement").deleteMany({ station: station._id });
    await Station.deleteOne({ _id: station._id });
    await mongoose.disconnect();
  }
});
