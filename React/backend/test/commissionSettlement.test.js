/**
 * Commission: accrued per sale, collected once a day, and never twice.
 *
 * The rules under test are the ones that cost real money if they are wrong:
 *
 *   - commission is computed from the booking's OWN figures, at the configured
 *     rate -- never a number written in the code
 *   - it accrues only when the booking is actually revenue (fuel dispensed AND
 *     money received), not when it is merely completed
 *   - one entry per booking, however many paths notice the sale
 *   - one settlement per vendor per day, however many times the job runs
 *   - NOTHING is marked settled until a transfer is confirmed
 *   - a refund reverses the commission
 *
 *   node --test test/commissionSettlement.test.js
 *
 * DEVELOPMENT TEST DATA: tagged users, stations and bookings, removed at the end.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const testDb = require("./helpers/testDb");
const MONGO = testDb.uri();

// Fixed rules for this file: 2% of the fuel value, the ₹5 fee kept in full,
// and every amount settled however small.
process.env.COMMISSION_PERCENT = "2";
process.env.COMMISSION_KEEPS_FEE = "true";
process.env.COMMISSION_MIN_SETTLEMENT = "0";
process.env.COMMISSION_PAYOUT_MODE = "manual";

test("commission and settlement against MongoDB", { timeout: 120_000 }, async (t) => {
  const mongoose = require("mongoose");
  await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });

  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const CommissionEntry = require("../src/models/CommissionEntry");
  const Settlement = require("../src/models/Settlement");
  const service = require("../src/services/commission/commissionService");
  const settlementJob = require("../src/services/commission/settlementJob");
  const { dateKey } = require("../src/config/businessTime");

  // The uniqueness rules ARE the safety mechanism; without the indexes this
  // would be testing a different system.
  await CommissionEntry.init();
  await Settlement.init();

  const tag = `comm-${Date.now()}`;
  const created = { users: [], stations: [], bookings: [], settlements: [] };
  const day = dateKey();

  const vendor = await User.create({
    name: `${tag}-vendor`,
    email: `${tag}-v@fuelmart.test`,
    password: "x",
    role: "vendor",
    vendorStatus: "active",
    activated: true,
  });
  const customer = await User.create({
    name: `${tag}-customer`,
    email: `${tag}-c@fuelmart.test`,
    password: "x",
    role: "customer",
    isVerified: true,
  });
  const admin = await User.create({ name: `${tag}-admin`, email: `${tag}-a@fuelmart.test`, password: "x", role: "admin" });
  created.users.push(vendor._id, customer._id, admin._id);

  const station = await Station.create({
    name: `${tag}-station`,
    address: "Commission Road, Pune",
    owner: vendor._id,
    status: "Active",
    fuelTypes: ["Petrol"],
    prices: { petrol: 100 },
    inventory: { petrol: 5000 },
    tankCapacity: { petrol: 10000 },
    coordinates: { lat: 18.62, lng: 73.72 },
  });
  created.stations.push(station._id);

  /** A sale: completed, paid, collected -- which is what revenue means. */
  const soldBooking = async (over = {}) => {
    const doc = await Booking.create({
      user: customer._id,
      station: station._id,
      stationName: station.name,
      fuelType: "Petrol",
      quantity: 10,
      price: 100,
      taxes: 5,
      amount: 1005,
      payableAmount: 1005,
      bookingDate: "2099-04-01",
      timeSlot: "10:00 AM",
      status: "completed",
      payMethod: "station",
      paymentStatus: "paid",
      collectedAt: new Date(),
      completionTime: new Date(),
      verificationCode: "1111",
      orderId: `FM-COMM-${Math.random().toString(16).slice(2, 10).toUpperCase()}`,
      ...over,
    });
    created.bookings.push(doc._id);
    return doc;
  };

  try {
    /* ───────────────── the split ───────────────── */

    await t.test("the split is computed from the booking's own figures", () => {
      // ₹1,005 collected = ₹1,000 of fuel + ₹5 fee.
      // FuelMart keeps the ₹5 fee and 2% of the ₹1,000 = ₹20. Total ₹25.
      const split = service.computeFor({ amount: 1005, payableAmount: 1005, taxes: 5 });
      assert.equal(split.gross, 1005);
      assert.equal(split.convenienceFee, 5);
      assert.equal(split.fuelValue, 1000);
      assert.equal(split.rate, 2);
      assert.equal(split.commission, 25);
      assert.equal(split.vendorPayable, 980, "the vendor's share of what the customer handed over");
      // The two halves add back up to the money that actually changed hands.
      assert.equal(split.commission + split.vendorPayable, split.gross);
    });

    await t.test("a reward-points discount reduces what commission is taken on", () => {
      // The customer paid ₹905 of a ₹1,005 bill. Commission follows the money
      // received, not the money invoiced.
      const split = service.computeFor({ amount: 1005, payableAmount: 905, taxes: 5 });
      assert.equal(split.gross, 905);
      assert.equal(split.commission, 23, "₹5 fee + 2% of ₹900");
      assert.equal(split.commission + split.vendorPayable, 905);
    });

    /* ───────────────── accrual ───────────────── */

    await t.test("a sale accrues commission once, pending, dated to its business day", async () => {
      const booking = await soldBooking();
      const entry = await service.accrueForBooking(booking);
      assert.ok(entry);
      assert.equal(entry.status, "pending");
      assert.equal(entry.commission, 25);
      assert.equal(entry.vendorPayable, 980);
      assert.equal(String(entry.vendor), String(vendor._id));
      assert.equal(entry.dateKey, day);

      // Completion and the payment record can both notice the same sale.
      assert.equal(await service.accrueForBooking(booking), null, "the second notice accrues nothing");
      assert.equal(await CommissionEntry.countDocuments({ booking: booking._id }), 1);
    });

    await t.test("two paths racing on the same sale still accrue once", async () => {
      const booking = await soldBooking();
      const [a, b] = await Promise.all([service.accrueForBooking(booking), service.accrueForBooking(booking)]);
      assert.equal([a, b].filter(Boolean).length, 1);
      assert.equal(await CommissionEntry.countDocuments({ booking: booking._id }), 1);
    });

    await t.test("a booking that is not yet revenue accrues nothing", async () => {
      // Fuel dispensed, money NOT collected: the vendor has nothing to owe a
      // commission out of yet.
      const unpaid = await soldBooking({ paymentStatus: "due_at_station", collectedAt: null });
      assert.equal(await service.accrueForBooking(unpaid), null);
      assert.equal(await CommissionEntry.countDocuments({ booking: unpaid._id }), 0);

      // Paid, but the fill never happened.
      const cancelled = await soldBooking({ status: "cancelled" });
      assert.equal(await service.accrueForBooking(cancelled), null);
      assert.equal(await CommissionEntry.countDocuments({ booking: cancelled._id }), 0);
    });

    /* ───────────────── settlement ───────────────── */

    await t.test("the day's pending commission is gathered into ONE settlement per vendor", async () => {
      const before = await CommissionEntry.find({ vendor: vendor._id, dateKey: day, status: "pending" }).lean();
      const expected = Math.round(before.reduce((s, e) => s + e.commission, 0) * 100) / 100;
      assert.ok(expected > 0, "there is something to settle");

      const { settlement: raised, reason } = await service.settleVendorDay({ vendorId: vendor._id, day });
      assert.ok(raised, "a settlement was raised");
      assert.equal(reason, "AWAITING_CONFIRMATION", "raised, not settled -- no transfer has been confirmed");

      const settlements = await Settlement.find({ vendor: vendor._id, dateKey: day }).lean();
      created.settlements.push(...settlements.map((s) => s._id));
      assert.equal(settlements.length, 1);
      assert.equal(settlements[0].amount, expected);
      assert.equal(settlements[0].entryCount, before.length);
      assert.match(settlements[0].reference, /^STL-\d{4}-\d{2}-\d{2}-[0-9A-F]{4}$/);
    });

    await t.test("NOTHING is marked settled until the transfer is confirmed", async () => {
      const settlement = await Settlement.findOne({ vendor: vendor._id, dateKey: day }).lean();
      assert.equal(settlement.status, "awaiting_confirmation");
      assert.equal(settlement.confirmedAt, null);

      // The entries it claimed are still pending: the money has not moved.
      const claimed = await CommissionEntry.find({ settlement: settlement._id }).lean();
      assert.ok(claimed.length > 0);
      assert.equal(claimed.filter((e) => e.status === "settled").length, 0, "a schedule firing is not a transfer");
      assert.ok(claimed.every((e) => e.status === "pending"));
    });

    await t.test("running the job again does not raise a second settlement", async () => {
      // The entries are still PENDING -- deliberately, because the money has
      // not moved yet -- so a second run does try again. The unique index on
      // (vendor, day) is what stops it, and it hands back the settlement that
      // already exists instead of raising a second transfer.
      const again = await service.settleVendorDay({ vendorId: vendor._id, day });
      assert.equal(again.reason, "ALREADY_RAISED");
      assert.ok(again.settlement, "the existing settlement is returned, not a new one");
      assert.equal(await Settlement.countDocuments({ vendor: vendor._id, dateKey: day }), 1, "still one");
    });

    await t.test("an admin confirming receipt settles it, and its entries, once", async () => {
      const settlement = await Settlement.findOne({ vendor: vendor._id, dateKey: day }).lean();

      const { alreadySettled } = await service.confirmSettlement({
        settlementId: settlement._id,
        adminId: admin._id,
        transferRef: "NEFT-TEST-0001",
      });
      assert.equal(alreadySettled, false);

      const after = await Settlement.findById(settlement._id).lean();
      assert.equal(after.status, "settled");
      assert.equal(after.transferRef, "NEFT-TEST-0001");
      assert.equal(String(after.confirmedBy), String(admin._id));
      assert.ok(after.confirmedAt);

      const entries = await CommissionEntry.find({ settlement: settlement._id }).lean();
      assert.ok(entries.every((e) => e.status === "settled"), "every entry it covered is settled");
      assert.ok(entries.every((e) => e.settledAt));

      // Confirming twice must not pay twice.
      const second = await service.confirmSettlement({ settlementId: settlement._id, adminId: admin._id });
      assert.equal(second.alreadySettled, true);
      assert.equal((await Settlement.findById(settlement._id).lean()).transferRef, "NEFT-TEST-0001", "unchanged");
    });

    await t.test("a settled sale is not swept into another settlement", async () => {
      const result = await service.settleVendorDay({ vendorId: vendor._id, day });
      assert.equal(result.reason, "NOTHING_PENDING", "this vendor has nothing left owing");
      assert.equal(await Settlement.countDocuments({ vendor: vendor._id, dateKey: day }), 1, "and no second settlement");
    });

    /* ───────────────── the vendor's view ───────────────── */

    await t.test("the vendor's summary adds up to what the entries say", async () => {
      const summary = await service.summaryForVendor(vendor._id, { day });
      const settled = await CommissionEntry.aggregate([
        { $match: { vendor: vendor._id, status: "settled" } },
        { $group: { _id: null, amount: { $sum: "$commission" } } },
      ]);

      assert.equal(summary.rate, 2);
      assert.equal(summary.settled, Math.round((settled[0]?.amount || 0) * 100) / 100);
      assert.equal(summary.pending, 0, "everything accrued so far has been collected");
      assert.equal(summary.earned, summary.settled + summary.pending);
      assert.ok(summary.today.bookings > 0);
    });

    /* ───────────────── refunds ───────────────── */

    await t.test("a refunded sale has its commission reversed", async () => {
      const booking = await soldBooking();
      await service.accrueForBooking(booking);

      const reversed = await service.reverseForBooking(booking, { note: "Customer refunded" });
      assert.equal(reversed.status, "refunded");
      assert.match(reversed.note, /refunded/i);

      // A refunded entry is not swept into a settlement.
      const result = await service.settleVendorDay({ vendorId: vendor._id, day });
      assert.equal(result.reason, "NOTHING_PENDING", "a reversed commission is not owed");

      // And reversing twice changes nothing.
      assert.equal(await service.reverseForBooking(booking), null);
    });

    /* ───────────────── the schedule ───────────────── */

    await t.test("the next run is the configured time, in the future", () => {
      process.env.COMMISSION_SETTLEMENT_TIME = "23:30";
      const at = settlementJob.nextRunAt(new Date());
      assert.ok(at instanceof Date);
      assert.ok(at.getTime() > Date.now(), "always ahead, never a time already past");
    });

    await t.test("a small amount is carried forward rather than transferred", async () => {
      process.env.COMMISSION_MIN_SETTLEMENT = "100000";
      const later = "2099-04-02";
      const booking = await soldBooking({ bookingDate: later });
      const entry = await service.accrueForBooking(booking);
      await CommissionEntry.updateOne({ _id: entry.id || entry._id }, { $set: { dateKey: later } });

      const result = await service.settleVendorDay({ vendorId: vendor._id, day: later });
      assert.equal(result.reason, "BELOW_MINIMUM", "below the minimum: not worth a transfer");
      assert.equal(await Settlement.countDocuments({ vendor: vendor._id, dateKey: later }), 0);
      // Still owed, still pending, ready for the next run.
      const still = await CommissionEntry.findOne({ booking: booking._id }).lean();
      assert.equal(still.status, "pending");
      process.env.COMMISSION_MIN_SETTLEMENT = "0";
    });
  } finally {
    await CommissionEntry.deleteMany({ vendor: { $in: created.users } });
    await Settlement.deleteMany({ vendor: { $in: created.users } });
    await Booking.deleteMany({ user: { $in: created.users } });
    await require("../src/models/RewardLedger").deleteMany({ user: { $in: created.users } });
    await require("../src/models/Invoice").deleteMany({ user: { $in: created.users } });
    await require("../src/models/InventoryMovement").deleteMany({ station: { $in: created.stations } });
    await require("../src/models/Notification").deleteMany({ user: { $in: created.users } });
    await Station.deleteMany({ _id: { $in: created.stations } });
    await User.deleteMany({ _id: { $in: created.users } });
    await mongoose.disconnect();
    await require("../src/services/security/rateLimiter").close();
  }
});
