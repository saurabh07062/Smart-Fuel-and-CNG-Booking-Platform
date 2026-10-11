/**
 * Admin / super-admin analytics.  Mounted at /api/superadmin and /api/v1/admin
 *
 * The frontend already called /api/superadmin/dashboard, but no such router
 * was ever mounted, so the page failed with a 404 on every load. This is that
 * router.
 *
 * Everything here is cross-vendor and read-heavy, so the aggregations run
 * server-side rather than shipping raw rows to the browser to be summed.
 */

const express = require("express");
const realtime = require("../services/notification/realtime");
const router = express.Router();

const auth = require("../middleware/auth");
const adminAuth = require("../middleware/admin");
const Station = require("../models/Station");
const Booking = require("../models/Booking");
// Registers the model so `.populate("fleetGroup")` below can resolve it.
// Mongoose looks a populated model up by name at query time, and a name is
// only registered by requiring the file that defines it -- a controller that
// imports its models one by one has to import this one too.
require("../models/FleetBooking");
const User = require("../models/User");
const { forecastFromHistory } = require("../services/algorithms/forecast");
const { salesHistory } = require("../services/inventory/demandHistory");
const { predictWait } = require("../services/algorithms/queue");
const revenueService = require("../services/payment/revenue");
const { dateKey, MONGO_TIMEZONE, startOfBusinessDay, startOfBusinessMonth } = require("../config/businessTime");
const mongoose = require("mongoose");

/**
 * GET /api/superadmin/dashboard
 * Headline counters, today's real activity and money, network fuel stock and
 * the live wait, plus a 6-month revenue series for the chart. Every figure is
 * read from the database; revenue uses the one definition in
 * services/payment/revenue.js (completed bookings whose payment was received).
 */
router.get("/dashboard", adminAuth, async (_req, res) => {
  try {
    const today = dateKey();
    const [
      stationCount,
      activeStations,
      vendorCount,
      pendingVendors,
      customerCount,
      revenue,
      statusRows,
      customerRevenue,
      money,
      weeksThisMonth,
      bookingsToday,
      byHourRows,
      stockStations,
    ] = await Promise.all([
      Station.countDocuments(),
      Station.countDocuments({ status: "Active" }),
      User.countDocuments({ role: "vendor" }),
      User.countDocuments({ role: "vendor", vendorStatus: "pending" }),
      User.countDocuments({ role: "customer" }),
      salesHistory({ metric: "revenue" }),
      Booking.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      // The forecast is of customer demand; vendor/admin test bookings are
      // counted out (services/inventory/demandHistory.js). Totals stay money collected.
      salesHistory({ metric: "revenue", customersOnly: true }),
      revenueService.revenueSummary(),
      // This month split into weeks: the trend an admin standing in the
      // current month can actually act on (services/payment/revenue.js).
      revenueService.revenueWeeksThisMonth(),
      Booking.countDocuments({ bookingDate: today }),
      // Today's bookings by the India hour their slot starts.
      Booking.aggregate([
        { $match: { bookingDate: today, bookingStartTime: { $type: "date" } } },
        {
          $group: {
            _id: { $hour: { date: "$bookingStartTime", timezone: MONGO_TIMEZONE } },
            bookings: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $in: ["$status", ["cancelled", "no_show", "expired"]] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Station.find({ status: "Active" }).select("_id inventory tankCapacity").lean(),
    ]);

    const bookingsByStatus = Object.fromEntries(
      statusRows.map((r) => [r._id || "unknown", r.count]),
    );

    // Network stock from what stations record; capacity null where none is recorded.
    const FUELS = ["petrol", "diesel", "cng"];
    const fuelStock = Object.fromEntries(
      FUELS.map((f) => [f, round2(stockStations.reduce((sum, s) => sum + (Number(s.inventory?.[f]) || 0), 0))]),
    );
    const fuelCapacity = Object.fromEntries(
      FUELS.map((f) => {
        const recorded = stockStations.map((s) => Number(s.tankCapacity?.[f])).filter((c) => Number.isFinite(c) && c > 0);
        return [f, recorded.length ? round2(recorded.reduce((a, b) => a + b, 0)) : null];
      }),
    );

    // The live line at every active station (services/queue/stationQueue.js).
    let liveQueue = { stations: stockStations.length, vehicles: 0, avgWaitMinutes: null };
    if (stockStations.length) {
      const { queueSnapshots } = require("../services/queue/stationQueue");
      const queues = [...(await queueSnapshots(stockStations.map((s) => s._id))).values()];
      const waits = queues.map((q) => Number(q.waitMinutes)).filter(Number.isFinite);
      liveQueue = {
        stations: stockStations.length,
        vehicles: queues.reduce((sum, q) => sum + (Number(q.queueLength) || 0), 0),
        avgWaitMinutes: waits.length ? Math.round((waits.reduce((a, b) => a + b, 0) / waits.length) * 10) / 10 : null,
      };
    }

    res.json({
      stations: { total: stationCount, active: activeStations },
      vendors: { total: vendorCount, pending: pendingVendors },
      customers: { total: customerCount },
      bookings: bookingsByStatus,
      today: {
        date: today,
        bookings: bookingsToday,
        byHour: byHourRows.map((r) => ({ hour: r._id, bookings: r.bookings, completed: r.completed, cancelled: r.cancelled })),
      },
      fuelStock,
      fuelCapacity,
      liveQueue,
      revenue: {
        total: revenue.totalValue,
        today: money.today,
        week: money.week,
        month: money.month,
        allTime: money.allTime,
        awaitingCollection: money.awaitingCollection,
        basis: money.basis,
        asOf: money.asOf,
        monthly: revenueMonths(revenue, 6),
        weeksThisMonth,
        // Gated on how much customer history exists (services/algorithms/forecast.js).
        forecastNextMonth: forecastFromHistory(customerRevenue),
        history: revenueEvidence(customerRevenue),
      },
    });
  } catch (err) {
    console.error("[admin] dashboard failed:", err);
    res.status(500).json({ msg: "Failed to load dashboard" });
  }
});

/**
 * GET /api/v1/admin/customers
 *
 * Every registered customer with what the platform already knows about them:
 * how many bookings they made, how many were completed, what they have paid
 * (the one revenue definition, services/payment/revenue.js) and when they
 * last booked. Read-only, and no password or token field ever leaves here.
 *
 *   ?search=<text>   name, email or phone
 *   ?limit=<n>       default 100, max 500
 */
router.get("/customers", adminAuth, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const query = { role: "customer" };
    const regex = require("../utils/regex").literalSearchRegex(req.query.search);
    if (regex) query.$or = [{ name: regex }, { email: regex }, { phone: regex }];

    const customers = await User.find(query)
      .select("name email phone isVerified createdAt vehicles profileImage")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const ids = customers.map((c) => c._id);
    const [byCustomer, paidByCustomer] = await Promise.all([
      Booking.aggregate([
        { $match: { user: { $in: ids } } },
        {
          $group: {
            _id: "$user",
            bookings: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $in: ["$status", ["cancelled", "no_show", "expired"]] }, 1, 0] } },
            lastBookingAt: { $max: "$createdAt" },
          },
        },
      ]),
      Booking.aggregate([
        { $match: { user: { $in: ids }, ...revenueService.REVENUE_MATCH } },
        { $group: { _id: "$user", spent: { $sum: "$amount" } } },
      ]),
    ]);
    const counts = new Map(byCustomer.map((r) => [String(r._id), r]));
    const spend = new Map(paidByCustomer.map((r) => [String(r._id), r.spent]));

    res.json({
      total: await User.countDocuments({ role: "customer" }),
      returned: customers.length,
      customers: customers.map((c) => {
        const row = counts.get(String(c._id));
        return {
          _id: c._id,
          name: c.name,
          email: c.email,
          phone: c.phone || null,
          isVerified: !!c.isVerified,
          vehicles: Array.isArray(c.vehicles) ? c.vehicles.length : 0,
          joinedAt: c.createdAt,
          bookings: row?.bookings ?? 0,
          completed: row?.completed ?? 0,
          cancelled: row?.cancelled ?? 0,
          lastBookingAt: row?.lastBookingAt ?? null,
          spent: Math.round(((spend.get(String(c._id)) ?? 0) + Number.EPSILON) * 100) / 100,
        };
      }),
    });
  } catch (err) {
    console.error("[admin] customers failed:", err);
    res.status(500).json({ msg: "Failed to load customers" });
  }
});

