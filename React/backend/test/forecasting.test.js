/**
 * Phase 9: demand forecasting.
 *
 * services/algorithms/forecast.js forecastFromHistory (the readiness gate) and
 * services/inventory/demandHistory.js salesHistory against MongoDB, plus the vendor
 * forecast endpoint and the admin dashboard's revenue forecast.
 *
 * DEVELOPMENT TEST DATA: a tagged station (no map position) with completed
 * bookings back-dated into earlier India months via completionTime, all
 * removed at the end. An injected clock keeps the months deterministic.
 *
 *   node --test test/forecasting.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { forecastFromHistory, reliabilityOf, READINESS } = require("../src/services/algorithms/forecast");
const { atBusinessTime } = require("../src/config/businessTime");

/** A history object in demandHistory's shape: complete months, then the running one. */
function history(values, { daysObserved = values.length * 30 + 10, current = { month: "2026-09", daysElapsed: 10, daysInMonth: 30 } } = {}) {
  const [cy, cm] = current.month.split("-").map(Number);
  const months = values.map((value, i) => {
    const idx = cy * 12 + (cm - 1) - (values.length - i);
    return { month: `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`, value, bookings: 1, complete: true };
  });
  months.push({ month: current.month, value: 5, bookings: 1, complete: false });
  const totalValue = values.reduce((a, b) => a + b, 0) + 5;
  return { months, current, daysObserved, totalValue };
}

// ---------------------------------------------------------------------------
// Pure: the readiness gate
// ---------------------------------------------------------------------------

test("no complete month: no forecast, and no run rate before 14 days", () => {
  const h = { months: [{ month: "2026-09", value: 466, bookings: 36, complete: false }], current: { month: "2026-09", daysElapsed: 11, daysInMonth: 30 }, daysObserved: 2, totalValue: 466 };
  const f = forecastFromHistory(h);
  assert.equal(f.ready, false);
  assert.equal(f.value, null);
  assert.equal(f.method, "insufficient-history");
  assert.equal(f.runRate, null);
  assert.match(f.reason, /Only 2 days of sales/);
  assert.equal(f.forMonth, "2026-10");
});

test("no complete month but 20 days observed: a clearly labelled run rate, still not a forecast", () => {
  const h = { months: [{ month: "2026-09", value: 400, bookings: 20, complete: false }], current: { month: "2026-09", daysElapsed: 25, daysInMonth: 30 }, daysObserved: 20, totalValue: 400 };
  const f = forecastFromHistory(h);
  assert.equal(f.ready, false);
  assert.equal(f.runRate.value, 620); // 400 / 20 days * 31 days in October
  assert.match(f.runRate.basis, /daily average/);
});

test("1-2 complete months: an average, accuracy unmeasured; the running month is never fitted", () => {
  const f = forecastFromHistory(history([300, 500]));
  assert.equal(f.ready, true);
  assert.equal(f.method, "moving-average");
  assert.equal(f.value, 400, "the partial month's 5 is not averaged in");
  assert.equal(f.errorPercent, null);
  assert.equal(f.reliability, "unmeasured");
  assert.match(f.note, /2 complete months/);
  assert.match(f.note, /current month \(10 of 30 days\)/);
});

test("3-5 complete months: smoothing with a measured error, but no trend", () => {
  const f = forecastFromHistory(history([100, 150, 200, 250, 300]));
  assert.equal(f.method, "exponential-smoothing", "a clear trend is still not estimated from 5 points");
  assert.equal(typeof f.errorPercent, "number");
  assert.match(f.note, /not estimated until 6/);
});

test("6+ complete months: the trend method when the trend is real", () => {
  const f = forecastFromHistory(history([100, 150, 200, 250, 300, 350]));
  assert.equal(f.method, "holt-linear-trend");
  assert.ok(f.value > 350);
  const flat = forecastFromHistory(history([100, 98, 102, 99, 101, 100]));
  assert.equal(flat.method, "exponential-smoothing");
  assert.equal(flat.reliability, "good");
});

test("reliability bands", () => {
  assert.equal(reliabilityOf(null), "unmeasured");
  assert.equal(reliabilityOf(10), "good");
  assert.equal(reliabilityOf(30), "fair");
  assert.equal(reliabilityOf(60), "poor");
  assert.deepEqual(READINESS, { minPointsForSmoothing: 3, minPointsForTrend: 6, minDaysForRunRate: 14, minDaysForVariation: 28 });
});

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

