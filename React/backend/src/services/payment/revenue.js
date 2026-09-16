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
 * Amount = the booking's stored `amount`, priced by the server when it was booked
 * (price per unit x quantity + convenience fee, services/booking/bookingCreate.js).
 * `fuelValue` (price x quantity) and `fees` are reported beside it.
 *
 * Every figure is a database aggregation over booking documents, so a repeated
 * socket event or API call re-reads the same rows: a booking is counted once,
 * and nothing is ever summed on the client.
 *
 * Revenue is dated when it was earned: the later of completion and collection.
 */

const mongoose = require("mongoose");
const Booking = require("../../models/Booking");
const { startOfBusinessDay, startOfBusinessMonth } = require("../../config/businessTime");

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
  revenue: { $sum: "$amount" },
  fuelValue: { $sum: { $multiply: [{ $ifNull: ["$price", 0] }, { $ifNull: ["$quantity", 0] }] } },
  fees: { $sum: { $ifNull: ["$taxes", 0] } },
  quantity: { $sum: { $ifNull: ["$quantity", 0] } },
  transactions: { $sum: 1 },
};

function totalsOf(rows) {
  const r = rows && rows[0];
  return {
    revenue: round2(r?.revenue),
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
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amount" } } },
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
    { $group: { _id: "$station", revenue: { $sum: "$amount" }, transactions: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { revenue: round2(r.revenue), transactions: r.transactions }]));
}

module.exports = {
  REVENUE_MATCH,
  AWAITING_COLLECTION_MATCH,
  REVENUE_AT,
  isRevenueBooking,
  revenueSummary,
  revenueByStation,
};
