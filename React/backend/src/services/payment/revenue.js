/**
 * Revenue: the one definition every dashboard, report and list uses.
 *
 * A booking is revenue when BOTH are true:
 *   - the fuel was dispensed: status "completed" (its stock was deducted once,
 *     services/booking/bookingCompletion.js)
 *   - the money was received: paymentStatus "paid" and, for a pay-at-the-pump
 *     booking, a recorded collection (collectedAt -- set by the attendant's
 *     PIN/QR check-in or the "Collect payment" action). A pump booking that
 *     finished without a recorded collection is "awaiting collection", not revenue.
 *
 * Cancelled, expired, no-show, waitlisted, still-fuelling and unpaid bookings are
 * never revenue.
 *
 * Amount = what the station was actually paid: the booking's stored `amount`,
 * priced by the server when it was booked (price per unit x quantity +
 * convenience fee, services/booking/bookingCreate.js), LESS any reward-points
 * discount (`payableAmount`). Revenue is money received, and a customer who
 * spent points handed over less of it; the points discount is reported
 * separately as `rewardDiscount` so the two add back up to the gross bill.
 * `fuelValue` (price x quantity) and `fees` are reported beside them.
 *
 * Every figure is a database aggregation over booking documents, so a repeated
 * socket event or API call re-reads the same rows: a booking is counted once,
 * and nothing is ever summed on the client.
 *
 * Revenue is dated when it was earned: the later of completion and collection.
 */

const mongoose = require("mongoose");
const Booking = require("../../models/Booking");
const { startOfBusinessDay, startOfBusinessMonth, TIME_ZONE } = require("../../config/businessTime");

const DAY_MS = 24 * 60 * 60 * 1000;

const REVENUE_MATCH = Object.freeze({
  status: "completed",
  paymentStatus: "paid",
  $or: [{ payMethod: { $ne: "station" } }, { collectedAt: { $ne: null } }],
});

/** Fuelled (or being fuelled) at the pump, payment not recorded yet. */
const AWAITING_COLLECTION_MATCH = Object.freeze({
  payMethod: "station",
  paymentStatus: "due_at_station",
  status: { $in: ["serving", "completed"] },
});

/** When a revenue booking earned its money. */
const REVENUE_AT = {
  $max: [{ $ifNull: ["$completionTime", "$createdAt"] }, { $ifNull: ["$collectedAt", "$completionTime"] }],
};

/**
 * What the station was actually paid for a booking, as a Mongo expression.
 *
 * The mirror of services/payment/payMethod.js payableOf, for aggregations: a
 * bookings without payableAmount (made before reward points existed) owed the
 * full amount.
 */
const COLLECTED = { $ifNull: ["$payableAmount", "$amount"] };

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const toIds = (ids) =>
  ids.map((id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id))));

/** The same rule as REVENUE_MATCH, for a booking already in memory. */
function isRevenueBooking(b) {
  if (!b || b.status !== "completed" || b.paymentStatus !== "paid") return false;
  return b.payMethod !== "station" || Boolean(b.collectedAt);
}

const TOTALS = {
  _id: null,
  revenue: { $sum: COLLECTED },
  rewardDiscount: { $sum: { $ifNull: ["$rewardDiscount", 0] } },
  fuelValue: { $sum: { $multiply: [{ $ifNull: ["$price", 0] }, { $ifNull: ["$quantity", 0] }] } },
  fees: { $sum: { $ifNull: ["$taxes", 0] } },
  quantity: { $sum: { $ifNull: ["$quantity", 0] } },
  transactions: { $sum: 1 },
};

function totalsOf(rows) {
  const r = rows && rows[0];
  return {
    revenue: round2(r?.revenue),
    // What reward points paid for, over the same bookings. Not revenue (no
    // money arrived for it) but reported so revenue + rewardDiscount reconciles
    // to the bills that were issued.
    rewardDiscount: round2(r?.rewardDiscount),
    fuelValue: round2(r?.fuelValue),
    fees: round2(r?.fees),
    quantity: round2(r?.quantity),
    transactions: r?.transactions || 0,
  };
}

/**
 * Today (India day), the last 7 days including today, this India month and all
 * time, plus this month by fuel and what is still awaiting collection.
 *
 * @param {object} [opts]
 * @param {Array} [opts.stationIds] limit to these stations (a vendor's); omit for the whole network
 * @param {Date} [opts.now]
 */
