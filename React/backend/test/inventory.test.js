/**
 * Phase 8: inventory.
 *
 * services/inventory/stockLedger.js -- the reservation guard, exactly-once release on
 * cancel / expiry / no-show, sales on completion, delivery and count records,
 * low-stock alerts on tier crossings, commitment reconciliation -- and the
 * vendor endpoints that expose it.
 *
 * DEVELOPMENT TEST DATA: tagged users/stations without a map position and
 * bookings on 2099 dates (plus one past-dated for expiry), all removed.
 * Services are called directly, so no email is sent.
 *
 *   node --test test/inventory.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("inventory against MongoDB", async (t) => {
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
  const BookingAttempt = require("../src/models/BookingAttempt");
  const InventoryMovement = require("../src/models/InventoryMovement");
  const Notification = require("../src/models/Notification");
  const ledger = require("../src/services/inventory/stockLedger");
  const { completeBooking } = require("../src/services/booking/bookingCompletion");
  const { transitionBooking } = require("../src/services/booking/bookingTransitions");
  const { createCustomerBooking, expireUserPastBookings } = require("../src/services/booking/bookingCreate");
  const vendorPanel = require("../src/controllers/vendorPanelController");
  await Promise.all([Booking.init(), InventoryMovement.init(), Notification.init()]);

  const tag = `inv-${Date.now()}`;
  const vendor = await User.create({
    name: `${tag}-vendor`,
    email: `${tag}-vendor@example.com`,
    password: "not-a-real-hash",
    role: "vendor",
    vendorStatus: "active",
  });
  const customers = await User.insertMany(
    Array.from({ length: 14 }, (_, i) => ({
      name: `${tag}-c${i}`,
      email: `${tag}-c${i}@example.com`,
      password: "not-a-real-hash",
      role: "customer",
      isVerified: true,
    })),
  );
  const userIds = [vendor._id, ...customers.map((c) => c._id)];
  const stationIds = [];
  const makeStation = async (name, fields = {}) => {
    const s = await Station.create({
      name: `${tag}-${name}`,
      address: "Inventory Test",
      owner: vendor._id,
      status: "Active",
      fuelTypes: ["Petrol", "CNG"],
      prices: { petrol: 100, cng: 80 },
      inventory: { petrol: 100, cng: 100 },
      ...fields,
    });
    stationIds.push(s._id);
    return s;
  };
  const stationDoc = async (s) => Station.findById(s._id).lean();
  const LABELS = ["6:00 AM", "6:30 AM", "7:00 AM", "7:30 AM", "8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "11:00 AM", "11:30 AM", "12:00 PM", "12:30 PM"];
  const bookBody = (station, i, quantity, date = "2099-11-01") => ({
    stationId: String(station._id),
    fuelType: "Petrol",
    quantity,
    bookingDate: date,
    timeSlot: LABELS[i],
    payMethod: "station",
  });
  const fakeRes = () => ({
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  });
  const vendorReq = (params, body = {}, query = {}) => ({
    params,
    body,
    query,
    user: { id: String(vendor._id), role: "vendor" },
    app: { get: () => null },
  });

  try {
    await t.test("reserveStock is the database guard: 30 racing requests for 5 L each, 100 L in stock -> 20", async () => {
      const s = await makeStation("race");
      const results = await Promise.all(Array.from({ length: 30 }, () => ledger.reserveStock(s._id, "petrol", 5)));
      assert.equal(results.filter(Boolean).length, 20);
      assert.equal((await stationDoc(s)).inventoryCommitted.petrol, 100);
      assert.equal(await ledger.reserveStock(s._id, "Petrol", 1), false, "nothing left to book");
      assert.equal((await stationDoc(s)).inventory.petrol, 100, "reserving never touches the tank");
    });

    await t.test("booking creation reserves; 14 customers for 10 L each from 100 L -> exactly 10 bookings", async () => {
      const s = await makeStation("book");
      const results = await Promise.allSettled(
        customers.map((c, i) => createCustomerBooking({ user: { id: String(c._id) }, body: bookBody(s, i, 10) })),
      );
      const ok = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r) => r.status === "rejected");
      assert.equal(ok.length, 10, JSON.stringify(refused.map((r) => r.reason?.reason)));
      assert.ok(refused.every((r) => r.reason.reason === "INSUFFICIENT_STOCK"));
      assert.equal((await stationDoc(s)).inventoryCommitted.petrol, 100);
      assert.ok(ok.every((r) => r.value.stockReserved === true));

      // Leave the customers free for later subtests.
      for (const r of ok) await transitionBooking({ bookingId: r.value._id, to: "cancelled" });
      assert.equal((await stationDoc(s)).inventoryCommitted.petrol, 0, "every cancellation gave its stock back");
    });

    await t.test("a release happens once, however many paths try", async () => {
      const s = await makeStation("release");
      const b = await createCustomerBooking({ user: { id: String(customers[0]._id) }, body: bookBody(s, 0, 30) });
      assert.equal((await stationDoc(s)).inventoryCommitted.petrol, 30);

      await transitionBooking({ bookingId: b._id, to: "cancelled" });
      assert.equal(await ledger.releaseReservation(b._id), false);
      assert.equal(await ledger.releaseStaleReservations({ _id: b._id }), 0);
      assert.equal((await stationDoc(s)).inventoryCommitted.petrol, 0);
    });

    await t.test("a live booking is never released", async () => {
      const s = await makeStation("live");
      const b = await createCustomerBooking({ user: { id: String(customers[1]._id) }, body: bookBody(s, 1, 20) });
      assert.equal(await ledger.releaseReservation(b._id), false);
      assert.equal((await stationDoc(s)).inventoryCommitted.petrol, 20);
      await transitionBooking({ bookingId: b._id, to: "cancelled" });
    });

    await t.test("completion takes the fuel from the tank and the commitment together, and records the sale", async () => {
      const s = await makeStation("sale");
      const b = await createCustomerBooking({ user: { id: String(customers[2]._id) }, body: bookBody(s, 2, 25) });
      const done = await completeBooking({ bookingId: b._id });
      assert.equal(done.stockReserved, false);

      const after = await stationDoc(s);
      assert.equal(after.inventory.petrol, 75);
      assert.equal(after.inventoryCommitted.petrol, 0);
      const sale = await InventoryMovement.findOne({ booking: b._id }).lean();
      assert.equal(sale.type, "sale");
      assert.equal(sale.quantity, -25);
      assert.equal(sale.stockAfter, 75);

      assert.equal(await completeBooking({ bookingId: b._id }), null, "a second completion changes nothing");
      assert.equal((await stationDoc(s)).inventory.petrol, 75);
    });

    await t.test("expiry gives stock back (bulk path)", async () => {
      const s = await makeStation("expiry");
      const b = await createCustomerBooking({ user: { id: String(customers[3]._id) }, body: bookBody(s, 3, 40) });
      assert.equal((await stationDoc(s)).inventoryCommitted.petrol, 40);
      // Move it into the past, as if its day had passed.
      await Booking.updateOne({ _id: b._id }, { $set: { bookingDate: "2020-01-01" } });
      await expireUserPastBookings(customers[3]._id);
      assert.equal((await Booking.findById(b._id).lean()).status, "expired");
      assert.equal((await stationDoc(s)).inventoryCommitted.petrol, 0);
    });

    await t.test("low-stock alerts fire on crossing into a worse tier, once each", async () => {
      const s = await makeStation("alerts", {
        inventory: { petrol: 300, cng: 100 },
        tankCapacity: { petrol: 1000, cng: null },
      });
      const sell = async (i, qty) => {
        const b = await createCustomerBooking({ user: { id: String(customers[4]._id) }, body: bookBody(s, i, qty) });
        await completeBooking({ bookingId: b._id });
      };
      const alerts = () => Notification.find({ user: vendor._id, type: "low_stock", station: s._id }).sort({ createdAt: 1 }).lean();

      await sell(4, 60); // 300 -> 240: 30% -> 24%, into "low"
      let rows = await alerts();
      assert.equal(rows.length, 1);
      assert.match(rows[0].title, /Petrol is low stock/);
      assert.match(rows[0].body, /240 L left \(24% of the tank\)/);

      await sell(5, 10); // 230, still low
      assert.equal((await alerts()).length, 1, "no repeat inside the same tier");

      await sell(6, 60); // 170, still low
      await sell(7, 60); // 110
      await sell(8, 20); // 90 -> 9%, into "critical"
      rows = await alerts();
      assert.equal(rows.length, 2);
      assert.match(rows[1].title, /critical/i);
    });

    await t.test("vendor delivery and stock count are recorded, with the history endpoint", async () => {
      const s = await makeStation("vendor", { inventory: { petrol: 100, cng: 100 }, tankCapacity: { petrol: 1000, cng: 500 } });
      let res = fakeRes();
      await vendorPanel.updateInventory(vendorReq({ id: String(s._id) }, { fuelType: "Petrol", quantity: 400, note: "IOCL invoice 7781" }), res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.stockBefore, 100);
      assert.equal(res.body.stockAfter, 500);

      res = fakeRes();
      await vendorPanel.updateInventory(vendorReq({ id: String(s._id) }, { fuelType: "petrol", quantity: 480, action: "set" }), res);
      assert.equal(res.body.stockAfter, 480);

      res = fakeRes();
      await vendorPanel.getInventoryMovements(vendorReq({ id: String(s._id) }, {}, { fuel: "petrol" }), res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body.map((m) => [m.type, m.quantity, m.stockAfter]), [
        ["stock_count", -20, 480],
        ["delivery", 400, 500],
      ]);
      assert.equal(res.body[1].note, "IOCL invoice 7781");
      assert.equal(res.body[1].recordedBy, vendor.name);

      res = fakeRes();
      await vendorPanel.getInventoryMovements(vendorReq({ id: String(s._id) }, {}, { fuel: "hydrogen" }), res);
      assert.equal(res.statusCode, 400);
    });

    await t.test("a stock count below what bookings hold is recorded, warned about, and stops new bookings", async () => {
      const s = await makeStation("undercount", { inventory: { petrol: 100, cng: 100 } });
      await createCustomerBooking({ user: { id: String(customers[5]._id) }, body: bookBody(s, 9, 50) });

      const res = fakeRes();
      await vendorPanel.updateInventory(vendorReq({ id: String(s._id) }, { fuelType: "petrol", quantity: 30, action: "set" }), res);
      assert.equal(res.statusCode, 200);
      assert.match(res.body.warning, /Live bookings hold 50 L/);
      assert.equal(res.body.status.petrol.available, 0);

      await assert.rejects(
        createCustomerBooking({ user: { id: String(customers[6]._id) }, body: bookBody(s, 10, 1) }),
        (err) => err.reason === "INSUFFICIENT_STOCK",
      );

      const alertRes = fakeRes();
      await vendorPanel.getInventoryAlerts(vendorReq({}), alertRes);
      // No tank size recorded, so no tier alert -- but the stations list shows the numbers.
      const listRes = fakeRes();
      await vendorPanel.getMyStations(vendorReq({}), listRes);
      const mine = listRes.body.find((x) => x.name === s.name);
      assert.equal(mine.inventoryStatus.petrol.committed, 50);
      assert.equal(mine.inventoryStatus.petrol.available, 0);
    });

    await t.test("reconcileCommitments repairs drift, but not while a booking request is in flight", async () => {
      const s = await makeStation("drift", { inventoryCommitted: { petrol: 999, diesel: 0, cng: 0 } });

      await BookingAttempt.create({ user: customers[7]._id, station: s._id, outcome: "pending" });
      let r = await ledger.reconcileCommitments({ stationIds: [s._id], apply: true });
      assert.equal(r.drift.length, 1);
      assert.equal(r.repaired, 0);
      assert.equal(r.skipped, 1);
      assert.equal((await stationDoc(s)).inventoryCommitted.petrol, 999);

      await BookingAttempt.deleteMany({ station: s._id });
      r = await ledger.reconcileCommitments({ stationIds: [s._id], apply: true });
      assert.equal(r.repaired, 1);
      assert.equal((await stationDoc(s)).inventoryCommitted.petrol, 0);
    });

    await t.test("the finder offers only stock that is not already booked", async () => {
      const s = await makeStation("finder", { inventory: { petrol: 20, cng: 0 }, inventoryCommitted: { petrol: 20, diesel: 0, cng: 0 } });
      const { buildFinderResults } = require("../src/services/station/stationFinder");
      const plain = { ...(await stationDoc(s)), distanceKm: 1 };
      const { stations } = await buildFinderResults({ stations: [plain], fuel: "petrol" });
      assert.equal(stations[0].canBook, false);
      assert.equal(stations[0].unavailableCode, "OUT_OF_STOCK");

      const { hasSufficientInventory } = require("../src/services/station/discovery");
      assert.equal(hasSufficientInventory(plain, "petrol", 1).ok, false);
      assert.equal(hasSufficientInventory({ ...plain, inventoryCommitted: { petrol: 5 } }, "petrol", 15).ok, true);
    });

    await t.test("vendor station edit cannot overwrite stock; other fields still apply", async () => {
      const s = await makeStation("edit", { inventory: { petrol: 100, cng: 100 } });
      const res = fakeRes();
      await vendorPanel.updateStation(
        vendorReq({ id: String(s._id) }, { name: `${tag}-edit-renamed`, inventory: { petrol: 1, cng: 1 } }),
        res,
      );
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      const after = await stationDoc(s);
      assert.equal(after.name, `${tag}-edit-renamed`);
      assert.deepEqual([after.inventory.petrol, after.inventory.cng], [100, 100], "stock untouched");
      assert.equal(await InventoryMovement.countDocuments({ station: s._id }), 0);
    });

    await t.test("admin station edit refuses stock, commitments and computed queue fields; applies the rest via save()", async () => {
      const stationController = require("../src/controllers/stationController");
      const s = await makeStation("admin-edit", { inventory: { petrol: 100, cng: 100 } });
      const call = async (body) => {
        const res = fakeRes();
        res.send = function send(b) { this.body = b; return this; };
        await stationController.updateStation({ params: { id: String(s._id) }, body, user: { id: String(vendor._id), role: "admin" }, app: { get: () => null } }, res);
        return res;
      };

      for (const body of [{ inventory: { petrol: 1 } }, { inventoryCommitted: { petrol: 50 } }, { tankCapacity: { petrol: 10 } }, { queueLength: 99 }]) {
        const r = await call(body);
        assert.equal(r.statusCode, 400, JSON.stringify(body));
        assert.deepEqual(r.body.fields, Object.keys(body));
      }
      const unchanged = await stationDoc(s);
      assert.equal(unchanged.inventory.petrol, 100);
      assert.equal(unchanged.inventoryCommitted?.petrol ?? 0, 0);

      const ok = await call({ name: `${tag}-admin-renamed`, coordinates: { lat: 18.52, lng: 73.85 }, isAdmin: true });
      assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
      const after = await stationDoc(s);
      assert.equal(after.name, `${tag}-admin-renamed`);
      assert.deepEqual(after.location.coordinates, [73.85, 18.52], "save() ran the coordinates -> GeoJSON sync");
      assert.equal(after.isAdmin, undefined, "unknown fields are ignored");
    });

    await t.test("a new station's starting stock is the first line of its history", async () => {
      const res = fakeRes();
      await vendorPanel.createStation(
        vendorReq({}, { name: `${tag}-created`, address: "Inventory Test", fuelTypes: ["Petrol", "CNG"], inventory: { petrol: 500, cng: 0 } }),
        res,
      );
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      stationIds.push(res.body._id);
      const rows = await InventoryMovement.find({ station: res.body._id }).lean();
      assert.deepEqual(rows.map((r) => [r.fuel, r.type, r.quantity, r.stockAfter, r.note]), [["petrol", "stock_count", 500, 500, "Opening stock"]]);
      assert.equal(String(rows[0].recordedBy), String(vendor._id));
      assert.deepEqual(await ledger.ledgerDrift({ stationIds: [res.body._id] }), [], "history and tank agree");
    });

    await t.test("ledgerDrift reports stock no history explains and stock changed outside the ledger", async () => {
      const s = await makeStation("drift-ledger", { inventory: { petrol: 100, cng: 40 } });
      let drift = await ledger.ledgerDrift({ stationIds: [s._id] });
      assert.deepEqual(drift.map((d) => [d.fuel, d.reason, d.stock, d.ledger]).sort(), [["cng", "NO_HISTORY", 40, null], ["petrol", "NO_HISTORY", 100, null]]);

      assert.equal(await ledger.recordOpeningStock({ station: await stationDoc(s), note: "Opening balance" }), 2);
      assert.equal(await ledger.recordOpeningStock({ station: await stationDoc(s) }), 0, "calling again adds nothing");
      assert.deepEqual(await ledger.ledgerDrift({ stationIds: [s._id] }), []);

      // A sale through the ledger keeps them in step...
      const b = await createCustomerBooking({ user: { id: String(customers[8]._id) }, body: bookBody(s, 11, 30) });
      await completeBooking({ bookingId: b._id });
      assert.deepEqual(await ledger.ledgerDrift({ stationIds: [s._id] }), []);

      // ...a direct database edit does not.
      await Station.collection.updateOne({ _id: s._id }, { $set: { "inventory.petrol": 5 } });
      drift = await ledger.ledgerDrift({ stationIds: [s._id] });
      assert.deepEqual(drift.map((d) => [d.fuel, d.reason, d.stock, d.ledger]), [["petrol", "MISMATCH", 5, 70]]);
    });
  } finally {
    await Booking.deleteMany({ $or: [{ station: { $in: stationIds } }, { user: { $in: userIds } }] });
    await BookingAttempt.deleteMany({ $or: [{ station: { $in: stationIds } }, { user: { $in: userIds } }] });
    await InventoryMovement.deleteMany({ station: { $in: stationIds } });
    await Notification.deleteMany({ user: { $in: userIds } });
    await require("../src/models/SecurityEvent").deleteMany({ user: { $in: userIds } });
    await Station.deleteMany({ _id: { $in: stationIds } });
    await User.deleteMany({ _id: { $in: userIds } });
    await mongoose.disconnect();
  }
});
