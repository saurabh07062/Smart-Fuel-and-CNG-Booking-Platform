/**
 * Commission: accruing it per booking, and collecting it once a day.
 *
 * THE FLOW, END TO END
 *
 *   1. A booking becomes revenue -- fuel dispensed AND money received
 *      (services/payment/revenue.js owns that definition). The customer paid
 *      the VENDOR directly at the pump, so the vendor already holds the whole
 *      amount; what is outstanding is FuelMart's commission on the sale.
 *   2. `accrueForBooking` writes one CommissionEntry, status "pending",
 *      recording the split as it stood. One per booking, by unique index.
 *   3. Those pending rows accumulate through the day.
 *   4. At the configured time, `settleDay` gathers each vendor's pending rows
 *      for that business day into one Settlement and attempts the transfer.
 *   5. The entries are marked settled ONLY when the transfer is confirmed.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *
 * Nothing is ever marked transferred because a schedule fired. With no payout
 * rail configured -- which is the truth today, since online payment is off
 * entirely -- a settlement is raised as `awaiting_confirmation` and stays
 * there until an admin records the money as actually received. A status that
 * says "settled" means somebody or something that handles money said so.
 *
 * ABOUT TRANSACTIONS
 *
 * This deployment runs a standalone MongoDB, where `session.withTransaction`
 * throws: transactions need a replica set. So atomicity is built the way the
 * rest of this codebase builds it -- a conditional update that can only match
 * once (`claim`, below), unique indexes that make a duplicate impossible, and
 * an order of writes chosen so that a crash leaves work to be redone rather
 * than money double-counted. `withTransaction` is used when the deployment
 * does have a replica set, and skipped cleanly when it does not.
 */

const mongoose = require("mongoose");
const crypto = require("crypto");
const CommissionEntry = require("../../models/CommissionEntry");
const Settlement = require("../../models/Settlement");
const Booking = require("../../models/Booking");
const Station = require("../../models/Station");
const commissionConfig = require("../../config/commission");
const { payableOf } = require("../payment/payMethod");
const { isRevenueBooking } = require("../payment/revenue");
const { dateKey } = require("../../config/businessTime");
const metrics = require("../core/metrics");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const DUPLICATE = 11000;

class CommissionError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.name = "CommissionError";
    this.status = status;
    this.reason = reason;
  }
}

/* ────────────────────────── the split ────────────────────────── */

/**
 * What a booking is worth to each side. Pure, and from the booking's own row.
 *
 * `gross` is what the customer actually handed over (payableOf: the bill less
 * any reward-points discount), because commission is taken on money received,
 * not on money invoiced.
 *
 * The fuel value is reduced in the same proportion as any discount, so the
 * platform and the dealer share the cost of a points redemption rather than
 * the dealer carrying it alone.
 *
 * @returns {{gross, fuelValue, convenienceFee, rate, commission, vendorPayable}}
 */
function computeFor(booking) {
  const gross = payableOf(booking);
  const fee = commissionConfig.KEEPS_CONVENIENCE_FEE ? round2(Number(booking?.taxes) || 0) : 0;
  // Everything that is not the fee is the dealer's goods.
  const fuelValue = round2(Math.max(0, gross - fee));
  const rate = commissionConfig.PERCENT;
  const onFuel = round2((fuelValue * rate) / 100);
  const commission = round2(Math.min(gross, fee + onFuel));

  return {
    gross,
    fuelValue,
    convenienceFee: fee,
    rate,
    commission,
    vendorPayable: round2(Math.max(0, gross - commission)),
  };
}

/* ────────────────────────── accrual ────────────────────────── */

/**
 * Record what FuelMart earned on a booking that has become revenue.
 *
 * Called from the two places a booking can become revenue: completion (when
 * the money was already taken) and payment being recorded (when the fill had
 * already finished). Both call it; the unique index means only the first one
 * writes.
 *
 * Never throws. A commission row must not be able to fail a completion or a
 * payment -- the sale happened either way, and an un-accrued booking is
 * visible and fixable, whereas a failed completion is a customer standing at
 * a pump.
 *
 * @returns {Promise<object|null>} the entry, or null when there was nothing to
 *   accrue (not revenue yet, no owner, zero commission, or already accrued).
 */