async function revenueSummary({ stationIds = null, now = new Date() } = {}) {
  const scope = stationIds ? { station: { $in: toIds(stationIds) } } : {};
  const dayStart = startOfBusinessDay(now);
  const weekStart = new Date(dayStart.getTime() - 6 * DAY_MS);
  const monthStart = startOfBusinessMonth(now);
  const since = (from) => [{ $match: { revenueAt: { $gte: from } } }, { $group: TOTALS }];

  const [[row], [pending]] = await Promise.all([
    Booking.aggregate([
      { $match: { ...scope, ...REVENUE_MATCH } },
      { $addFields: { revenueAt: REVENUE_AT } },
      {
        $facet: {
          today: since(dayStart),
          week: since(weekStart),
          month: since(monthStart),
          allTime: [{ $group: TOTALS }],
          monthByFuel: [{ $match: { revenueAt: { $gte: monthStart } } }, { $group: { ...TOTALS, _id: "$fuelType" } }],
        },
      },
    ]),
    Booking.aggregate([
      { $match: { ...scope, ...AWAITING_COLLECTION_MATCH } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: COLLECTED } } },
    ]),
  ]);

  return {
    today: totalsOf(row.today),
    week: totalsOf(row.week),
    month: totalsOf(row.month),
    allTime: totalsOf(row.allTime),
    monthByFuel: Object.fromEntries(
      row.monthByFuel.map((f) => [
        f._id || "Unknown",
        { quantity: round2(f.quantity), revenue: round2(f.revenue), transactions: f.transactions },
      ]),
    ),
    awaitingCollection: { count: pending?.count || 0, amount: round2(pending?.amount) },
    basis: "Completed bookings whose payment was received",
    asOf: now.toISOString(),
  };
}

/** stationId -> { revenue, transactions } for these stations, all time. */
async function revenueByStation(stationIds) {
  if (!stationIds || stationIds.length === 0) return new Map();
  const rows = await Booking.aggregate([
    { $match: { station: { $in: toIds(stationIds) }, ...REVENUE_MATCH } },
    { $group: { _id: "$station", revenue: { $sum: COLLECTED }, transactions: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { revenue: round2(r.revenue), transactions: r.transactions }]));
}

/**
 * This month's revenue split into calendar weeks: 1-7, 8-14, 15-21, 22-28 and
 * the tail (29 to the last day).
 *
 * A month is one bar on the yearly trend, which tells an admin nothing about
 * the month they are standing in. Fixed date ranges rather than ISO weeks,
 * because the labels have to read as dates a person recognises ("15-21 Sep"),
 * and the same revenue rule as everything else (REVENUE_MATCH), so the five
 * buckets add up to the month figure beside them.
 *
 * Buckets that have not happened yet are still returned, at zero: a chart
 * that grows a bar each week is easier to read than one that changes shape.
 *
 * @param {object} [opts]
 * @param {Array} [opts.stationIds] limit to these stations; omit for the network
 * @param {Date} [opts.now]
 * @returns {Promise<Array<{label: string, from: string, to: string, revenue: number, transactions: number}>>}
 */
async function revenueWeeksThisMonth({ stationIds = null, now = new Date() } = {}) {
  const scope = stationIds ? { station: { $in: toIds(stationIds) } } : {};
  const monthStart = startOfBusinessMonth(now);
  const nextMonth = startOfBusinessMonth(new Date(monthStart.getTime() + 32 * DAY_MS));
  const lastDay = Math.round((nextMonth - monthStart) / DAY_MS);
  const monthName = monthStart.toLocaleString("en-US", { month: "short", timeZone: TIME_ZONE });

  const edges = [1, 8, 15, 22, 29].filter((d) => d <= lastDay);
  const buckets = edges.map((startDay, i) => {
    const endDay = Math.min((edges[i + 1] ?? lastDay + 1) - 1, lastDay);
    return {
      label: `${startDay}-${endDay} ${monthName}`,
      from: new Date(monthStart.getTime() + (startDay - 1) * DAY_MS),
      to: new Date(monthStart.getTime() + endDay * DAY_MS), // exclusive
      revenue: 0,
      transactions: 0,
    };
  });

  const rows = await Booking.aggregate([
    { $match: { ...scope, ...REVENUE_MATCH } },
    { $addFields: { revenueAt: REVENUE_AT } },
    { $match: { revenueAt: { $gte: monthStart, $lt: nextMonth } } },
    { $group: { _id: null, sales: { $push: { at: "$revenueAt", amount: COLLECTED } } } },
  ]);

  for (const sale of rows[0]?.sales ?? []) {
    const at = new Date(sale.at);
    const bucket = buckets.find((b) => at >= b.from && at < b.to);
    if (!bucket) continue;
    bucket.revenue += Number(sale.amount) || 0;
    bucket.transactions += 1;
  }

  return buckets.map((b) => ({
    label: b.label,
    from: b.from.toISOString(),
    to: b.to.toISOString(),
    revenue: round2(b.revenue),
    transactions: b.transactions,
  }));
}

module.exports = {
  REVENUE_MATCH,
  AWAITING_COLLECTION_MATCH,
  REVENUE_AT,
  isRevenueBooking,
  revenueSummary,
  revenueWeeksThisMonth,
  revenueByStation,
};