/**
 * GET /api/v1/admin/activity
 *
 * The newest things that happened on the platform: bookings, payments
 * collected at the pump, vendor registrations and station changes -- each
 * read from the records that already carry the time it happened, merged and
 * sorted newest first. Nothing is stored for this; it is a read of what
 * exists.
 *
 *   ?limit=<n>   entries per kind, default 8, max 25
 */
/**
 * GET /api/v1/admin/stations/:id/overview
 *
 * Everything an admin wants the moment they pick a station out of the list:
 * how it is performing, what is in its tanks, who owns it, and what has just
 * happened there.
 *
 * Assembled here rather than in the browser because it is five questions of
 * the database, and asking them one screen at a time is how a page ends up
 * making nine requests and still showing half a picture. Every figure is a
 * real aggregation: revenue uses the ONE definition
 * (services/payment/revenue.js -- completed bookings whose payment was
 * received), the queue is the same live simulation every other page reads,
 * and stock is what the station itself records. Nothing is estimated, and a
 * metric with no data answers null rather than a made-up zero.
 */
router.get("/stations/:id/overview", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ msg: "That is not a station id." });

    const station = await Station.findById(id).lean();
    if (!station) return res.status(404).json({ msg: "Station not found" });

    const stationId = station._id;
    const today = dateKey();
    const monthStart = startOfBusinessMonth(new Date());
    const { queueSnapshots, fuelQueueSummary } = require("../services/queue/stationQueue");

    const [statusRows, todayCount, monthCount, revenueRows, fuelMonthRows, monthlyRows, vendor, queues, recent] =
      await Promise.all([
        Booking.aggregate([{ $match: { station: stationId } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
        Booking.countDocuments({ station: stationId, bookingDate: today }),
        Booking.countDocuments({ station: stationId, bookingDate: { $gte: dateKey(monthStart) } }),
        Booking.aggregate([
          { $match: { station: stationId, ...revenueService.REVENUE_MATCH } },
          { $addFields: { revenueAt: revenueService.REVENUE_AT } },
          {
            $facet: {
              today: [
                { $match: { revenueAt: { $gte: startOfBusinessDay(new Date()) } } },
                { $group: { _id: null, revenue: { $sum: "$amount" }, bookings: { $sum: 1 } } },
              ],
              month: [
                { $match: { revenueAt: { $gte: monthStart } } },
                { $group: { _id: null, revenue: { $sum: "$amount" }, bookings: { $sum: 1 } } },
              ],
              allTime: [{ $group: { _id: null, revenue: { $sum: "$amount" }, bookings: { $sum: 1 } } }],
            },
          },
        ]),
        Booking.aggregate([
          { $match: { station: stationId, ...revenueService.REVENUE_MATCH } },
          { $addFields: { revenueAt: revenueService.REVENUE_AT } },
          { $match: { revenueAt: { $gte: monthStart } } },
          {
            $group: {
              _id: "$fuelType",
              quantity: { $sum: { $ifNull: ["$quantity", 0] } },
              revenue: { $sum: "$amount" },
              bookings: { $sum: 1 },
            },
          },
        ]),
        Booking.aggregate([
          { $match: { station: stationId, ...revenueService.REVENUE_MATCH } },
          { $addFields: { revenueAt: revenueService.REVENUE_AT } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$revenueAt", timezone: MONGO_TIMEZONE } },
              revenue: { $sum: "$amount" },
              bookings: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
          { $limit: 24 },
        ]),
        station.owner
          ? User.findById(station.owner)
              .select("name businessName email phone vendorStatus vendorCode activated createdAt")
              .lean()
          : null,
        queueSnapshots([stationId]),
        Booking.find({ station: stationId })
          .sort({ updatedAt: -1 })
          .limit(8)
          .select("orderId status fuelType quantity amount paymentStatus collectedAt updatedAt createdAt user")
          .populate("user", "name")
          .lean(),
      ]);

    const byStatus = Object.fromEntries(statusRows.map((r) => [r._id, r.count]));
    const totals = revenueRows[0] || {};
    const money = (rows) => ({ revenue: round2(rows && rows[0] && rows[0].revenue), bookings: (rows && rows[0] && rows[0].bookings) || 0 });
    const snapshot = queues.get(String(stationId)) || null;
    const prices = station.prices || {};
    const stock = station.inventory || {};
    const capacity = station.tankCapacity || {};
    const soldByFuel = Object.fromEntries(fuelMonthRows.map((r) => [String(r._id || "").toLowerCase(), r]));

    // Only the fuels this station actually sells. One it sells but has not
    // sold this month reads zero -- that is a fact, not a gap.
    const fuels = (station.fuelTypes || []).map((label) => {
      const key = String(label).toLowerCase();
      const sold = soldByFuel[key];
      return {
        fuel: label,
        price: typeof prices[key] === "number" && prices[key] > 0 ? prices[key] : null,
        stock: typeof stock[key] === "number" ? stock[key] : null,
        capacity: typeof capacity[key] === "number" ? capacity[key] : null,
        unit: key === "cng" ? "kg" : "L",
        soldThisMonth: round2(sold && sold.quantity),
        revenueThisMonth: round2(sold && sold.revenue),
        bookingsThisMonth: (sold && sold.bookings) || 0,
      };
    });

    res.json({
      station: {
        id: String(station._id),
        name: station.name,
        address: station.address,
        city: station.city || null,
        status: station.status,
        openingHours: station.openingHours || null,
        fuelTypes: station.fuelTypes || [],
        coordinates: station.coordinates || null,
        createdAt: station.createdAt,
        updatedAt: station.updatedAt,
      },
      vendor: vendor
        ? {
            id: String(vendor._id),
            name: vendor.name,
            businessName: vendor.businessName || null,
            email: vendor.email,
            phone: vendor.phone || null,
            vendorCode: vendor.vendorCode || null,
            vendorStatus: vendor.vendorStatus || null,
            activated: vendor.activated === undefined ? null : vendor.activated,
            registeredAt: vendor.createdAt,
          }
        : null,
      bookings: {
        byStatus,
        total: statusRows.reduce((t, r) => t + r.count, 0),
        today: todayCount,
        thisMonth: monthCount,
      },
      revenue: {
        today: money(totals.today),
        month: money(totals.month),
        allTime: money(totals.allTime),
        basis: "Completed bookings whose payment was received",
      },
      monthlySales: monthlyRows.map((m) => ({ month: m._id, revenue: round2(m.revenue), bookings: m.bookings })),
      fuels,
      queue: snapshot
        ? {
            waiting: snapshot.queueLength,
            waitMinutes: snapshot.waitMinutes,
            queueStatus: snapshot.queueStatus,
            lineClearsAt: snapshot.lineClearsAt || null,
            byFuel: fuelQueueSummary(snapshot),
            serving: byStatus.serving || 0,
          }
        : null,
      recentActivity: recent.map((b) => ({
        bookingId: String(b._id),
        orderId: b.orderId || null,
        status: b.status,
        fuelType: b.fuelType,
        quantity: b.quantity,
        amount: b.amount,
        paymentStatus: b.paymentStatus,
        customer: (b.user && b.user.name) || null,
        at: b.collectedAt || b.updatedAt || b.createdAt,
      })),
    });
  } catch (err) {
    console.error("[admin] station overview failed:", err);
    res.status(500).json({ msg: "Failed to load the station overview" });
  }
});

router.get("/activity", adminAuth, async (req, res) => {
  try {
    const limit = Math.min(25, Math.max(1, Number(req.query.limit) || 8));
    const [bookings, payments, vendors, stations] = await Promise.all([
      Booking.find({})
        .sort({ createdAt: -1 })
        .limit(limit)
        .select("orderId status fuelType quantity amount bookingDate timeSlot createdAt station user")
        .populate("station", "name")
        .populate("user", "name")
        .lean(),
      Booking.find({ paymentStatus: "paid", collectedAt: { $ne: null } })
        .sort({ collectedAt: -1 })
        .limit(limit)
        .select("orderId amount collectedAt collectionMethod station")
        .populate("station", "name")
        .lean(),
      User.find({ role: "vendor" })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select("name businessName vendorStatus createdAt")
        .lean(),
      Station.find({})
        .sort({ updatedAt: -1 })
        .limit(limit)
        .select("name status updatedAt owner")
        .populate("owner", "name businessName")
        .lean(),
    ]);

    const entries = [
      ...bookings.map((b) => ({
        kind: "booking",
        at: b.createdAt,
        title: `${b.fuelType || "Fuel"} booking${b.orderId ? ` ${b.orderId}` : ""}`,
        detail: `${b.user?.name || "A customer"} · ${b.station?.name || "station"} · ${b.bookingDate} ${b.timeSlot || ""}`.trim(),
        status: b.status,
        amount: b.amount ?? null,
      })),
      ...payments.map((p) => ({
        kind: "payment",
        at: p.collectedAt,
        title: `Payment collected${p.orderId ? ` for ${p.orderId}` : ""}`,
        detail: `${p.station?.name || "Station"} · ${p.collectionMethod === "upi" ? "Online (UPI)" : p.collectionMethod === "cash" ? "Cash" : "at the pump"}`,
        status: "paid",
        amount: p.amount ?? null,
      })),
      ...vendors.map((v) => ({
        kind: "vendor",
        at: v.createdAt,
        title: `Vendor registered: ${v.businessName?.trim() || v.name}`,
        detail: v.businessName?.trim() ? v.name : "",
        status: v.vendorStatus,
        amount: null,
      })),
      ...stations.map((s) => ({
        kind: "station",
        at: s.updatedAt,
        title: `Station updated: ${s.name}`,
        detail: s.owner?.businessName?.trim() || s.owner?.name || "",
        status: s.status,
        amount: null,
      })),
    ]
      .filter((e) => e.at)
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, limit * 2);

    res.json({ entries });
  } catch (err) {
    console.error("[admin] activity failed:", err);
    res.status(500).json({ msg: "Failed to load recent activity" });
  }
});