async function accrueForBooking(booking) {
  try {
    if (!booking?._id) return null;
    // The one definition of revenue, not a second opinion about it.
    if (!isRevenueBooking(booking)) return null;

    const stationId = booking.station;
    if (!stationId) return null;
    const station = await Station.findById(stationId).select("owner").lean();
    if (!station?.owner) return null; // an imported pump with no vendor earns nobody a commission

    const split = computeFor(booking);
    if (!(split.commission > 0)) return null;

    // Dated to the business day the money was earned, which is what a
    // settlement groups by: the later of completion and collection, matching
    // services/payment/revenue.js.
    const earnedAt = new Date(
      Math.max(
        booking.completionTime ? new Date(booking.completionTime).getTime() : 0,
        booking.collectedAt ? new Date(booking.collectedAt).getTime() : 0,
      ) || Date.now(),
    );

    const entry = await CommissionEntry.create({
      booking: booking._id,
      station: stationId,
      vendor: station.owner,
      dateKey: dateKey(earnedAt),
      ...split,
      status: "pending",
    });
    metrics.inc("commission_accrued_count");
    return entry.toObject();
  } catch (err) {
    if (err?.code === DUPLICATE) return null; // already accrued: the intended outcome
    metrics.inc("commission_accrual_error_count");
    console.error(`[commission] could not accrue for booking ${booking?._id}:`, err.message);
    return null;
  }
}

/**
 * Reverse a booking's commission because the sale was refunded.
 *
 * A settled entry is NOT silently un-settled: the money has already moved, so
 * the reversal is recorded and the amount is owed back the other way. That is
 * a credit note, which is a business decision, so it is logged loudly rather
 * than invented here.
 */
async function reverseForBooking(booking, { note = "Booking refunded" } = {}) {
  try {
    if (!booking?._id) return null;
    const entry = await CommissionEntry.findOne({ booking: booking._id }).lean();
    if (!entry || entry.status === "refunded") return null;

    if (entry.status === "settled") {
      console.warn(
        `[commission] booking ${booking._id} was refunded AFTER its commission was settled ` +
          `(${entry.commission} in settlement ${entry.settlement}); a credit note is owed.`,
      );
    }

    const updated = await CommissionEntry.findOneAndUpdate(
      { _id: entry._id, status: { $ne: "refunded" } },
      { $set: { status: "refunded", note: String(note).slice(0, 200) } },
      { new: true },
    ).lean();
    if (updated) metrics.inc("commission_reversed_count");
    return updated;
  } catch (err) {
    console.error(`[commission] could not reverse booking ${booking?._id}:`, err.message);
    return null;
  }
}

/* ────────────────────────── settlement ────────────────────────── */

