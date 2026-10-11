/**
 * Distributions: the shapes an average hides.
 *
 * The dashboards already report totals and trends. What they cannot say is
 * whether a 6-minute average wait means everybody waits six minutes, or most
 * people wait two and a few wait twenty — and those are different businesses
 * with different problems. These three aggregations answer that, each from
 * rows the app already writes:
 *
 *   waitingTimes    arrivalTime -> fuelingStartTime, which is MEASURED:
 *                   the customer checked in at the pump
 *                   (services/queue/nozzleService.js sets arrivalTime) and the
 *                   nozzle later started them (fuelingStartTime). It is not
 *                   the estimate shown before booking.
 *   fuelQuantities  how much people actually buy, per fuel.
 *   demandByHour    bookings by day of week and hour, for the peaks.
 *
 * HONESTY RULES
 *
 *   - A bucket is only ever a count of real rows. Nothing is smoothed,
 *     interpolated or back-filled.
 *   - Every function reports `total`, so a caller can refuse to draw a
 *     distribution built from four bookings. A histogram of noise looks
 *     exactly like a histogram of fact, which is why the count travels with
 *     the data instead of being left to the chart.
 *   - Scoped by station when asked, so a vendor sees only their own pumps.
 */

const mongoose = require("mongoose");
const Booking = require("../../models/Booking");
const { TIME_ZONE } = require("../../config/businessTime");

const toIds = (ids) =>
  (ids || []).map((id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id))));

const scopeOf = (stationIds) => (stationIds ? { station: { $in: toIds(stationIds) } } : {});
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/**
 * How long people waited at the pump, in minutes.
 *
 * Only bookings that have both timestamps: a customer who never checked in
 * never waited, and including them as a zero would flatter every figure.
 *
 * @returns {{buckets: Array<{label, from, to, count}>, total, median, p90, longest}}
 */
async function waitingTimes({ stationIds = null, days = 30, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const rows = await Booking.aggregate([
    {
      $match: {
        ...scopeOf(stationIds),
        arrivalTime: { $ne: null, $gte: since },
        fuelingStartTime: { $ne: null },
      },
    },
    {
      $project: {
        waitMinutes: { $divide: [{ $subtract: ["$fuelingStartTime", "$arrivalTime"] }, 60000] },
      },
    },
    // A negative wait means the clock moved or the rows were written out of
    // order; it is not a measurement, so it is dropped rather than shown.
    { $match: { waitMinutes: { $gte: 0 } } },
    { $sort: { waitMinutes: 1 } },
    { $group: { _id: null, waits: { $push: "$waitMinutes" } } },
  ]);

  const waits = rows[0]?.waits ?? [];
  if (waits.length === 0) return { buckets: [], total: 0, median: null, p90: null, longest: null };

  // Fixed edges rather than computed ones: a customer thinks in "under five
  // minutes" and "over twenty", and buckets that move with the data cannot be
  // compared between two weeks.
  const edges = [0, 2, 5, 10, 15, 20, 30];
  const buckets = edges.map((from, i) => {
    const to = edges[i + 1] ?? null;
    return {
      label: to === null ? `${from}+ min` : `${from}–${to} min`,
      from,
      to,
      count: waits.filter((w) => w >= from && (to === null || w < to)).length,
    };
  });

  const at = (q) => round1(waits[Math.min(waits.length - 1, Math.floor(waits.length * q))]);
  return {
    buckets,
    total: waits.length,
    median: at(0.5),
    p90: at(0.9),
    longest: round1(waits[waits.length - 1]),
  };
}

/**
 * How much fuel people actually buy, per fuel.
 *
 * Litres for petrol and diesel, kilograms for CNG, so the buckets are per
 * fuel rather than one scale across all three — 40 kg of CNG and 40 L of
 * petrol are not comparable quantities.
 */
async function fuelQuantities({ stationIds = null, days = 30, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const rows = await Booking.aggregate([
    {
      $match: {
        ...scopeOf(stationIds),
        status: "completed",
        completionTime: { $ne: null, $gte: since },
        quantity: { $gt: 0 },
      },
    },
    { $group: { _id: "$fuelType", quantities: { $push: "$quantity" } } },
  ]);

  const EDGES = { CNG: [0, 3, 6, 9, 12, 15], DEFAULT: [0, 5, 10, 20, 30, 40, 50] };

  return rows
    .map((row) => {
      const fuel = row._id || "Unknown";
      const unit = String(fuel).toLowerCase() === "cng" ? "kg" : "L";
      const edges = String(fuel).toLowerCase() === "cng" ? EDGES.CNG : EDGES.DEFAULT;
      const list = row.quantities;

      return {
        fuel,
        unit,
        total: list.length,
        average: round1(list.reduce((a, b) => a + b, 0) / list.length),
        buckets: edges.map((from, i) => {
          const to = edges[i + 1] ?? null;
          return {
            label: to === null ? `${from}+` : `${from}–${to}`,
            from,
            to,
            count: list.filter((q) => q >= from && (to === null || q < to)).length,
          };
        }),
      };
    })
    .sort((a, b) => b.total - a.total);
}

/**
 * When people book: day of week against hour of day.
 *
 * Grouped in India time, because a station's busy hour is a local fact and
 * MongoDB would otherwise bucket by UTC and shift every peak by five and a
 * half hours.
 *
 * @returns {{cells: Array<{day, hour, count}>, days: string[], hours: number[], total, busiest}}
 */
async function demandByHour({ stationIds = null, days = 30, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const rows = await Booking.aggregate([
    { $match: { ...scopeOf(stationIds), createdAt: { $gte: since } } },
    {
      $group: {
        // $dayOfWeek is 1=Sunday..7=Saturday in the given timezone.
        _id: {
          day: { $dayOfWeek: { date: "$createdAt", timezone: TIME_ZONE } },
          hour: { $hour: { date: "$createdAt", timezone: TIME_ZONE } },
        },
        count: { $sum: 1 },
      },
    },
  ]);

  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const cells = rows.map((r) => ({
    day: DAYS[(r._id.day || 1) - 1],
    dayIndex: (r._id.day || 1) - 1,
    hour: r._id.hour ?? 0,
    count: r.count,
  }));

  const total = cells.reduce((sum, c) => sum + c.count, 0);
  const busiest = cells.reduce((best, c) => (!best || c.count > best.count ? c : best), null);

  return {
    cells,
    days: DAYS,
    // Only the hours a station can actually be booked for; a 24-wide grid of
    // mostly empty cells says less than a 16-wide one that is all signal.
    hours: Array.from({ length: 17 }, (_, i) => i + 6), // 06:00 — 22:00
    total,
    busiest: busiest ? { day: busiest.day, hour: busiest.hour, count: busiest.count } : null,
  };
}

module.exports = { waitingTimes, fuelQuantities, demandByHour };