/**
 * GET /api/v1/admin/live-map
 * Every active station with its current queue — the city-wide monitor.
 */
router.get("/live-map", adminAuth, async (_req, res) => {
  try {
    const stations = await Station.find({ status: "Active" })
      .select(
        "name address coordinates location queueLength nozzles avgServiceMinutes " +
          "waitMinutes queueStatus arrivalRatePerHour observedAvgQueueLength owner inventory",
      )
      .populate("owner", "name businessName")
      .lean();

    // Every station's live line from one query (services/queue/stationQueue.js).
    const { queueSnapshots, fuelQueueSummary } = require("../services/queue/stationQueue");
    const queues = await queueSnapshots(stations.map((s) => s._id));

    res.json({
      count: stations.length,
      stations: stations.map((s) => {
        const q = queues.get(String(s._id));
        return {
          id: String(s._id),
          name: s.name,
          address: s.address,
          coordinates: s.coordinates,
          vendor: s.owner?.businessName || s.owner?.name || null,
          queueLength: q.queueLength,
          waitMinutes: q.waitMinutes,
          queueStatus: q.queueStatus,
          queueBasis: q.basis,
          fuelQueues: fuelQueueSummary(q),
          inventory: s.inventory,
        };
      }),
    });
  } catch (err) {
    console.error("[admin] live-map failed:", err);
    res.status(500).json({ msg: "Failed to load live map" });
  }
});

