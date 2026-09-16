/**
 * Sales history for forecasting: what was actually sold, by India month.
 *
 * What a forecast can honestly be built on:
 *   - completed bookings only, dated when the fuel was dispensed
 *     (completionTime, else the slot time, else when it was booked)
 *   - months from the FIRST sale onward. Months before the station ever sold
 *     anything are not "zero demand" -- there is no data for them -- so they
 *     are not invented. A month after the first sale with no sales is a real
 *     zero and is kept.
 *   - the running month is marked `complete: false`: ten days of September is
 *     not a September, and fitting it as one would drag every forecast down.
 *   - with `customersOnly`, only bookings made by customer accounts. Bookings
 *     made by vendor or admin accounts are usually testing -- in the real
 *     history, 30 of the first 36 sales came from one vendor account -- and
 *     counting them as demand would make every forecast describe the tests.
 *     They are counted out and reported (`excludedBookings`), never hidden.
 *     monthlyDemand (the demand forecasts) uses it by default; revenue totals,
 *     which are money actually collected, do not.
 *
 * The summary says how much evidence exists (days observed, days with sales,
 * bookings) so callers can show that instead of implying a number is better
 * founded than it is.
 */

const mongoose = require("mongoose");
const Booking = require("../../models/Booking");
const { fuelLabel } = require("../../config/fuels");
const { MONGO_TIMEZONE, dateKey } = require("../../config/businessTime");
const { REVENUE_MATCH } = require("../payment/revenue");

const DAY_MS = 24 * 60 * 60 * 1000;

const monthIndex = (key) => {
  const [y, m] = key.split("-").map(Number);
  return y * 12 + (m - 1);
};
const keyOf = (idx) => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
const daysInMonth = (key) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param {object} [p]
 * @param {string} [p.stationId]    one station
 * @param {string[]} [p.stationIds] several stations (e.g. one vendor's); neither = whole network
 * @param {string} [p.fuel]         one fuel, or all
 * @param {"quantity"|"revenue"} [p.metric]
 * @param {Date} [p.now]
 * @param {number} [p.maxMonths]    cap on how many months back are returned
 * @param {boolean} [p.customersOnly] count only bookings made by customer accounts
 */
async function salesHistory({
  stationId = null,
  stationIds = null,
  fuel = null,
  metric = "quantity",
  now = new Date(),
  maxMonths = 24,
  customersOnly = false,
} = {}) {
  const oid = (id) => new mongoose.Types.ObjectId(String(id));
  // Quantity is fuel dispensed. Revenue is money received: the same rule every
  // revenue figure uses (services/payment/revenue.js).
  const match = metric === "revenue" ? { ...REVENUE_MATCH } : { status: "completed" };
  if (stationId) match.station = oid(stationId);
  else if (stationIds) match.station = { $in: stationIds.map(oid) };
  if (fuel) match.fuelType = fuelLabel(fuel) || fuel;

  const valueField = metric === "revenue" ? "$amount" : "$quantity";
  const base = [
    { $match: match },
    { $addFields: { saleAt: { $ifNull: ["$completionTime", { $ifNull: ["$bookingStartTime", "$createdAt"] }] } } },
    { $match: { saleAt: { $lte: now } } },
    { $lookup: { from: "users", localField: "user", foreignField: "_id", pipeline: [{ $project: { role: 1 } }], as: "u" } },
    { $addFields: { isCustomer: { $eq: [{ $first: "$u.role" }, "customer"] } } },
  ];
  // Whether a row counts towards the history.
  const counted = customersOnly ? "$isCustomer" : true;
  const saleDay = { $dateToString: { format: "%Y-%m-%d", date: "$saleAt", timezone: MONGO_TIMEZONE } };

  const [monthly, summaryRows] = await Promise.all([
    Booking.aggregate([
      ...base,
      ...(customersOnly ? [{ $match: { isCustomer: true } }] : []),
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$saleAt", timezone: MONGO_TIMEZONE } },
          value: { $sum: valueField },
          bookings: { $sum: 1 },
        },
      },
    ]),
    Booking.aggregate([
      ...base,
      {
        $group: {
          _id: null,
          // $min / $max ignore the nulls of rows that do not count.
          first: { $min: { $cond: [counted, "$saleAt", null] } },
          last: { $max: { $cond: [counted, "$saleAt", null] } },
          total: { $sum: { $cond: [counted, valueField, 0] } },
          bookings: { $sum: { $cond: [counted, 1, 0] } },
          days: { $addToSet: { $cond: [counted, saleDay, null] } },
          nonCustomer: { $sum: { $cond: ["$isCustomer", 0, 1] } },
        },
      },
    ]),
  ]);

  const today = dateKey(now);
  const currentKey = today.slice(0, 7);
  const current = { month: currentKey, daysElapsed: Number(today.slice(8, 10)), daysInMonth: daysInMonth(currentKey) };
  const summary = summaryRows[0];
  const nonCustomerBookings = summary?.nonCustomer || 0;
  const evidence = {
    basis: customersOnly ? "customer-sales" : "all-sales",
    nonCustomerBookings,
    excludedBookings: customersOnly ? nonCustomerBookings : 0,
  };

  if (!summary || !summary.first) {
    return {
      metric,
      months: [],
      current,
      firstSaleAt: null,
      lastSaleAt: null,
      daysObserved: 0,
      saleDays: 0,
      totalValue: 0,
      totalBookings: 0,
      ...evidence,
    };
  }

  const byKey = new Map(monthly.map((r) => [r._id, r]));
  const firstKey = dateKey(summary.first).slice(0, 7);
  const start = Math.max(monthIndex(firstKey), monthIndex(currentKey) - (Math.max(1, maxMonths) - 1));
  const months = [];
  for (let i = start; i <= monthIndex(currentKey); i++) {
    const key = keyOf(i);
    const hit = byKey.get(key);
    months.push({
      month: key,
      value: round2(hit?.value || 0),
      bookings: hit?.bookings || 0,
      complete: key !== currentKey,
      days: daysInMonth(key),
    });
  }

  return {
    metric,
    months,
    current,
    firstSaleAt: summary.first,
    lastSaleAt: summary.last,
    daysObserved: Math.max(1, Math.ceil((now.getTime() - new Date(summary.first).getTime()) / DAY_MS)),
    saleDays: summary.days.filter(Boolean).length,
    totalValue: round2(summary.total),
    totalBookings: summary.bookings,
    ...evidence,
  };
}

