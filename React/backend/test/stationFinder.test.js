/**
 * Phase 3: station ranking on the customer finder.
 *
 * services/queue/nozzleScheduler.js batch helpers (pure), services/station/stationFinder.js
 * against MongoDB with an injected clock, and GET /api/stations/nearby.
 *
 * DEVELOPMENT TEST DATA: tagged stations in the South Atlantic (-50, -20)
 * and bookings on 2099-07-01, a date no sweep touches; all removed at the end.
 *
 *   node --test test/stationFinder.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const nozzleScheduler = require("../src/services/queue/nozzleScheduler");
const { atBusinessTime } = require("../src/config/businessTime");

const DATE = "2099-07-01";
const at = (h, m = 0) => atBusinessTime(DATE, h, m);

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

test("windowsOverlap: touching windows do not overlap, one millisecond does", () => {
  const a = new Date(1000);
  const b = new Date(2000);
  assert.equal(nozzleScheduler.windowsOverlap(a, b, b, new Date(3000)), false);
  assert.equal(nozzleScheduler.windowsOverlap(a, new Date(2001), b, new Date(3000)), true);
});

test("labelAvailability: a window keeps its remaining capacity around what is booked", () => {
  // The nozzle is busy 10:00-10:05; each Petrol fill takes 40 s.
  const busy = { start: at(10), end: new Date(at(10).getTime() + 300_000), status: "upcoming" };
  const slots = nozzleScheduler.labelAvailability([busy], "petrol", DATE, ["9:30 AM", "10:00 AM", "10:30 AM"], undefined, {
    now: new Date(at(9).getTime()),
  });
  assert.deepEqual(
    slots.map((s) => [s.label, s.available, s.capacity.total, s.capacity.available]),
    [
      ["9:30 AM", true, 45, 45],
      ["10:00 AM", true, 45, 37], // 25 minutes left: floor(1500 / 40)
      ["10:30 AM", true, 45, 45],
    ],
  );
  assert.equal(slots[1].start.getTime(), at(10).getTime() + 300_000, "the first position is when the nozzle frees, 10:05");
});

test("pickAlternative: a bookable but slow station only gets a genuinely faster one", () => {
  const { pickAlternative } = require("../src/services/station/stationFinder");
  const slow = { stationId: "slow", stationName: "Slow", distance: 1, estimatedWaitingTime: 40, canBook: true };
  const quick = { stationId: "quick", stationName: "Quick", distance: 2, estimatedWaitingTime: 2, canBook: true };
  const far = { stationId: "far", stationName: "Far", distance: 30, estimatedWaitingTime: 0, canBook: true };
  const alt = pickAlternative(slow, [slow, quick, far], { fuelKey: "petrol", serviceMinutes: 40 / 60 });
  assert.equal(alt.stationId, "quick");
  assert.ok(alt.timeSavedMinutes >= 30, JSON.stringify(alt));

  const fine = { ...slow, estimatedWaitingTime: 3 };
  assert.equal(pickAlternative(fine, [fine, quick], { fuelKey: "petrol", serviceMinutes: 40 / 60 }), null);
});

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

test("station finder against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const discovery = require("../src/services/station/discovery");
  const { buildFinderResults } = require("../src/services/station/stationFinder");
  const stationController = require("../src/controllers/stationController");
  await Station.init();

  const tag = `finder-${Date.now()}`;
  // Each geo test file has its own empty patch of ocean: node --test runs
  // files concurrently, and a nearby fixture from another file would appear
  // in this file's search results.
  const origin = { lat: -50, lng: -20 };
  const north = (km) => ({ lat: origin.lat + km / 111.195, lng: origin.lng });
  const stationIds = [];
  const make = async (name, km, fields = {}) => {
    const s = await Station.create({
      name: `${tag}-${name}`,
      address: "Finder Test",
      status: "Active",
      coordinates: north(km),
      fuelTypes: ["Petrol", "CNG"],
      prices: { petrol: 100, cng: 80 },
      inventory: { petrol: 1000, cng: 500 },
      ...fields,
    });
    stationIds.push(s._id);
    return s;
  };
  const book = (station, label, fuelType = "Petrol", status = "upcoming") => {
    const start = nozzleScheduler.parseStartDateTime(DATE, label);
    const w = nozzleScheduler.computeWindow(fuelType, start);
    return Booking.create({
      user: new mongoose.Types.ObjectId(),
      station: station._id,
      fuelType,
      quantity: 5,
      price: 100,
      amount: 505,
      bookingDate: DATE,
      timeSlot: label,
      bookingStartTime: w.start,
      bookingEndTime: w.end,
      status,
    });
  };

  const freeFar = await make("free-4km", 4);
  const busyNear = await make("busy-1km", 1);
  await make("unpriced-2km", 2, { prices: { petrol: null, cng: 80 } });
  await make("empty-3km", 3, { inventory: { petrol: 0, cng: 500 } });
  await book(busyNear, "10:00 AM");
  await book(busyNear, "10:30 AM", "CNG");

  const short = (name) => name.replace(`${tag}-`, "");
  const run = async (opts = {}) => {
    const { stations } = await discovery.findStationsForFuel(origin, { fuelType: "petrol", radiusKm: 10 });
    const out = await buildFinderResults({ stations, fuel: "petrol", now: at(10, 5), ...opts });
    return { ...out, byName: Object.fromEntries(out.stations.map((s) => [short(s.stationName), s])) };
  };

  try {
    await t.test("slots come from the nozzle scheduler and use bookable labels", async () => {
      const { byName } = await run();
      const busy = byName["busy-1km"];
      // One 40 s Petrol booking at 10:00 leaves the rest of the window: at 10:05
      // the next position starts at once; 25 minutes of 40 s fills remain.
      assert.equal(busy.currentSlot.slot, "10:00 AM");
      assert.equal(busy.currentSlot.status, "AVAILABLE");
      assert.equal(busy.currentSlot.start, "10:00");
      assert.equal(busy.currentSlot.end, "10:30");
      assert.equal(busy.currentSlot.estimatedStart, "10:05");
      assert.equal(busy.currentSlot.capacity, 45);
      assert.equal(busy.currentSlot.booked, 1);
      assert.equal(busy.currentSlot.available, 37);
      // The 10:30 CNG booking is on the CNG nozzle: the Petrol window keeps all 45.
      const petrol1030 = busy.recommendedSlots.find((s) => s.slot === "10:30 AM");
      assert.equal(petrol1030.available, 45, "a CNG booking never takes Petrol capacity");
      assert.deepEqual(busy.recommendedSlots.map((s) => s.slot), ["10:00 AM", "10:30 AM", "11:00 AM"]);
      assert.equal(byName["free-4km"].preferredSlot.slot, "10:00 AM", "the current label is still bookable at 10:05");
    });

    await t.test("wait is the app nozzle's live line (services/queue/stationQueue.js)", async () => {
      const { byName, serviceMinutes } = await run();
      assert.equal(serviceMinutes, 0.67);
      // At 10:05 the 10:00 booking's slot has started (in line); the 10:30
      // one has not. One 40 s fill -> 1 minute.
      assert.equal(byName["busy-1km"].currentQueue, 1);
      assert.equal(byName["busy-1km"].estimatedWaitingTime, 1);
      assert.equal(byName["busy-1km"].waitBasis, "app-nozzle");
      assert.equal(byName["free-4km"].currentQueue, 0);
      assert.equal(byName["free-4km"].estimatedWaitingTime, 0);
    });

    await t.test("canBook needs a price, stock and a slot, and says which is missing", async () => {
      const { byName } = await run();
      assert.equal(byName["free-4km"].canBook, true);
      assert.equal(byName["busy-1km"].canBook, true);
      assert.equal(byName["unpriced-2km"].unavailableCode, "NO_PRICE");
      assert.equal(byName["empty-3km"].unavailableCode, "OUT_OF_STOCK");

      const big = await run({ quantity: 1500 });
      assert.equal(big.byName["free-4km"].unavailableCode, "INSUFFICIENT_STOCK");

      const { stations } = await discovery.findStationsForFuel(origin, { fuelType: "petrol", radiusKm: 10 });
      // A station that closes at 22:00 has nothing left at 23:00 (a 24-hour one would).
      const closesAt22 = Object.fromEntries(
        ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [d, { open: "06:00", close: "22:00", is24h: false, isClosed: false }]),
      );
      for (const st of stations) st.operatingSchedule = closesAt22;
      const late = await buildFinderResults({ stations, fuel: "petrol", now: at(23, 0) });
      const lateFree = late.stations.find((s) => short(s.stationName) === "free-4km");
      assert.equal(lateFree.unavailableCode, "NO_SLOT_TODAY");
      assert.equal(lateFree.preferredSlot, null);
    });

    await t.test("bookable stations rank ahead of unbookable ones, however close", async () => {
      const { stations } = await run();
      assert.deepEqual(stations.map((s) => s.canBook), [true, true, false, false]);
      assert.deepEqual(stations.map((s) => s.rankTier), [0, 0, 2, 2]);
      assert.equal(short(stations[0].stationName), "busy-1km", "1 km with a 1 min wait beats 4 km with none");
    });

    await t.test("an unbookable station points at the bookable one with the shortest trip", async () => {
      const { byName } = await run();
      const alt = byName["unpriced-2km"].recommendedAlternative;
      assert.equal(alt.name, busyNear.name);
      assert.equal(alt.timeSavedMinutes, null);
      assert.equal(byName["free-4km"].recommendedAlternative, null, "bookable and quick needs no alternative");
    });

    await t.test("GET /api/stations/nearby returns the finder result and validates quantity", async () => {
      const call = async (query) => {
        const res = {
          statusCode: 200,
          status(c) { this.statusCode = c; return this; },
          json(b) { this.body = b; return this; },
          send(b) { this.body = b; return this; },
        };
        await stationController.getNearbyStations({ query }, res);
        return res;
      };
      const base = { latitude: "-50", longitude: "-20", fuelType: "PETROL", radius: "10" };
      for (const quantity of ["abc", "0", "61"]) {
        assert.equal((await call({ ...base, quantity })).statusCode, 400, quantity);
      }
      const ok = await call({ ...base, quantity: "20" });
      assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.quantity, 20);
      assert.deepEqual(ok.body.rankingWeights, { distance: 0.45, wait: 0.4, price: 0.15 });
      assert.equal(ok.body.stations.length, 4);
      // The endpoint runs on the real clock: once today's last slot has passed
      // (after 10:00 PM India time) no station can take a booking today, and
      // saying so is correct -- not a failure.
      const { BOOKABLE_SLOT_LABELS, isSlotElapsed } = require("../src/config/booking");
      const { dateKey } = require("../src/config/businessTime");
      const slotsLeftToday = BOOKABLE_SLOT_LABELS.some((label) => !isSlotElapsed(dateKey(), label));
      if (slotsLeftToday) {
        assert.equal(ok.body.stations[0].canBook, true);
      } else {
        assert.ok(ok.body.stations.every((s) => !s.canBook), "no station can book once today's slots are over");
        assert.ok(
          ok.body.stations.some((s) => s.unavailableCode === "NO_SLOT_TODAY"),
          JSON.stringify(ok.body.stations.map((s) => s.unavailableCode)),
        );
      }
      assert.ok(ok.body.stations.every((s) => "unavailableReason" in s));
    });

    await t.test("GET /api/v1/slots/recommend-alternative requires a real quantity", async () => {
      const express = require("express");
      const app = express().use("/s", require("../src/routes/slotRoutes"));
      const server = app.listen(0);
      try {
        const { port } = server.address();
        const r = await fetch(`http://127.0.0.1:${port}/s/recommend-alternative?stationId=${freeFar._id}&date=${DATE}&timeSlot=10:00%20AM`);
        assert.equal(r.status, 400);
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