/** "STL-2026-10-02-3F7A" -- readable, and unique by the random tail. */
function settlementReference(day) {
  return `STL-${day}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

/**
 * Run a transaction when the deployment supports one.
 *
 * A standalone MongoDB throws on `startSession().withTransaction` ("Transaction
 * numbers are only allowed on a replica set member or mongos"). Rather than
 * refuse to settle on the deployment this project actually runs, the work is
 * written to be safe without one -- see the note at the top of this file --
 * and a transaction is used as an extra guarantee where it is available.
 */
/**
 * Whether this deployment can do transactions at all.
 *
 * Unknown until the first attempt, then remembered: a standalone MongoDB
 * refuses every transaction the same way, and paying for a failed one on
 * every settlement would be a waste.
 */
let transactionsSupported = null;

/** The ways a standalone MongoDB says "no transactions here". */
function isUnsupported(err) {
  const message = String(err?.message || "");
  return (
    /Transaction numbers are only allowed/i.test(message) ||
    /does not support retryable writes/i.test(message) ||
    /Transactions are not supported/i.test(message) ||
    /replica set/i.test(message) ||
    err?.code === 20 ||
    err?.codeName === "IllegalOperation"
  );
}

async function inTransaction(fn) {
  if (transactionsSupported === false) return fn(null);

  let session = null;
  try {
    session = await mongoose.startSession();
    let out;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    transactionsSupported = true;
    return out;
  } catch (err) {
    if (!isUnsupported(err)) throw err;
    // Said once, not on every settlement: an operator should know the extra
    // guarantee is not in force, and why that is still safe here.
    if (transactionsSupported === null) {
      console.warn(
        "[commission] This MongoDB is standalone, so settlements run without a transaction. " +
          "Safety comes from the unique indexes and conditional updates instead (see the note in this file). " +
          "A replica set would add the transaction on top.",
      );
    }
    transactionsSupported = false;
    return fn(null);
  } finally {
    if (session) await session.endSession().catch(() => {});
  }
}

/**
 * Attempt the transfer of one settlement.
 *
 * This is the only place that may say money moved, and it says so only when
 * something that handles money confirms it.
 *
 * @returns {Promise<{confirmed: boolean, transferRef?: string, error?: string}>}
 */
async function attemptTransfer(settlement) {
  const mode = commissionConfig.PAYOUT_MODE;

  if (mode === "gateway") {
    // Deliberately not implemented. Online payments are switched off for this
    // deployment (config/payments.js), so there is no payout rail to call;
    // writing one that "succeeds" would be writing a lie into the ledger.
    return { confirmed: false, error: "No payout gateway is configured for this deployment." };
  }

  // Manual: the settlement is raised and waits for a human to confirm the
  // money arrived (confirmSettlement, below). Not an error -- the expected
  // path for a platform whose money moves outside it.
  return { confirmed: false, error: null };
}

/**
 * Settle one vendor's commission for one business day.
 *
 * Idempotent per (vendor, day) by unique index: a second run finds the
 * settlement already raised and does nothing.
 *
 * @returns {Promise<{settlement: object|null, reason?: string}>}
 */
async function settleVendorDay({ vendorId, day, now = new Date() }) {
  const pending = await CommissionEntry.find({ vendor: vendorId, dateKey: day, status: "pending" })
    .select("_id commission")
    .lean();
  if (pending.length === 0) return { settlement: null, reason: "NOTHING_PENDING" };

  const amount = round2(pending.reduce((sum, e) => sum + (Number(e.commission) || 0), 0));
  const minimum = commissionConfig.MIN_SETTLEMENT_AMOUNT;
  if (amount < minimum) {
    // Carried forward: the rows stay pending and join a later settlement. A
    // transfer that costs more than it moves is not worth making.
    return { settlement: null, reason: "BELOW_MINIMUM", amount, minimum };
  }

  let settlement;
  try {
    settlement = await Settlement.create({
      vendor: vendorId,
      dateKey: day,
      reference: settlementReference(day),
      amount,
      entryCount: pending.length,
      status: "awaiting_confirmation",
      mode: commissionConfig.PAYOUT_MODE,
      attempts: 1,
    });
  } catch (err) {
    // Another run raised it first. That is the guard working.
    if (err?.code === DUPLICATE) {
      const existing = await Settlement.findOne({ vendor: vendorId, dateKey: day }).lean();
      return { settlement: existing, reason: "ALREADY_RAISED" };
    }
    throw err;
  }

  // Claim the entries for this settlement. Conditional on still being
  // pending, so a row that was refunded in the meantime is left alone.
  const ids = pending.map((e) => e._id);
  await CommissionEntry.updateMany(
    { _id: { $in: ids }, status: "pending" },
    { $set: { settlement: settlement._id } },
  );

  const result = await attemptTransfer(settlement);

  if (result.confirmed) {
    await markSettled(settlement._id, { transferRef: result.transferRef || null, at: now });
    metrics.inc("commission_settlement_confirmed_count");
    return { settlement: await Settlement.findById(settlement._id).lean(), reason: "SETTLED" };
  }

  if (result.error) {
    // A real failure: the entries go back to the pool for the next run.
    await Settlement.updateOne({ _id: settlement._id }, { $set: { status: "failed", error: result.error.slice(0, 300) } });
    await CommissionEntry.updateMany(
      { settlement: settlement._id, status: "pending" },
      { $set: { status: "failed", settlement: null } },
    );
    metrics.inc("commission_settlement_failed_count");
    return { settlement: await Settlement.findById(settlement._id).lean(), reason: "FAILED", error: result.error };
  }

  // Raised and waiting for confirmation. The entries stay pending on purpose:
  // the money has not moved, so nothing may call them settled.
  metrics.inc("commission_settlement_raised_count");
  return { settlement: settlement.toObject(), reason: "AWAITING_CONFIRMATION" };
}

/**
 * Mark a settlement, and every entry it claimed, as settled.
 *
 * Conditional on the settlement not already being settled, so two
 * confirmations cannot pay twice. Wrapped in a transaction where the
 * deployment supports one, and safe without.
 */
async function markSettled(settlementId, { transferRef = null, by = null, at = new Date() } = {}) {
  return inTransaction(async (session) => {
    const opts = session ? { session } : {};
    const claimed = await Settlement.findOneAndUpdate(
      { _id: settlementId, status: { $ne: "settled" } },
      {
        $set: {
          status: "settled",
          transferRef,
          confirmedBy: by,
          confirmedAt: at,
          error: null,
        },
      },
      { new: true, ...opts },
    );
    if (!claimed) return null; // already settled: nothing to do, and nothing paid twice

    await CommissionEntry.updateMany(
      { settlement: settlementId, status: { $in: ["pending", "failed"] } },
      { $set: { status: "settled", settledAt: at } },
      opts,
    );
    return claimed.toObject();
  });
}

/**
 * An admin records that a settlement's money actually arrived.
 *
 * This is the confirmation the manual payout mode waits for, and the only way
 * a settlement becomes "settled" without a gateway saying so.
 */
async function confirmSettlement({ settlementId, adminId, transferRef = null }) {
  if (!mongoose.isValidObjectId(settlementId)) {
    throw new CommissionError(400, "INVALID_SETTLEMENT", "A valid settlement id is required.");
  }
  const settlement = await Settlement.findById(settlementId).lean();
  if (!settlement) throw new CommissionError(404, "NOT_FOUND", "That settlement does not exist.");
  if (settlement.status === "settled") {
    return { settlement, alreadySettled: true };
  }

  const updated = await markSettled(settlementId, {
    transferRef: transferRef ? String(transferRef).trim().slice(0, 120) : null,
    by: adminId,
    at: new Date(),
  });
  if (!updated) return { settlement: await Settlement.findById(settlementId).lean(), alreadySettled: true };
  metrics.inc("commission_settlement_confirmed_count");
  return { settlement: updated, alreadySettled: false };
}

/**
 * Settle every vendor that has pending commission for a business day.
 *
 * @returns {Promise<{day, vendors, raised, settled, failed, skipped, amount}>}
 */
async function settleDay({ day = dateKey(), now = new Date() } = {}) {
  const vendors = await CommissionEntry.distinct("vendor", { dateKey: day, status: "pending" });
  const out = { day, vendors: vendors.length, raised: 0, settled: 0, failed: 0, skipped: 0, amount: 0 };

  for (const vendorId of vendors) {
    try {
      const { settlement, reason } = await settleVendorDay({ vendorId, day, now });
      if (!settlement) {
        out.skipped += 1;
        continue;
      }
      if (reason === "SETTLED") out.settled += 1;
      else if (reason === "FAILED") out.failed += 1;
      else if (reason === "AWAITING_CONFIRMATION") out.raised += 1;
      if (reason !== "ALREADY_RAISED") out.amount = round2(out.amount + (Number(settlement.amount) || 0));
    } catch (err) {
      out.failed += 1;
      console.error(`[commission] settling vendor ${vendorId} for ${day} failed:`, err.message);
    }
  }
  return out;
}

/* ────────────────────────── reading ────────────────────────── */

/**
 * A vendor's commission position: earned, still pending, already settled.
 *
 * Aggregated from the entries themselves, so the three figures cannot drift
 * apart the way three separately maintained counters would.
 */
async function summaryForVendor(vendorId, { day = dateKey() } = {}) {
  const [byStatus, today] = await Promise.all([
    CommissionEntry.aggregate([
      { $match: { vendor: new mongoose.Types.ObjectId(String(vendorId)) } },
      { $group: { _id: "$status", amount: { $sum: "$commission" }, gross: { $sum: "$gross" }, payable: { $sum: "$vendorPayable" }, count: { $sum: 1 } } },
    ]),
    CommissionEntry.aggregate([
      { $match: { vendor: new mongoose.Types.ObjectId(String(vendorId)), dateKey: day, status: { $ne: "refunded" } } },
      { $group: { _id: null, amount: { $sum: "$commission" }, gross: { $sum: "$gross" }, payable: { $sum: "$vendorPayable" }, count: { $sum: 1 } } },
    ]),
  ]);

  const of = (status) => byStatus.find((r) => r._id === status) || {};
  const pending = of("pending");
  const failed = of("failed");
  const settled = of("settled");
  const t = today[0] || {};

  return {
    rate: commissionConfig.PERCENT,
    settlementTime: commissionConfig.SETTLEMENT_TIME.text,
    minSettlement: commissionConfig.MIN_SETTLEMENT_AMOUNT,
    // What FuelMart has earned from this vendor, ever (refunds excluded).
    earned: round2((pending.amount || 0) + (failed.amount || 0) + (settled.amount || 0)),
    // Accrued but not yet collected -- including a failed attempt, which is
    // still owed.
    pending: round2((pending.amount || 0) + (failed.amount || 0)),
    pendingCount: (pending.count || 0) + (failed.count || 0),
    // Collected, with the transfer confirmed.
    settled: round2(settled.amount || 0),
    settledCount: settled.count || 0,
    // The vendor's own side of the same rows.
    vendorPayable: round2((pending.payable || 0) + (failed.payable || 0) + (settled.payable || 0)),
    today: {
      day,
      gross: round2(t.gross || 0),
      commission: round2(t.amount || 0),
      vendorPayable: round2(t.payable || 0),
      bookings: t.count || 0,
    },
  };
}

/** One entry as the dashboards show it. */
function publicEntry(e) {
  return {
    id: String(e._id),
    bookingRef: e.booking?.orderId || (e.booking ? String(e.booking._id || e.booking) : null),
    bookingId: e.booking?._id ? String(e.booking._id) : e.booking ? String(e.booking) : null,
    fuelType: e.booking?.fuelType ?? null,
    date: e.dateKey,
    gross: e.gross,
    commission: e.commission,
    vendorPayable: e.vendorPayable,
    rate: e.rate,
    status: e.status,
    settlementRef: e.settlement?.reference ?? null,
    settledAt: e.settledAt,
    at: e.createdAt,
    note: e.note ?? null,
  };
}

/** One settlement as the dashboards show it. */
function publicSettlement(s) {
  return {
    id: String(s._id),
    reference: s.reference,
    date: s.dateKey,
    amount: s.amount,
    entryCount: s.entryCount,
    status: s.status,
    mode: s.mode,
    transferRef: s.transferRef ?? null,
    attempts: s.attempts,
    error: s.error ?? null,
    confirmedAt: s.confirmedAt ?? null,
    at: s.createdAt,
    vendor: s.vendor && typeof s.vendor === "object"
      ? { id: String(s.vendor._id), name: s.vendor.name ?? null, businessName: s.vendor.businessName ?? null }
      : s.vendor
        ? { id: String(s.vendor) }
        : null,
  };
}

/** A vendor's per-booking commission history, newest first. */
async function entriesForVendor(vendorId, { limit = 25, skip = 0, status = null } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const from = Math.max(Number(skip) || 0, 0);
  const filter = { vendor: vendorId, ...(status ? { status } : {}) };

  const [rows, total] = await Promise.all([
    CommissionEntry.find(filter)
      .sort({ createdAt: -1 })
      .skip(from)
      .limit(cap)
      .populate("booking", "orderId fuelType")
      .populate("settlement", "reference")
      .lean(),
    CommissionEntry.countDocuments(filter),
  ]);
  return { entries: rows.map(publicEntry), total };
}

/** Settlement history -- a vendor's own, or every vendor's for an admin. */
async function settlements({ vendorId = null, limit = 25, skip = 0, status = null } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const from = Math.max(Number(skip) || 0, 0);
  const filter = { ...(vendorId ? { vendor: vendorId } : {}), ...(status ? { status } : {}) };

  const [rows, total] = await Promise.all([
    Settlement.find(filter)
      .sort({ createdAt: -1 })
      .skip(from)
      .limit(cap)
      .populate("vendor", "name businessName")
      .lean(),
    Settlement.countDocuments(filter),
  ]);
  return { settlements: rows.map(publicSettlement), total };
}

/** What FuelMart is owed and has collected, across every vendor. */
async function adminSummary() {
  const [entries, pendingSettlements] = await Promise.all([
    CommissionEntry.aggregate([{ $group: { _id: "$status", amount: { $sum: "$commission" }, count: { $sum: 1 } } }]),
    Settlement.aggregate([{ $group: { _id: "$status", amount: { $sum: "$amount" }, count: { $sum: 1 } } }]),
  ]);
  const of = (rows, id) => rows.find((r) => r._id === id) || {};

  return {
    rate: commissionConfig.PERCENT,
    settlementTime: commissionConfig.SETTLEMENT_TIME.text,
    payoutMode: commissionConfig.PAYOUT_MODE,
    earned: round2(
      (of(entries, "pending").amount || 0) + (of(entries, "failed").amount || 0) + (of(entries, "settled").amount || 0),
    ),
    pending: round2((of(entries, "pending").amount || 0) + (of(entries, "failed").amount || 0)),
    settled: round2(of(entries, "settled").amount || 0),
    refunded: round2(of(entries, "refunded").amount || 0),
    awaitingConfirmation: {
      amount: round2(of(pendingSettlements, "awaiting_confirmation").amount || 0),
      count: of(pendingSettlements, "awaiting_confirmation").count || 0,
    },
    failed: {
      amount: round2(of(pendingSettlements, "failed").amount || 0),
      count: of(pendingSettlements, "failed").count || 0,
    },
  };
}

module.exports = {
  CommissionError,
  computeFor,
  accrueForBooking,
  reverseForBooking,
  settleDay,
  settleVendorDay,
  confirmSettlement,
  markSettled,
  summaryForVendor,
  entriesForVendor,
  settlements,
  adminSummary,
  publicEntry,
  publicSettlement,
  settlementReference,
};