/**
 * GET /api/v1/admin/analytics?months=6
 * Cross-vendor demand and revenue, with a forecast per fuel type.
 */
router.get("/analytics", adminAuth, async (req, res) => {
  const months = Math.min(24, Math.max(3, Number(req.query.months) || 6));

  try {
    const [byFuel, byStation, revenue, customerRevenue] = await Promise.all([
      Booking.aggregate([
        { $match: { ...revenueService.REVENUE_MATCH } },
        {
          $group: {
            _id: "$fuelType",
            volume: { $sum: "$quantity" },
            revenue: { $sum: "$amount" },
            bookings: { $sum: 1 },
          },
        },
        { $sort: { revenue: -1 } },
      ]),
      Booking.aggregate([
        { $match: { ...revenueService.REVENUE_MATCH } },
        {
          $group: {
            _id: "$station",
            revenue: { $sum: "$amount" },
            bookings: { $sum: 1 },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: "stations",
            localField: "_id",
            foreignField: "_id",
            as: "station",
          },
        },
        { $unwind: { path: "$station", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            stationId: "$_id",
            name: "$station.name",
            revenue: 1,
            bookings: 1,
          },
        },
      ]),
      salesHistory({ metric: "revenue", maxMonths: 24 }),
      salesHistory({ metric: "revenue", maxMonths: 24, customersOnly: true }),
    ]);

    res.json({
      months,
      byFuel: byFuel.map((f) => ({
        fuelType: f._id,
        volume: round2(f.volume),
        revenue: round2(f.revenue),
        bookings: f.bookings,
      })),
      topStations: byStation.map((s) => ({
        stationId: String(s.stationId),
        name: s.name || "(deleted station)",
        revenue: round2(s.revenue),
        bookings: s.bookings,
      })),
      monthlyRevenue: revenueMonths(revenue, months),
      // Forecast and its evidence: customer sales only.
      forecast: forecastFromHistory(customerRevenue),
      history: revenueEvidence(customerRevenue),
    });
  } catch (err) {
    console.error("[admin] analytics failed:", err);
    res.status(500).json({ msg: "Failed to load analytics" });
  }
});

