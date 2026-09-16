/**
 * Phase 6: queue and ETAs.
 *
 * services/queue/stationQueue.js (the one wait-time model) -- pure simulation, the
 * station/booking refresh against MongoDB, and the endpoints that now read it
 * or were retired.
 *
 * DEVELOPMENT TEST DATA: tagged users/stations without a map position and
 * bookings on 2099-09-01 with an injected clock, removed at the end.
 *
 *   node --test test/stationQueue.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { simulateNozzleLine } = require("../src/services/queue/stationQueue");
const { atBusinessTime } = require("../src/config/businessTime");

const DATE = "2099-09-01";
const at = (h, m = 0, s = 0) => new Date(atBusinessTime(DATE, h, m).getTime() + s * 1000);
let seq = 0;
const booking = (fields) => ({
  _id: `b${++seq}`,
  user: `u${seq}`,
  fuelType: "Petrol",
  serviceDurationSeconds: 40,
  status: "upcoming",
  ...fields,
});

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

test("simulateNozzleLine: an empty nozzle has no line and no wait", () => {
  const r = simulateNozzleLine([], at(10));
  assert.deepEqual(
    { queueLength: r.queueLength, waitMinutes: r.waitMinutes, queueStatus: r.queueStatus, basis: r.basis, etas: r.etas },
    { queueLength: 0, waitMinutes: 0, queueStatus: "Low", basis: "app-nozzle", etas: [] },
  );
});

test("simulateNozzleLine: only bookings whose slot has started are in line now", () => {
  const due = booking({ bookingStartTime: at(10, 0) });
  const later = booking({ bookingStartTime: at(10, 30), fuelType: "CNG", serviceDurationSeconds: 300 });
  const r = simulateNozzleLine([later, due], at(10, 5));
  assert.equal(r.queueLength, 1);
  assert.equal(r.waitMinutes, 1, "one 40 s fill");
  assert.deepEqual(r.etas.map((e) => [e.bookingId, e.position, e.etaMinutes]), [
    [due._id, 1, 0],
    [later._id, 2, 25],
  ]);
});

test("simulateNozzleLine: an overrunning fill pushes later ETAs back", () => {
  // CNG started 10:28 (5 min, done 10:33); the 10:30 petrol booking waits for it.
  const serving = booking({ status: "serving", fuelType: "CNG", serviceDurationSeconds: 300, bookingStartTime: at(10, 0), fuelingStartTime: at(10, 28) });
  const next = booking({ bookingStartTime: at(10, 30) });
  const r = simulateNozzleLine([next, serving], at(10, 31));
  assert.equal(r.queueLength, 2);
  assert.equal(r.etas.find((e) => e.bookingId === next._id).etaMinutes, 2); // 10:33 - 10:31
  assert.equal(r.waitMinutes, 3, "line clears at 10:33:40");
  assert.equal(r.queueStatus, "Low");
});

test("simulateNozzleLine: a booking whose whole slot passed is not in line", () => {
  const noShow = booking({ bookingStartTime: at(9, 0) });
  const r = simulateNozzleLine([noShow], at(10, 5));
  assert.equal(r.queueLength, 0);
  assert.equal(r.etas.length, 0);
});

test("simulateNozzleLine: a long line reads as High", () => {
  const line = Array.from({ length: 20 }, (_, i) =>
    booking({ fuelType: "CNG", serviceDurationSeconds: 300, bookingStartTime: at(9, 40 + i) }),
  );
  const r = simulateNozzleLine(line, at(10, 0));
  assert.equal(r.queueLength, 20);
  assert.equal(r.waitMinutes, 100);
  assert.equal(r.queueStatus, "High");
});

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

test("station queue against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const User = require("../src/models/User");
  const { refreshStationQueue } = require("../src/services/queue/stationQueue");
  const stationController = require("../src/controllers/stationController");
  const vendorPanel = require("../src/controllers/vendorPanelController");

  const tag = `queue-${Date.now()}`;
  const vendor = await User.create({
    name: `${tag}-vendor`,
    email: `${tag}-vendor@example.com`,
    password: "not-a-real-hash",
    role: "vendor",
    vendorStatus: "active",
  });
  const station = await Station.create({
    name: `${tag}-station`,
    address: "Queue Test",
    owner: vendor._id,
    status: "Active",
    fuelTypes: ["Petrol", "CNG"],
    prices: { petrol: 100, cng: 80 },
    inventory: { petrol: 1000, cng: 500 },
    queueLength: 99, // a stale cached value that must not survive a refresh
  });
  const customers = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const make = (user, label, fields = {}) => {
    const start = atBusinessTime(DATE, ...label);
    return Booking.create({
      user,
      station: station._id,
      fuelType: "Petrol",
      quantity: 5,
      price: 100,
      amount: 505,
      bookingDate: DATE,
      timeSlot: "10:00 AM",
      bookingStartTime: start,
      bookingEndTime: new Date(start.getTime() + 40_000),
      serviceDurationSeconds: 40,
      status: "upcoming",
      ...fields,
    });
  };
  const b1 = await make(customers[0], [10, 0]);
  const b2 = await make(customers[1], [10, 30], { timeSlot: "10:30 AM" });

  const fakeRes = () => ({
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
  });

  try {
    await t.test("refreshStationQueue writes the station's cache and each booking's ETA", async () => {
      const r = await refreshStationQueue(station._id, { now: atBusinessTime(DATE, 10, 5) });
      assert.equal(r.queueLength, 1);
      assert.equal(r.waitMinutes, 1);

      const s = await Station.findById(station._id).lean();
      assert.equal(s.queueLength, 1, "the stale 99 is replaced");
      assert.equal(s.waitMinutes, 1);
      assert.equal(s.queueStatus, "Low");
      assert.equal((await Booking.findById(b1._id).lean()).etaMinutes, 0);
      assert.equal((await Booking.findById(b2._id).lean()).etaMinutes, 25);
    });

    await t.test("GET /api/stations computes the queue live, not from the cached field", async () => {
      await Station.updateOne({ _id: station._id }, { $set: { queueLength: 99, waitMinutes: 99 } });
      const res = fakeRes();
      await stationController.getAllStations({ query: {} }, res);
      const row = res.body.find((x) => x.name === station.name);
      // The bookings are on 2099-09-01, not today: nobody is in line right now.
      assert.equal(row.queue, 0);
      assert.equal(row.waitTime, 0);
      assert.equal(row.queueStatus, "Low");
      assert.equal(row.queueBasis, "app-nozzle");
    });

    await t.test("vendor queue view: real positions and ETAs; the manual override is retired", async () => {
      const req = { params: { id: String(station._id) }, user: { id: String(vendor._id), role: "vendor" }, body: {}, app: { get: () => null } };
      let res = fakeRes();
      await vendorPanel.getQueueStatus(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.maxCapacity, undefined, "no invented capacity");
      assert.equal(res.body.basis, "app-nozzle");

      for (const handler of [vendorPanel.updateQueueStatus, vendorPanel.closeQueue]) {
        res = fakeRes();
        await handler(req, res);
        assert.equal(res.statusCode, 410);
      }
    });

    await t.test("/api/v1/queue is retired and writes nothing", async () => {
      const express = require("express");
      const app = express().use(express.json()).use("/q", require("../src/routes/queueRoutes"));
      const server = app.listen(0);
      try {
        const base = `http://127.0.0.1:${server.address().port}/q`;
        assert.equal((await fetch(`${base}/${station._id}/live`)).status, 410);
        const post = await fetch(`${base}/start-fueling`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bookingId: String(b1._id) }),
        });
        assert.equal(post.status, 410);
        assert.equal((await Booking.findById(b1._id).lean()).fuelingStartTime ?? null, null);
      } finally {
        server.close();
      }
    });

    await t.test("GET /api/v1/discovery/stations/:id/eta shares the model and exposes no customers", async () => {
      const express = require("express");
      const app = express().use("/d", require("../src/routes/discoveryRoutes"));
      const server = app.listen(0);
      try {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/d/stations/${station._id}/eta`);
        const body = await r.json();
        assert.equal(r.status, 200);
        assert.equal(body.basis, "app-nozzle");
        assert.equal(body.etas, undefined);
        assert.equal(typeof body.waitMinutes, "number");
      } finally {
        server.close();
      }
    });
  } finally {
    await Booking.deleteMany({ station: station._id });
    await Station.deleteOne({ _id: station._id });
    await User.deleteOne({ _id: vendor._id });
    await mongoose.disconnect();
  }
});