/**
 * Daily demand for one station and fuel, for measuring how demand varies
 * (services/algorithms/forecast.js reorderPlan).
 *
 *   - complete India days only: today is still running and is left out
 *   - from the first sale in the window onward, zero-filled -- a day with no
 *     sale after the first one is a real zero; days before it are not data
 *   - the last `maxDays` complete days at most
 *   - customer sales only by default, for the same reason as monthlyDemand
 *
 * @returns {Promise<{days:Array<{date:string, quantity:number, bookings:number}>,
 *   completeDays:number, firstSaleDate:string|null, windowDays:number,
 *   basis:string, excludedBookings:number}>}
 */
async function dailyDemand(stationId, fuelType, { now = new Date(), maxDays = 90, customersOnly = true } = {}) {
  const { atBusinessTime } = require("../../config/businessTime");
  const today = dateKey(now);
  const todayStart = atBusinessTime(today, 0, 0);
  const windowStart = new Date(todayStart.getTime() - maxDays * DAY_MS);

  const base = [
    {
      $match: {
        status: "completed",
        station: new mongoose.Types.ObjectId(String(stationId)),
        fuelType: fuelLabel(fuelType) || fuelType,
      },
    },
    { $addFields: { saleAt: { $ifNull: ["$completionTime", { $ifNull: ["$bookingStartTime", "$createdAt"] }] } } },
    { $match: { saleAt: { $gte: windowStart, $lt: todayStart } } },
    { $lookup: { from: "users", localField: "user", foreignField: "_id", pipeline: [{ $project: { role: 1 } }], as: "u" } },
    { $addFields: { isCustomer: { $eq: [{ $first: "$u.role" }, "customer"] } } },
  ];
  const saleDay = { $dateToString: { format: "%Y-%m-%d", date: "$saleAt", timezone: MONGO_TIMEZONE } };

  const [perDay, excludedRows] = await Promise.all([
    Booking.aggregate([
      ...base,
      ...(customersOnly ? [{ $match: { isCustomer: true } }] : []),
      { $group: { _id: saleDay, quantity: { $sum: "$quantity" }, bookings: { $sum: 1 } } },
    ]),
    customersOnly
      ? Booking.aggregate([...base, { $match: { isCustomer: false } }, { $count: "n" }])
      : Promise.resolve([]),
  ]);

  const result = {
    days: [],
    completeDays: 0,
    firstSaleDate: null,
    windowDays: maxDays,
    basis: customersOnly ? "customer-sales" : "all-sales",
    excludedBookings: excludedRows[0]?.n || 0,
  };
  if (perDay.length === 0) return result;

  const byDay = new Map(perDay.map((r) => [r._id, r]));
  const first = perDay.map((r) => r._id).sort()[0];
  // Walk India days from the first sale to yesterday (noon avoids any edge).
  for (let t = atBusinessTime(first, 12, 0).getTime(); dateKey(new Date(t)) < today; t += DAY_MS) {
    const key = dateKey(new Date(t));
    const hit = byDay.get(key);
    result.days.push({ date: key, quantity: round2(hit?.quantity || 0), bookings: hit?.bookings || 0 });
  }
  result.completeDays = result.days.length;
  result.firstSaleDate = first;
  return result;
}

/**
 * One station's DEMAND for one fuel: customer sales only unless
 * `customersOnly: false` is passed. Months carry `quantity` as well as `value`.
 */
async function monthlyDemand(stationId, fuelType, opts = {}) {
  const history = await salesHistory({ customersOnly: true, ...opts, stationId, fuel: fuelType, metric: "quantity" });
  return { ...history, months: history.months.map((m) => ({ ...m, quantity: m.value })) };
}

module.exports = { salesHistory, monthlyDemand, dailyDemand, daysInMonth };