/**
 * The last `n` months of a revenue history (services/inventory/demandHistory.js) in the
 * shape the charts read. Starts at the first sale -- months before the
 * platform sold anything are not shown as zero revenue.
 */
function revenueMonths(history, n) {
  return history.months.slice(-n).map((m) => ({
    month: m.month,
    revenue: m.value,
    bookings: m.bookings,
    complete: m.complete,
  }));
}

/** How much evidence the revenue figures rest on. */
function revenueEvidence(history) {
  return {
    firstSaleAt: history.firstSaleAt,
    lastSaleAt: history.lastSaleAt,
    daysObserved: history.daysObserved,
    saleDays: history.saleDays,
    totalBookings: history.totalBookings,
    nonCustomerBookings: history.nonCustomerBookings,
    basis: history.basis,
    excludedBookings: history.excludedBookings,
  };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY EVENTS  (what the risk engine has blocked)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/security-events?limit=50&action=blocked|flagged&rule=velocity
 *
 * The risk report for admins (services/security/riskEngine.js):
 *   - last 24 h: blocked and flagged events, booking attempts by outcome and
 *     the share that were blocked
 *   - last 7 days: events per rule, and the accounts with the most events
 *   - the rules and threshold currently in force
 *   - recent events, newest first, optionally filtered
 * Every event row carries only a reason, a rule name and a score -- never a
 * raw request body -- so it can be returned as-is.
 */
router.get("/security-events", adminAuth, async (req, res) => {
  try {
    const SecurityEvent = require("../models/SecurityEvent");
    const BookingAttempt = require("../models/BookingAttempt");
    const { RULES, DEFAULT_THRESHOLD } = require("../services/security/riskEngine");
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const filter = {};
    if (["blocked", "flagged"].includes(req.query.action)) filter.action = req.query.action;
    if (typeof req.query.rule === "string" && /^[a-z-]{1,40}$/.test(req.query.rule)) {
      // Combined events store "velocity+duplicate-slot"; match one rule within that.
      filter.rule = { $regex: `(^|\\+)${req.query.rule}(\\+|$)` };
    }

    const day = new Date(Date.now() - 24 * 60 * 60_000);
    const week = new Date(Date.now() - 7 * 24 * 60 * 60_000);

    const [events, total, byAction24h, byRule7d, topUsers7d, attempts24h] = await Promise.all([
      SecurityEvent.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate("user", "name email")
        .populate("station", "name")
        .lean(),
      SecurityEvent.countDocuments(filter),
      SecurityEvent.aggregate([
        { $match: { createdAt: { $gte: day } } },
        { $group: { _id: "$action", n: { $sum: 1 } } },
      ]),
      SecurityEvent.aggregate([
        { $match: { createdAt: { $gte: week } } },
        { $group: { _id: { rule: "$rule", action: "$action" }, n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ]),
      SecurityEvent.aggregate([
        { $match: { createdAt: { $gte: week }, user: { $ne: null } } },
        {
          $group: {
            _id: "$user",
            events: { $sum: 1 },
            blocked: { $sum: { $cond: [{ $eq: ["$action", "blocked"] }, 1, 0] } },
            lastAt: { $max: "$createdAt" },
          },
        },
        { $sort: { events: -1, lastAt: -1 } },
        { $limit: 10 },
        { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "u" } },
        { $project: { events: 1, blocked: 1, lastAt: 1, name: { $first: "$u.name" }, email: { $first: "$u.email" } } },
      ]),
      BookingAttempt.aggregate([
        { $match: { createdAt: { $gte: day } } },
        { $group: { _id: "$outcome", n: { $sum: 1 } } },
      ]),
    ]);

    const actionCount = Object.fromEntries(byAction24h.map((r) => [r._id, r.n]));
    const outcomeCount = Object.fromEntries(attempts24h.map((r) => [r._id, r.n]));
    const attemptTotal = attempts24h.reduce((s, r) => s + r.n, 0);

    res.json({
      total,
      last24h: { blocked: actionCount.blocked || 0, flagged: actionCount.flagged || 0 },
      attempts24h: { total: attemptTotal, byOutcome: outcomeCount },
      // null, not 0%, when there were no attempts to measure.
      blockRate24h: attemptTotal ? Math.round(((outcomeCount.blocked || 0) / attemptTotal) * 1000) / 10 : null,
      byRule7d: byRule7d.map((r) => ({ rule: r._id.rule, action: r._id.action, count: r.n })),
      topUsers7d: topUsers7d.map((u) => ({
        userId: String(u._id),
        name: u.name || null,
        email: u.email || null,
        events: u.events,
        blocked: u.blocked,
        lastAt: u.lastAt,
      })),
      rules: {
        threshold: DEFAULT_THRESHOLD,
        // The hard per-account ceiling checked before scoring (routes/bookingRoutes.js).
        requestLimit: {
          rule: "booking-rate",
          perMinute: require("../config/booking").BOOKING_REQUESTS_PER_MINUTE,
        },
        list: Object.values(RULES).map((r) => ({
          rule: r.name,
          points: r.points,
          limit: r.limit,
          windowMinutes: r.windowMinutes,
        })),
      },
      events: events.map((e) => ({
        id: String(e._id),
        rule: e.rule,
        reason: e.reason,
        score: e.score,
        threshold: e.threshold,
        action: e.action,
        route: e.route,
        user: e.user ? { name: e.user.name, email: e.user.email } : null,
        station: e.station ? { name: e.station.name } : null,
        createdAt: e.createdAt,
      })),
    });
  } catch (err) {
    console.error("[admin] security-events failed:", err);
    res.status(500).json({ msg: "Failed to load security events" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ORDERS  (station-wise booking management)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/orders
 *
 * Returns every booking grouped by station, with optional filters:
 *   ?date=YYYY-MM-DD        single date
 *   ?from=YYYY-MM-DD        range start  (use with ?to)
 *   ?to=YYYY-MM-DD          range end    (use with ?from)
 *   ?stationId=<id>         single station
 *   ?status=upcoming|...    booking status filter
 *   ?search=<text>          search by orderId / vehiclePlate / userName / stationName
 *
 * Also returns summary stats at the top of the response.
 */
router.get("/orders", adminAuth, async (req, res) => {
  try {
    const { date, from, to, stationId, status, search } = req.query;

    // Build match filter
    const match = {};

    // Date filter
    if (date) {
      match.bookingDate = String(date);
    } else if (from || to) {
      match.bookingDate = {};
      if (from) match.bookingDate.$gte = String(from);
      if (to)   match.bookingDate.$lte = String(to);
    }

    // Station filter
    if (stationId) {
      const mongoose = require("mongoose");
      try { match.station = new mongoose.Types.ObjectId(stationId); } catch(_) {}
    }

    // Status filter
    if (status && status !== "all") {
      match.status = String(status);
    }

    // Text search across key fields
    // Literal, length-capped match (utils/regex.js); a repeated ?search= is ignored, not a crash.
    const rx = require("../utils/regex").literalSearchRegex(search);
    if (rx) {
      match.$or = [
        { orderId:     rx },
        { vehiclePlate: rx },
        { userName:    rx },
        { stationName: rx },
      ];
    }

    // ── Summary stats ────────────────────────────────────────────────────────
    const today = require("../config/businessTime").dateKey();

    const [allBookings, todayCount, statusCounts] = await Promise.all([
      // All bookings matching the filter, populate user + station for display
      Booking.find(match)
        .sort({ bookingDate: -1, createdAt: -1 })
        .populate("user",    "name email phone")
        .populate("station", "name address")
        // A booking made as one of several carries its group; the reference
        // is what lets an admin see that four orders are one customer's one
        // visit rather than four unrelated bookings (models/FleetBooking.js).
        .populate("fleetGroup", "reference vehicleCount")
        .lean(),

      // Today's count (independent of date filter — always shown)
      Booking.countDocuments({ bookingDate: today }),

      // Status breakdown
      Booking.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    const byStatus = Object.fromEntries(statusCounts.map((s) => [s._id, s.count]));

    const summary = {
      total:     allBookings.length,
      today:     todayCount,
      upcoming:  byStatus.upcoming  || 0,
      serving:   byStatus.serving   || 0,
      completed: byStatus.completed || 0,
      cancelled: byStatus.cancelled || 0,
      waitlisted: byStatus.waitlisted || 0,
    };

    // ── Group by station ─────────────────────────────────────────────────────
    const stationMap = new Map();

    for (const b of allBookings) {
      const stId  = String(b.station?._id || b.station || "unknown");
      const stName = b.station?.name || b.stationName || "Unknown Station";
      const stAddr = b.station?.address || "";

      if (!stationMap.has(stId)) {
        stationMap.set(stId, { stationId: stId, stationName: stName, address: stAddr, bookings: [] });
      }

      stationMap.get(stId).bookings.push({
        bookingId:    String(b._id),
        orderId:      b.orderId || "-",
        userName:     b.user?.name || b.userName || "Unknown",
        userContact:  b.user?.phone || b.user?.email || b.userContact || "-",
        stationName:  stName,
        bookingDate:  b.bookingDate,
        timeSlot:     b.timeSlot || "-",
        startTime:    b.startTime || (b.timeSlot ? b.timeSlot.split("-")[0] : "-"),
        endTime:      b.endTime   || (b.timeSlot ? b.timeSlot.split("-")[1] : "-"),
        vehiclePlate: b.vehiclePlate || "-",
        fuelType:     b.fuelType,
        quantity:     b.quantity,
        amount:       b.amount,
        paymentStatus: b.paymentStatus,
        payMethod:    b.payMethod,
        status:       b.status,
        createdAt:    b.createdAt,
        // null for an ordinary booking.
        fleet: b.fleetGroup
          ? {
              fleetId: String(b.fleetGroup._id || b.fleetGroup),
              reference: b.fleetGroup.reference || null,
              position: b.fleetIndex ?? null,
              of: b.fleetGroup.vehicleCount ?? null,
            }
          : null,
      });
    }

    res.json({
      summary,
      stations: Array.from(stationMap.values()),
      total: allBookings.length,
    });
  } catch (err) {
    console.error("[admin] orders failed:", err);
    res.status(500).json({ msg: "Failed to load orders" });
  }
});

/** Orders that are over: nothing is reserved, queued or dispensing for them any more. */
const DELETABLE_ORDER_STATUSES = ["completed", "cancelled", "expired", "no_show"];

/**
 * DELETE /api/v1/admin/orders/:bookingId
 *
 * Remove a finished order (completed -- the refuelling is done -- cancelled,
 * expired or no-show) and its notifications. An order still in progress
 * (upcoming, waitlisted, serving) is refused with 409: deleting it would leave
 * a customer holding a pass for a slot and a queue that no longer matches.
 * The delete is conditional on the status at that moment, so an order that
 * changed state meanwhile is refused rather than removed. Its payment
 * stops counting towards revenue, since revenue is computed from bookings.
 */
router.delete("/orders/:bookingId", adminAuth, async (req, res) => {
  try {
    const { bookingId } = req.params;
    if (!require("mongoose").Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ msg: "Invalid order id" });
    }

    const deleted = await Booking.findOneAndDelete({ _id: bookingId, status: { $in: DELETABLE_ORDER_STATUSES } }).lean();
    if (!deleted) {
      const existing = await Booking.findById(bookingId).select("status").lean();
      if (!existing) return res.status(404).json({ msg: "Order not found" });
      return res.status(409).json({
        msg: `This order is ${existing.status}. Only completed, cancelled, expired or no-show orders can be deleted.`,
        status: existing.status,
      });
    }

    await require("../models/Notification").deleteMany({ booking: deleted._id });

    // The customer's and vendor's lists refetch on a booking event and no
    // longer find it.
    try {
      const station = deleted.station ? await Station.findById(deleted.station).select("owner").lean() : null;
      realtime.bookingChanged(realtime.EVENTS.BOOKING_UPDATED, { ...deleted, deleted: true }, { stationOwner: station?.owner });
    } catch (emitErr) {
      console.error("[admin] order delete event failed:", emitErr.message);
    }

    res.json({ ok: true, msg: "Order deleted", bookingId: String(deleted._id) });
  } catch (err) {
    console.error("[admin] order delete failed:", err);
    res.status(500).json({ msg: "Failed to delete the order" });
  }
});

/**
 * PATCH /api/v1/admin/orders/:bookingId/status
 *
 * Admin moves a booking along the same transition table as everyone else
 * (services/booking/bookingTransitions.js): a finished booking -- completed, with its
 * stock already deducted, cancelled, no-show or expired -- is not reopened.
 * Every write is conditional on the status at that moment, so a concurrent
 * vendor action or sweep is reported (409), not overwritten.
 * Body: { status: "upcoming" | "serving" | "completed" | "cancelled" | "no_show" | "expired" }
 */
router.patch("/orders/:bookingId/status", adminAuth, async (req, res) => {
  try {
    const { status } = req.body || {};
    const allowed = ["upcoming", "serving", "waitlisted", "completed", "cancelled", "no_show", "expired"];

    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ msg: `status must be one of: ${allowed.join(", ")}` });
    }

    let booking;
    if (status === "completed") {
      // Completion always goes through services/booking/bookingCompletion.js so the
      // dispensed fuel leaves the station's stock, exactly once.
      const existing = await Booking.findById(req.params.bookingId).select("status").lean();
      if (!existing) return res.status(404).json({ msg: "Booking not found" });

      if (existing.status === "completed") {
        booking = await Booking.findById(req.params.bookingId).lean();
      } else {
        const { completeBooking, COMPLETABLE_STATUSES } = require("../services/booking/bookingCompletion");
        // Only a live booking completes: completing a cancelled or expired
        // one would deduct fuel nobody dispensed.
        const done = await completeBooking({
          bookingId: req.params.bookingId,
          fromStatuses: COMPLETABLE_STATUSES,
        });
        if (!done) {
          return res.status(409).json({ msg: "The booking changed while completing it; please refresh." });
        }
        booking = done.toObject();
      }
    } else if (status === "serving") {
      // The PIN's rule applies here too: a fill only starts for a customer
      // who has checked in at the station. Support can still force it --
      // `override: true` -- for the phone that could not check in, which is
      // the reason an admin has this control at all.
      // Read it here: `booking` is only assigned by the completion branch above.
      const current = await Booking.findById(req.params.bookingId).select("stationCheckInAt").lean();
      if (!current) return res.status(404).json({ msg: "Booking not found" });
      if (!current.stationCheckInAt && req.body?.override !== true) {
        return res.status(409).json({
          reason: "NOT_CHECKED_IN",
          msg: 'This customer has not checked in at the pump. Ask them to tap "Check In at Petrol Pump", or send override to start it anyway.',
        });
      }

      // Starting fueling means the customer is at the pump: the same
      // nozzle-locked check-in as the PIN scan (services/queue/nozzleService.js).
      let result;
      try {
        result = await require("../services/queue/nozzleService").checkIn({ bookingId: req.params.bookingId });
      } catch (lockErr) {
        if (lockErr.code === "LOCK_TIMEOUT" || lockErr.code === "LOCK_EXPIRED") {
          return res.status(409).json({ msg: "The nozzle is being updated for another car. Try again in a moment." });
        }
        if (lockErr.code === "LOCK_UNAVAILABLE") {
          return res.status(503).json({ msg: "Starting service is temporarily unavailable. Please try again shortly." });
        }
        throw lockErr;
      }
      if (result.outcome === "not_found") return res.status(404).json({ msg: "Booking not found" });
      if (result.outcome === "already_serving") {
        booking = await Booking.findById(req.params.bookingId).lean();
      } else if (!result.booking) {
        return res.status(409).json({ msg: `Booking is ${result.status || "changed"} and cannot be changed to serving.` });
      } else {
        booking = result.booking.toObject();
      }
    } else {
      const { transitionBooking, currentStatus } = require("../services/booking/bookingTransitions");
      const set = {};
      if (status === "cancelled") {
        set.cancelledAt = new Date();
        set.cancelledBy = "admin";
      }

      const updated = await transitionBooking({ bookingId: req.params.bookingId, to: status, set });
      if (!updated) {
        const now = await currentStatus(req.params.bookingId);
        if (!now) return res.status(404).json({ msg: "Booking not found" });
        if (now === status) {
          booking = await Booking.findById(req.params.bookingId).lean();
        } else {
          return res.status(409).json({ msg: `Booking is ${now} and cannot be changed to ${status}.` });
        }
      } else {
        booking = updated.toObject();
      }
    }

    // A freed nozzle window goes to the first customer waiting for it.
    if (booking.station && ["cancelled", "no_show", "expired"].includes(status)) {
      await require("../services/booking/booking").promoteFromWaitlist(booking.station);
    }
    // A car completed or removed by hand releases the nozzle: the next car
    // waiting at the pump starts (services/queue/serviceTimer.js).
    if (booking.station && ["completed", "cancelled", "no_show", "expired"].includes(status)) {
      await require("../services/queue/serviceTimer").releaseNozzle(booking.station, { refresh: false });
    }

    // Live queue and ETAs from the one queue model (services/queue/stationQueue.js).
    if (booking.station) {
      try {
        const refreshed = await require("../services/queue/stationQueue").refreshStationQueue(booking.station);
        if (refreshed?.station) realtime.stationChanged(realtime.EVENTS.STATION_UPDATED, refreshed.station);
      } catch (stErr) {
        console.error("Failed to refresh station queue after admin status update:", stErr);
      }
    }

    // Was two global broadcasts of a booking that carries the customer's
    // name, plate and amount -- and "new_booking" for a booking that was
    // merely updated, which made every client treat an edit as an arrival.
    // One addressed event now, to the three parties it concerns.
    realtime.bookingChanged(
      booking.status === "cancelled"
        ? realtime.EVENTS.BOOKING_CANCELLED
        : realtime.EVENTS.BOOKING_UPDATED,
      booking,
    );

    res.json({
      ok: true,
      bookingId: String(booking._id),
      status: booking.status,
      // Asked to start serving while another car is at the nozzle: checked in
      // and waiting; it starts automatically when the nozzle is released.
      waitingForNozzle: status === "serving" && booking.status === "upcoming",
    });
  } catch (err) {
    console.error("[admin] update order status failed:", err);
    res.status(500).json({ msg: "Failed to update booking status" });
  }
});

/**
 * GET /api/v1/admin/distributions
 *
 * The shapes the totals hide: how long people actually waited at a pump, how
 * much fuel they actually buy, and when they actually book. Each one is a
 * count of real booking rows (services/analytics/distributions.js), and each
 * carries its own `total` so a chart can refuse to draw a distribution built
 * from a handful of bookings rather than present noise as a finding.
 *
 * ?days=30 by default. An admin sees every station.
 */
router.get("/distributions", adminAuth, async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  try {
    const distributions = require("../services/analytics/distributions");
    const [waiting, quantities, demand] = await Promise.all([
      distributions.waitingTimes({ days }),
      distributions.fuelQuantities({ days }),
      distributions.demandByHour({ days }),
    ]);
    res.json({ success: true, days, waiting, quantities, demand });
  } catch (err) {
    console.error("[admin] distributions failed:", err.message);
    res.status(500).json({ success: false, msg: "Could not load the distributions." });
  }
});

module.exports = router;
