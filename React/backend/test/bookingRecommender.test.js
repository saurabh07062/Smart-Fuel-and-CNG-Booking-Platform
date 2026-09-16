/**
 * The booking wizard's Smart Queue Recommender
 * (services/station/smartRecommender.js findWorthItAlternatives and
 * GET /api/v1/slots/recommend-alternative).
 *
 * DEVELOPMENT TEST DATA, test database only: tagged stations in an empty
 * patch of the South Atlantic (-52, -25) and bookings on 2099-07-02; all
 * removed at the end.
 *
 *   node --test test/bookingRecommender.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const smartRecommender = require("../src/services/station/smartRecommender");
const nozzleScheduler = require("../src/services/queue/nozzleScheduler");
const { atBusinessTime } = require("../src/config/businessTime");

const DATE = "2099-07-02";
const at = (h, m = 0) => atBusinessTime(DATE, h, m);

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

test("waitAtSlotMinutes: only a line still running at the slot start counts", () => {
  const now = at(10, 0);
  const line = (waitMinutes) => ({ waitMinutes });
  assert.equal(smartRecommender.waitAtSlotMinutes(line(60), at(10, 30), now), 30);
  assert.equal(smartRecommender.waitAtSlotMinutes(line(20), at(10, 30), now), 0, "line clears before the slot");
  assert.equal(smartRecommender.waitAtSlotMinutes(line(0), at(10, 30), now), 0);
  assert.equal(smartRecommender.waitAtSlotMinutes(null, at(10, 30), now), 0, "another day has no live line");
});

test("bookingProblem: the same checks booking makes, in order", () => {
  const ok = { status: "Active", prices: { petrol: 100 }, inventory: { petrol: 100 }, inventoryCommitted: { petrol: 90 } };
  const free = { bookable: true, reason: null };
  assert.equal(smartRecommender.bookingProblem(ok, free, "petrol", 10), null);
  assert.equal(smartRecommender.bookingProblem(ok, free, "petrol", 11).code, "INSUFFICIENT_STOCK", "committed stock is not bookable");
  assert.equal(smartRecommender.bookingProblem({ ...ok, status: "Inactive" }, free, "petrol", 1).code, "INACTIVE");
  assert.equal(smartRecommender.bookingProblem({ ...ok, prices: {} }, free, "petrol", 1).code, "NO_PRICE");
  assert.equal(smartRecommender.bookingProblem(ok, { reason: "RESERVED" }, "petrol", 1).code, "RESERVED");
  assert.equal(smartRecommender.bookingProblem(ok, { reason: "CLOSED" }, "petrol", 1).code, "CLOSED");
  assert.equal(smartRecommender.bookingProblem(ok, undefined, "petrol", 1).code, "UNKNOWN_SLOT");
});

// ---------------------------------------------------------------------------
// MongoDB (test database)
// ---------------------------------------------------------------------------

test("booking recommender against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  await Station.init();

  const tag = `recommender-${Date.now()}`;
  const origin = { lat: -52, lng: -25 };
  const north = (km) => ({ lat: origin.lat + km / 111.195, lng: origin.lng });
  const stationIds = [];
  const make = async (name, km, fields = {}) => {
    const s = await Station.create({
      name: `${tag}-${name}`,
      address: "Recommender Test",
      status: "Active",
      coordinates: north(km),
      fuelTypes: ["Petrol"],
      prices: { petrol: 100 },
      inventory: { petrol: 1000 },
      ...fields,
    });
    stationIds.push(s._id);
    return s;
  };
  const book = (station, label, fields = {}) => {
    const start = nozzleScheduler.parseStartDateTime(DATE, label);
    const w = nozzleScheduler.computeWindow("Petrol", start);
    return Booking.create({
      user: new mongoose.Types.ObjectId(),
      station: station._id,
      fuelType: "Petrol",
      quantity: 5,
      price: 100,
      amount: 505,
      bookingDate: DATE,
      timeSlot: label,
      bookingStartTime: w.start,
      bookingEndTime: w.end,
      status: "upcoming",
      ...fields,
    });
  };

  const target = await make("target-1km", 1);
  await make("alt-3km", 3);
  await make("low-stock-2km", 2, { inventory: { petrol: 5 } });
  await make("far-40km", 40);

  const short = (name) => name && name.replace(`${tag}-`, "");
  const ask = (extra = {}) =>
    smartRecommender.findWorthItAlternatives({
      targetStationId: target._id,
      origin,
      bookingDate: DATE,
      timeSlot: "10:30 AM",
      fuelType: "Petrol",
      quantity: 20,
      now: at(8, 0),
      ...extra,
    });

  try {
    await t.test("a station that can take the booking with no line needs no alternative", async () => {
      const r = await ask();
      assert.equal(r.target.canBook, true);
      assert.equal(r.target.waitMinutes, 0);
      assert.equal(r.alternative, null);
      assert.equal(r.positionBasis, "customer");
    });

    await t.test("another day's booking: no live line is carried over", async () => {
      const r = await ask({ now: new Date("2099-06-01T04:00:00Z") });
      assert.equal(r.waitBasis, "reserved-slot");
      assert.equal(r.target.waitMinutes, 0);
    });

    await t.test("reserved nozzle: the nearest station that can take exactly this booking", async () => {
      const taken = await book(target, "10:30 AM");
      try {
        const r = await ask();
        assert.equal(r.target.canBook, false);
        assert.equal(r.target.unavailableCode, "RESERVED");
        // low-stock-2km is nearer but has 5 L for a 20 L booking; far-40km is past the detour limit.
        assert.equal(short(r.alternative.name), "alt-3km");
        assert.equal(r.alternative.timeSavedMinutes, null);
        assert.equal(r.alternative.price, 100);
      } finally {
        await Booking.deleteOne({ _id: taken._id });
      }
    });

    await t.test("not enough stock anywhere: says why and recommends nothing", async () => {
      const r = await ask({ quantity: 1500 });
      assert.equal(r.target.unavailableCode, "INSUFFICIENT_STOCK");
      assert.equal(r.alternative, null);
    });

    await t.test("a fill still running at the slot start makes the slot unbookable, and points to a station that can take it", async () => {
      // Being served since 10:00 with an hour's fill: the nozzle is locked
      // until 11:00, so 10:30 cannot be given to anyone (services/queue/nozzleScheduler.js
      // liveServiceWindows), even though this booking's own reserved window
      // (9:30) ended long ago.
      const now = at(10, 0);
      const start = nozzleScheduler.parseStartDateTime(DATE, "9:30 AM");
      const late = await book(target, "9:30 AM", {
        status: "serving",
        fuelingStartTime: now,
        serviceDurationSeconds: 3600,
        bookingStartTime: start,
        bookingEndTime: new Date(start.getTime() + 40_000),
      });
      try {
        const r = await ask({ now });
        assert.equal(r.waitBasis, "app-nozzle");
        assert.equal(r.target.canBook, false);
        assert.equal(r.target.unavailableCode, "RESERVED", "the nozzle is in use at 10:30");
        assert.equal(short(r.alternative.name), "alt-3km");
        assert.equal(r.alternative.timeSavedMinutes, null, "the target cannot take it, so this is not a time comparison");
        assert.equal(r.alternative.waitMinutes, 0);
      } finally {
        await Booking.deleteOne({ _id: late._id });
      }
    });

    await t.test("bad input is refused, not guessed", async () => {
      await assert.rejects(ask({ timeSlot: "10:17 AM" }), { status: 400 });
      await assert.rejects(ask({ fuelType: "hydrogen" }), { status: 400 });
      await assert.rejects(ask({ bookingDate: "someday" }), { status: 400 });
      await assert.rejects(ask({ targetStationId: new mongoose.Types.ObjectId() }), { status: 404 });
    });

    await t.test("GET /api/v1/slots/recommend-alternative returns the decision", async () => {
      const express = require("express");
      const app = express().use("/s", require("../src/routes/slotRoutes"));
      const server = app.listen(0);
      try {
        const { port } = server.address();
        const base = `http://127.0.0.1:${port}/s/recommend-alternative`;
        const q = (params) => fetch(`${base}?${new URLSearchParams(params)}`);
        const good = { stationId: String(target._id), date: DATE, timeSlot: "10:30 AM", fuelType: "Petrol", quantity: "20", lat: "-52", lng: "-25" };

        const ok = await q(good);
        assert.equal(ok.status, 200);
        const body = await ok.json();
        assert.equal(body.target.stationId, String(target._id));
        assert.ok("alternative" in body);

        const { fuelType, ...noFuel } = good;
        assert.equal((await q(noFuel)).status, 400);
        assert.equal((await q({ ...good, quantity: "0" })).status, 400);
      } finally {
        server.close();
      }
    });
  } finally {
    await Booking.deleteMany({ station: { $in: stationIds } });
    await Station.deleteMany({ _id: { $in: stationIds } });
    await mongoose.disconnect();
  }
});