test("sales history and forecast endpoints against MongoDB", async (t) => {
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
  const { salesHistory, monthlyDemand } = require("../src/services/inventory/demandHistory");
  const vendorPanel = require("../src/controllers/vendorPanelController");

  const tag = `fc-${Date.now()}`;
  const [vendor, otherVendor, customer] = await Promise.all([
    User.create({ name: `${tag}-vendor`, email: `${tag}-v@example.com`, password: "x", role: "vendor", vendorStatus: "active" }),
    User.create({ name: `${tag}-other`, email: `${tag}-o@example.com`, password: "x", role: "vendor", vendorStatus: "active" }),
    User.create({ name: `${tag}-cust`, email: `${tag}-c@example.com`, password: "x", role: "customer", isVerified: true }),
  ]);
  const station = await Station.create({
    name: `${tag}-station`,
    address: "Forecast Test",
    owner: vendor._id,
    status: "Active",
    fuelTypes: ["Petrol", "CNG"],
    prices: { petrol: 100, cng: 80 },
    inventory: { petrol: 900, cng: 100 },
    inventoryCommitted: { petrol: 100, diesel: 0, cng: 0 },
  });

  // Sales: April 2026 (first), no May, June, July, August, and September so
  // far. "Now" is 11 Sep 2026, India time.
  const now = atBusinessTime("2026-09-11", 12, 0);
  const sale = (day, quantity, user = customer._id, hour = 10) =>
    Booking.create({
      user,
      station: station._id,
      fuelType: "Petrol",
      quantity,
      price: 100,
      amount: quantity * 100 + 5,
      bookingDate: day,
      timeSlot: "10:00 AM",
      status: "completed",
      completionTime: atBusinessTime(day, hour, 0),
      // A real sale: fuelled and paid at the pump. Revenue history counts only
      // bookings whose payment was received (services/payment/revenue.js).
      payMethod: "station",
      paymentStatus: "paid",
      collectedAt: atBusinessTime(day, hour, 0),
    });
  await Promise.all([
    sale("2026-04-20", 300),
    sale("2026-06-10", 500),
    sale("2026-07-10", 400),
    sale("2026-08-31", 600, customer._id, 23), // 23:00 IST on 31 Aug is still August
    sale("2026-09-05", 50, vendor._id),
    // Booked for later but not yet completed: never counted.
    Booking.create({ user: otherVendor._id, station: station._id, fuelType: "Petrol", quantity: 999, price: 100, amount: 99905, bookingDate: "2026-09-20", timeSlot: "10:00 AM", status: "upcoming" }),
  ]);

  const fakeRes = () => ({
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  });

  try {
    await t.test("history starts at the first sale, keeps real zero months, marks the running month", async () => {
      const h = await salesHistory({ stationId: station._id, fuel: "petrol", now });
      assert.deepEqual(
        h.months.map((m) => [m.month, m.value, m.complete]),
        [
          ["2026-04", 300, true],
          ["2026-05", 0, true],
          ["2026-06", 500, true],
          ["2026-07", 400, true],
          ["2026-08", 600, true],
          ["2026-09", 50, false],
        ],
      );
      assert.equal(h.totalBookings, 5);
      assert.equal(h.nonCustomerBookings, 1, "the vendor's own booking is reported");
      assert.equal(h.saleDays, 5);
      assert.equal(h.current.daysElapsed, 11);
      assert.ok(h.daysObserved >= 143 && h.daysObserved <= 145);

      const revenue = await salesHistory({ stationId: station._id, metric: "revenue", now });
      assert.equal(revenue.months.find((m) => m.month === "2026-06").value, 50005);
    });

    await t.test("forecast uses the 5 complete months, smoothing without a trend", async () => {
      const h = await monthlyDemand(station._id, "petrol", { now });
      const f = forecastFromHistory(h);
      assert.equal(f.ready, true);
      assert.equal(f.completeMonths, 5);
      assert.equal(f.method, "exponential-smoothing");
      assert.equal(f.forMonth, "2026-10");
      assert.equal(typeof f.errorPercent, "number");
    });

    await t.test("demand is customer sales: vendor/admin bookings are counted out and reported", async () => {
      const all = await salesHistory({ stationId: station._id, fuel: "petrol", now });
      const demand = await monthlyDemand(station._id, "petrol", { now });
      assert.equal(all.basis, "all-sales");
      assert.equal(all.months.at(-1).value, 50, "the vendor's September sale is in the raw history");
      assert.equal(all.excludedBookings, 0);

      assert.equal(demand.basis, "customer-sales");
      assert.equal(demand.months.at(-1).value, 0, "but not in demand");
      assert.equal(demand.totalBookings, 4);
      assert.equal(demand.excludedBookings, 1);
      assert.equal(demand.nonCustomerBookings, 1);
      assert.equal(demand.months[0].month, "2026-04", "demand still starts at the first customer sale");
      assert.match(forecastFromHistory(demand).note, /1 sale booked by vendor or admin accounts is not counted\./);
    });

    await t.test("a fuel sold only through vendor accounts has no demand to forecast", async () => {
      await Booking.create({
        user: vendor._id,
        station: station._id,
        fuelType: "CNG",
        quantity: 20,
        price: 80,
        amount: 1605,
        bookingDate: "2026-08-10",
        timeSlot: "10:00 AM",
        status: "completed",
        completionTime: atBusinessTime("2026-08-10", 10, 0),
        payMethod: "station",
        paymentStatus: "paid",
        collectedAt: atBusinessTime("2026-08-10", 10, 0),
      });
      const h = await monthlyDemand(station._id, "cng", { now });
      assert.deepEqual(h.months, []);
      const f = forecastFromHistory(h);
      assert.equal(f.ready, false);
      assert.equal(f.reason, "No completed customer sales yet (1 booked by vendor or admin accounts is not counted).");

      const raw = await salesHistory({ stationId: station._id, fuel: "cng", now });
      assert.equal(raw.totalBookings, 1, "the raw history still shows it");
    });

    await t.test("daily demand: complete India days only, zero-filled from the first sale, customers only", async () => {
      const { dailyDemand } = require("../src/services/inventory/demandHistory");
      const { reorderPlan } = require("../src/services/algorithms/forecast");

      // On 31 Aug the 23:00 sale that day is still "today" and not counted;
      // 90 days back reaches the 10 Jun sale.
      const aug = await dailyDemand(station._id, "petrol", { now: atBusinessTime("2026-08-31", 12, 0), maxDays: 90 });
      assert.equal(aug.firstSaleDate, "2026-06-10");
      assert.equal(aug.days.at(-1).date, "2026-08-30", "today is left out");
      assert.equal(aug.completeDays, 21 + 31 + 30, "10 Jun to 30 Aug inclusive");
      assert.deepEqual(
        aug.days.filter((d) => d.quantity > 0).map((d) => [d.date, d.quantity]),
        [["2026-06-10", 500], ["2026-07-10", 400]],
      );
      assert.equal(aug.excludedBookings, 0);

      // On 11 Sep the window starts 13 Jun: the 10 Jun sale is out, the vendor's 5 Sep sale is counted out.
      const sep = await dailyDemand(station._id, "petrol", { now });
      assert.equal(sep.firstSaleDate, "2026-07-10");
      assert.equal(sep.completeDays, 22 + 31 + 10);
      assert.equal(sep.days.find((d) => d.date === "2026-09-05").quantity, 0, "the vendor's sale is not demand");
      assert.equal(sep.excludedBookings, 1);
      assert.equal(sep.basis, "customer-sales");

      const plan = reorderPlan({ daily: sep, leadTimeDays: 3, serviceLevel: 95, available: 800 });
      assert.equal(plan.ready, true);
      assert.equal(plan.sampleDays, 63);
      assert.ok(plan.variability > 1, "two sales in 63 days is very erratic demand");
    });

    await t.test("GET forecast: owner only, validated, reorder against available stock", async () => {
      const req = (user, query) => ({ params: { id: String(station._id) }, query, user: { id: String(user._id), role: "vendor" } });

      let res = fakeRes();
      await vendorPanel.getForecast(req(otherVendor, { fuel: "petrol" }), res);
      assert.equal(res.statusCode, 404, "another vendor's station is not found");

      for (const query of [
        { fuel: "hydrogen" },
        { fuel: "petrol", leadTimeDays: "-1" },
        { fuel: "petrol", leadTimeDays: "31" },
        { fuel: "petrol", serviceLevel: "80" },
        { fuel: "petrol", serviceLevel: "abc" },
      ]) {
        res = fakeRes();
        await vendorPanel.getForecast(req(vendor, query), res);
        assert.equal(res.statusCode, 400, JSON.stringify(query));
      }

      // Real "now": every sale above is in the past, so the complete months include them.
      res = fakeRes();
      await vendorPanel.getForecast(req(vendor, { fuel: "Petrol", leadTimeDays: "3" }), res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.unit, "L");
      assert.equal(res.body.stock.available, 800, "900 in the tank less 100 held for bookings");
      assert.equal(res.body.history.months[0].month, "2026-04");
      assert.equal(res.body.forecast.ready, true);
      // Whether the daily window still holds these back-dated sales depends on
      // today's date, so assert the contract rather than a fixed outcome.
      const plan = res.body.reorder;
      assert.equal(typeof plan.ready, "boolean", JSON.stringify(res.body));
      assert.equal(plan.serviceLevel, 95);
      assert.equal(plan.leadTimeDays, 3);
      assert.equal(res.body.reorderReason, plan.ready ? null : plan.reason);
      if (plan.ready) {
        assert.equal(plan.available, 800, "planned against stock not held for bookings");
        assert.equal(plan.cycleBasis, "forecast", "orders for the monthly forecast when there is one");
      }
      assert.equal(res.body.dailyHistory.basis, "customer-sales");

      res = fakeRes();
      await vendorPanel.getForecast(req(vendor, { fuel: "petrol", serviceLevel: "99" }), res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.reorder.serviceLevel, 99);

      res = fakeRes();
      await vendorPanel.getForecast(req(vendor, { fuel: "cng" }), res);
      assert.equal(res.body.forecast.ready, false, "no customer CNG sales");
      assert.match(res.body.forecast.reason, /^No completed customer sales yet/);
      assert.equal(res.body.history.basis, "customer-sales");
      assert.equal(res.body.history.excludedBookings, 1);
      assert.equal(res.body.reorder.ready, false);
      assert.match(res.body.reorderReason, /No customer sales history yet/);
    });

    await t.test("admin dashboard revenue forecast is the gated object, with its evidence", async () => {
      const express = require("express");
      const jwt = require("jsonwebtoken");
      const admin = await User.create({ name: `${tag}-admin`, email: `${tag}-a@example.com`, password: "x", role: "admin" });
      const app = express().use("/a", require("../src/routes/adminRoutes"));
      const server = app.listen(0);
      try {
        const token = jwt.sign({ user: { id: String(admin._id), role: "admin" } }, process.env.JWT_SECRET, { expiresIn: "5m" });
        const r = await fetch(`http://127.0.0.1:${server.address().port}/a/dashboard`, {
          headers: { "x-auth-token": token, Authorization: `Bearer ${token}` },
        });
        const body = await r.json();
        assert.equal(r.status, 200, JSON.stringify(body));
        const f = body.revenue.forecastNextMonth;
        assert.equal(typeof f.ready, "boolean");
        assert.ok("errorPercent" in f && !("confidence" in f));
        assert.equal(body.revenue.history.basis, "customer-sales", "the forecast's evidence is customer sales");
        assert.ok(body.revenue.history.totalBookings >= 4);
        assert.ok(body.revenue.history.excludedBookings >= 2, "the vendor's petrol and CNG sales are counted out");
        assert.ok(body.revenue.total >= body.revenue.history.totalBookings, "revenue totals still include every sale");
        assert.ok(body.revenue.monthly.length >= 1 && body.revenue.monthly.length <= 6);
        assert.ok(body.revenue.monthly.every((m) => typeof m.complete === "boolean"));
      } finally {
        server.close();
        await User.deleteOne({ _id: admin._id });
      }
    });
  } finally {
    await Booking.deleteMany({ station: station._id });
    await Station.deleteOne({ _id: station._id });
    await User.deleteMany({ _id: { $in: [vendor._id, otherVendor._id, customer._id] } });
    await mongoose.disconnect();
  }
});
