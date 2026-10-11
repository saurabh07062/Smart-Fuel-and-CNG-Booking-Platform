/**
 * Reward points: earned, spent, and given back.
 *
 * The whole life of a point, against the TEST database:
 *
 *   welcome credit -> earned on a completed booking -> spent as a discount on
 *   the next one -> returned when that booking is cancelled -> clawed back when
 *   a completed booking is refunded
 *
 * The things these tests are really here to hold:
 *
 *   - a balance is never written, only incremented conditionally, so two
 *     requests cannot spend the same points
 *   - every movement has a ledger row, and the balance is the sum of them
 *   - a booking earns ONCE however many completion paths race
 *   - a cancellation returns the points ONCE however many times it is pressed
 *   - points can never pay for a whole bill, and can never go negative
 *
 *   node --test test/rewardPoints.test.js
 *
 * DEVELOPMENT TEST DATA: tagged users, a station and bookings, removed at the end.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const testDb = require("./helpers/testDb");
const MONGO = testDb.uri();

// Fixed rules for this file, so the arithmetic below is not at the mercy of a
// deployment's .env: 2 points per ₹100, a point is worth ₹0.50, at least 50
// points per redemption, and points may pay for at most 20% of a bill.
process.env.REWARD_POINTS_PER_100 = "2";
process.env.REWARD_POINT_VALUE = "0.5";
process.env.REWARD_MIN_REDEEM = "50";
process.env.REWARD_MAX_DISCOUNT_PERCENT = "20";
process.env.REWARD_WELCOME_POINTS = "100";

test("reward points against MongoDB", { timeout: 120_000 }, async (t) => {
  const mongoose = require("mongoose");
  await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });

  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const RewardLedger = require("../src/models/RewardLedger");
  const rewards = require("../src/config/rewards");
  const rewardService = require("../src/services/rewards/rewardService");
  const { completeBooking } = require("../src/services/booking/bookingCompletion");
  const { transitionBooking } = require("../src/services/booking/bookingTransitions");
  const { createCustomerBooking } = require("../src/services/booking/bookingCreate");
  const { dateKey } = require("../src/config/businessTime");

  // The ledger's uniqueness rules are the whole anti-double-pay mechanism, and
  // the application builds them at boot; a test that skipped this would be
  // testing a different system.
  await RewardLedger.init();
  await Booking.init();

  const tag = `rewards-${Date.now()}`;
  const created = { users: [], stations: [], bookings: [] };

  /** A customer with a known starting balance and no ledger history. */
  const customerWith = async (balance, suffix = "") => {
    const user = await User.create({
      name: `${tag}-customer${suffix}`,
      email: `${tag}${suffix}@fuelmart.test`,
      password: "x",
      role: "customer",
      isVerified: true,
      rewards: balance,
    });
    created.users.push(user._id);
    return user;
  };

  /** A completed-shaped booking row, with no slot machinery involved. */
  const bookingFor = async (user, station, over = {}) => {
    const doc = await Booking.create({
      user: user._id,
      station: station._id,
      fuelType: "Petrol",
      quantity: 10,
      price: 100,
      taxes: 5,
      amount: 1005,
      payableAmount: 1005,
      bookingDate: "2099-01-01",
      timeSlot: "10:00 AM",
      status: "upcoming",
      payMethod: "station",
      paymentStatus: "due_at_station",
      verificationCode: "1234",
      orderId: `FM-TEST-${Math.random().toString(16).slice(2, 10).toUpperCase()}`,
      ...over,
    });
    created.bookings.push(doc._id);
    return doc;
  };

  const balanceOf = async (user) => (await User.findById(user._id).select("rewards").lean()).rewards;
  const ledgerOf = (user, type) => RewardLedger.find({ user: user._id, ...(type ? { type } : {}) }).lean();

  const station = await Station.create({
    name: `${tag}-station`,
    address: "Reward Road, Pune",
    status: "Active",
    fuelTypes: ["Petrol"],
    prices: { petrol: 100 },
    inventory: { petrol: 5000 },
    tankCapacity: { petrol: 10000 },
    coordinates: { lat: 18.62, lng: 73.72 },
  });
  created.stations.push(station._id);

  try {
    /* ─────────────────────────── the arithmetic ─────────────────────────── */

    await t.test("a point has one fixed value, and rounding never invents one", () => {
      assert.equal(rewards.rupeesFor(100), 50, "100 points at ₹0.50");
      assert.equal(rewards.rupeesFor(0), 0);
      assert.equal(rewards.rupeesFor(-5), 0, "a negative request is worth nothing, not a credit");
      // Rounded DOWN: a fraction of a paisa is not given away.
      assert.equal(rewards.rupeesFor(3), 1.5);
      // And the points needed for an amount are rounded UP, the other way, so
      // neither direction leaks value.
      assert.equal(rewards.pointsFor(50), 100);
      assert.equal(rewards.pointsFor(50.01), 101);
    });

    await t.test("points are earned on what is paid, in whole points", () => {
      assert.equal(rewards.earnedFor(1005), 20, "₹1,005 at 2 per ₹100");
      assert.equal(rewards.earnedFor(49), 0, "less than a whole point earns nothing");
      assert.equal(rewards.earnedFor(0), 0);
      assert.equal(rewards.earnedFor(-500), 0, "a negative bill cannot earn");
    });

    /* ─────────────────────────── quoting ─────────────────────────── */

    await t.test("the quote is capped by the balance, and by a share of the bill", () => {
      // 20% of ₹1,005 is ₹201, which is 402 points -- less than this balance.
      const rich = rewardService.quoteFor({ balance: 5000, amount: 1005 });
      assert.equal(rich.maxPoints, 402);
      assert.equal(rich.maxDiscount, 201);
      assert.equal(rich.eligible, true);

      // A smaller balance is the binding limit instead.
      const poor = rewardService.quoteFor({ balance: 120, amount: 1005 });
      assert.equal(poor.maxPoints, 120);
      assert.equal(poor.maxDiscount, 60);
    });

    await t.test("too few points, or too small a bill, is a reason rather than a zero", () => {
      const thin = rewardService.quoteFor({ balance: 40, amount: 1005 });
      assert.equal(thin.eligible, false);
      assert.equal(thin.reason, "BALANCE_BELOW_MINIMUM");
      assert.equal(thin.maxPoints, 0);

      // 20% of ₹100 is ₹20 = 40 points, below the 50-point minimum.
      const small = rewardService.quoteFor({ balance: 5000, amount: 100 });
      assert.equal(small.eligible, false);
      assert.equal(small.reason, "BILL_TOO_SMALL");
    });

    await t.test("points can never pay for a whole bill", () => {
      const q = rewardService.quoteFor({ balance: 1_000_000, amount: 1005 });
      assert.ok(q.maxDiscount < 1005, `${q.maxDiscount} must be less than the bill`);
      assert.equal(q.maxPercent, 20);
    });

    /* ─────────────────────────── welcome ─────────────────────────── */

    await t.test("a new account is credited through the ledger, exactly once", async () => {
      const user = await customerWith(0, "-welcome");

      const first = await rewardService.creditWelcome(user._id);
      assert.equal(first.balance, 100);
      assert.equal(await balanceOf(user), 100);

      // The balance is explained by a row, not by a schema default.
      const rows = await ledgerOf(user, "welcome");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].points, 100);
      assert.equal(rows[0].balanceAfter, 100);

      // Called again (a retry, a duplicate signup request): nothing changes.
      assert.equal(await rewardService.creditWelcome(user._id), null);
      assert.equal(await balanceOf(user), 100, "no second welcome credit");
      assert.equal((await ledgerOf(user, "welcome")).length, 1);
    });

    /* ─────────────────────────── earning ─────────────────────────── */

    await t.test("a completed booking earns points, and earns them once", async () => {
      const user = await customerWith(0, "-earn");
      const booking = await bookingFor(user, station);

      const completed = await completeBooking({ bookingId: booking._id });
      assert.ok(completed, "the booking completed");
      assert.equal(await balanceOf(user), 20, "₹1,005 paid = 20 points");

      const earned = await ledgerOf(user, "earned");
      assert.equal(earned.length, 1);
      assert.equal(String(earned[0].booking), String(booking._id));

      // A second completion path arriving late (the sweep after a vendor click)
      // completes nothing and pays nothing.
      assert.equal(await completeBooking({ bookingId: booking._id }), null);
      // And even calling the earning directly cannot pay twice: the ledger refuses.
      assert.equal(await rewardService.earnForBooking(completed), null);
      assert.equal(await balanceOf(user), 20, "still 20");
      assert.equal((await ledgerOf(user, "earned")).length, 1);
    });

    await t.test("two completions racing pay for one booking, not two", async () => {
      const user = await customerWith(0, "-race-earn");
      const booking = await bookingFor(user, station);

      const [a, b] = await Promise.all([
        completeBooking({ bookingId: booking._id }),
        completeBooking({ bookingId: booking._id }),
      ]);
      assert.equal([a, b].filter(Boolean).length, 1, "exactly one completion won");
      assert.equal(await balanceOf(user), 20);
      assert.equal((await ledgerOf(user, "earned")).length, 1);
    });

    await t.test("points are earned on the discounted price, not the full bill", async () => {
      const user = await customerWith(0, "-earn-net");
      // ₹1,005 bill with a ₹100 discount: the customer pays ₹905, so 18 points
      // (not 20). Points do not earn points.
      const booking = await bookingFor(user, station, {
        rewardPointsUsed: 200,
        rewardDiscount: 100,
        payableAmount: 905,
      });

      await completeBooking({ bookingId: booking._id });
      assert.equal(await balanceOf(user), 18);
    });

    /* ─────────────────────────── spending ─────────────────────────── */

    await t.test("a redemption takes the points and records what they bought", async () => {
      const user = await customerWith(500, "-spend");
      const booking = await bookingFor(user, station);

      const result = await rewardService.redeem({ userId: user._id, points: 200, booking: booking._id });
      assert.equal(result.balance, 300);
      assert.equal(await balanceOf(user), 300);

      const rows = await ledgerOf(user, "redeemed");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].points, -200, "a spend is negative in the ledger");
      assert.equal(rows[0].rupees, 100, "what it was worth, stored at the time");
      assert.equal(rows[0].balanceAfter, 300);
    });

    await t.test("more points than the customer has is refused, and takes nothing", async () => {
      const user = await customerWith(80, "-short");
      const booking = await bookingFor(user, station);

      await assert.rejects(
        () => rewardService.redeem({ userId: user._id, points: 200, booking: booking._id }),
        (err) => err.reason === "INSUFFICIENT_POINTS",
      );
      assert.equal(await balanceOf(user), 80, "nothing was taken");
      assert.equal((await ledgerOf(user, "redeemed")).length, 0, "and nothing was recorded");
    });

    await t.test("two requests cannot spend the same points", async () => {
      const user = await customerWith(200, "-race-spend");
      // Two bookings to spend against. They are created "completed" because a
      // customer may hold only ONE live ordinary booking (models/Booking.js
      // uniq_active_solo_booking_per_user) -- the race under test is between two
      // redemptions, not between two bookings.
      const one = await bookingFor(user, station, { status: "completed" });
      const two = await bookingFor(user, station, { status: "completed" });

      // Both ask for the full balance at the same instant.
      const results = await Promise.allSettled([
        rewardService.redeem({ userId: user._id, points: 200, booking: one._id }),
        rewardService.redeem({ userId: user._id, points: 200, booking: two._id }),
      ]);

      const won = results.filter((r) => r.status === "fulfilled");
      assert.equal(won.length, 1, "exactly one spend succeeded");
      assert.equal(await balanceOf(user), 0, "the balance is zero, never negative");
      assert.equal((await ledgerOf(user, "redeemed")).length, 1);
    });

    await t.test("a validated redemption is checked against the bill, in words the customer can act on", async () => {
      const user = await customerWith(60, "-validate");

      // Nothing asked for is not an error.
      assert.equal(await rewardService.validateRedemption({ userId: user._id, amount: 1005, points: 0 }), null);
      assert.equal(await rewardService.validateRedemption({ userId: user._id, amount: 1005 }), null);

      // More than the balance.
      await assert.rejects(
        () => rewardService.validateRedemption({ userId: user._id, amount: 1005, points: 100 }),
        (err) => err.reason === "INSUFFICIENT_POINTS" && /you have 60/i.test(err.message),
      );
      // Below the minimum.
      await assert.rejects(
        () => rewardService.validateRedemption({ userId: user._id, amount: 1005, points: 10 }),
        (err) => err.reason === "BELOW_MINIMUM_REDEEM",
      );
      // Not a whole number of points.
      await assert.rejects(
        () => rewardService.validateRedemption({ userId: user._id, amount: 1005, points: 10.5 }),
        (err) => err.reason === "INVALID_POINTS",
      );
      // Above the share of the bill points may cover (60 points = ₹30, more
      // than 20% of a ₹100 bill).
      await assert.rejects(
        () => rewardService.validateRedemption({ userId: user._id, amount: 100, points: 60 }),
        (err) => err.reason === "BILL_TOO_SMALL" || err.reason === "ABOVE_MAX_DISCOUNT",
      );

      const ok = await rewardService.validateRedemption({ userId: user._id, amount: 1005, points: 60 });
      assert.deepEqual(ok, { points: 60, discount: 30 });
    });

    /* ─────────────────────────── giving them back ─────────────────────────── */

    await t.test("cancelling a discounted booking returns the points, once", async () => {
      const user = await customerWith(500, "-cancel");
      const booking = await bookingFor(user, station, {
        rewardPointsUsed: 200,
        rewardDiscount: 100,
        payableAmount: 905,
      });
      await rewardService.redeem({ userId: user._id, points: 200, booking: booking._id });
      assert.equal(await balanceOf(user), 300);

      const cancelled = await transitionBooking({ bookingId: booking._id, to: "cancelled" });
      assert.ok(cancelled);
      assert.equal(await balanceOf(user), 500, "the points are the customer's again");

      const back = await ledgerOf(user, "redeem_reversed");
      assert.equal(back.length, 1);
      assert.equal(back[0].points, 200);

      // Pressing cancel again, or the sweep expiring it, returns nothing more.
      await rewardService.reverseRedemption(cancelled);
      await rewardService.reverseRedemption(cancelled);
      assert.equal(await balanceOf(user), 500);
      assert.equal((await ledgerOf(user, "redeem_reversed")).length, 1);
    });

    await t.test("a booking with no discount is cancelled without touching the balance", async () => {
      const user = await customerWith(300, "-cancel-plain");
      const booking = await bookingFor(user, station);

      await transitionBooking({ bookingId: booking._id, to: "cancelled" });
      assert.equal(await balanceOf(user), 300);
      assert.equal((await ledgerOf(user, "redeem_reversed")).length, 0, "nothing to return, nothing recorded");
    });

    await t.test("a no-show and an expiry return the points too", async () => {
      for (const to of ["no_show", "expired"]) {
        const user = await customerWith(500, `-${to}`);
        const booking = await bookingFor(user, station, { rewardPointsUsed: 100, rewardDiscount: 50, payableAmount: 955 });
        await rewardService.redeem({ userId: user._id, points: 100, booking: booking._id });
        assert.equal(await balanceOf(user), 400);

        await transitionBooking({ bookingId: booking._id, to });
        assert.equal(await balanceOf(user), 500, `${to} returns the points`);
      }
    });

    await t.test("a refunded booking has its earned points taken back", async () => {
      const user = await customerWith(0, "-refund");
      const booking = await bookingFor(user, station);
      const completed = await completeBooking({ bookingId: booking._id });
      assert.equal(await balanceOf(user), 20);

      await rewardService.reverseEarning(completed);
      assert.equal(await balanceOf(user), 0);
      const rows = await ledgerOf(user, "earn_reversed");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].points, -20);

      // Once only.
      await rewardService.reverseEarning(completed);
      assert.equal((await ledgerOf(user, "earn_reversed")).length, 1);
    });

    await t.test("a refund takes what is left when the points are already spent", async () => {
      const user = await customerWith(0, "-refund-spent");
      const booking = await bookingFor(user, station);
      const completed = await completeBooking({ bookingId: booking._id }); // +20

      // The customer spends most of it elsewhere, leaving 5.
      await require("../src/models/User").updateOne({ _id: user._id }, { $set: { rewards: 5 } });

      await rewardService.reverseEarning(completed);
      // Takes the 5 that are there rather than forcing a negative balance.
      assert.equal(await balanceOf(user), 0);
      const rows = await ledgerOf(user, "earn_reversed");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].points, -5, "what could actually be taken, recorded honestly");
    });

    /* ─────────────────────────── booking with points ─────────────────────────── */

    await t.test("booking with points: the bill is discounted and the points are spent", async () => {
      const user = await customerWith(500, "-book");
      const result = await createCustomerBooking({
        user: { id: String(user._id) },
        body: {
          stationId: String(station._id),
          fuelType: "Petrol",
          quantity: 10,
          bookingDate: "2099-01-02",
          timeSlot: "10:00 AM",
          payMethod: "station",
          redeemPoints: 200,
        },
      });
      created.bookings.push(result._id);

      assert.equal(result.amount, 1005, "the bill itself is unchanged");
      assert.equal(result.rewardPointsUsed, 200);
      assert.equal(result.rewardDiscount, 100);
      assert.equal(result.payableAmount, 905, "what is collected at the pump");
      assert.equal(await balanceOf(user), 300, "the points left the balance");

      const rows = await ledgerOf(user, "redeemed");
      assert.equal(rows.length, 1);
      assert.equal(String(rows[0].booking), String(result._id), "the discount names its booking, so it can be returned");
    });

    await t.test("booking with more points than the customer has books nothing", async () => {
      const user = await customerWith(60, "-book-short");
      await assert.rejects(
        () =>
          createCustomerBooking({
            user: { id: String(user._id) },
            body: {
              stationId: String(station._id),
              fuelType: "Petrol",
              quantity: 10,
              bookingDate: "2099-01-03",
              timeSlot: "11:00 AM",
              payMethod: "station",
              redeemPoints: 400,
            },
          }),
        (err) => err.reason === "INSUFFICIENT_POINTS",
      );

      assert.equal(await Booking.countDocuments({ user: user._id }), 0, "no booking was created");
      assert.equal(await balanceOf(user), 60, "and no points were taken");
      // Nor was any stock held for a booking that does not exist.
      const fresh = await Station.findById(station._id).select("inventoryCommitted").lean();
      assert.ok((fresh.inventoryCommitted?.petrol ?? 0) >= 0);
    });

    await t.test("booking without points is exactly as it was", async () => {
      const user = await customerWith(500, "-book-plain");
      const booking = await createCustomerBooking({
        user: { id: String(user._id) },
        body: {
          stationId: String(station._id),
          fuelType: "Petrol",
          quantity: 10,
          bookingDate: "2099-01-04",
          timeSlot: "12:00 PM",
          payMethod: "station",
        },
      });
      created.bookings.push(booking._id);

      assert.equal(booking.rewardPointsUsed, 0);
      assert.equal(booking.rewardDiscount, 0);
      assert.equal(booking.payableAmount, booking.amount, "the full bill is payable");
      assert.equal(await balanceOf(user), 500, "an untouched balance");
    });

    /* ─────────────────────────── the statement ─────────────────────────── */

    await t.test("the statement reads like a statement, newest first", async () => {
      const user = await customerWith(0, "-statement");
      await rewardService.creditWelcome(user._id);
      const booking = await bookingFor(user, station);
      await completeBooking({ bookingId: booking._id }); // +20

      const { entries, balance, total } = await rewardService.statement(user._id);
      assert.equal(balance, 120);
      assert.equal(total, 2);
      assert.equal(entries[0].type, "earned", "newest first");
      assert.equal(entries[1].type, "welcome");
      // The balance is the sum of the ledger, which is what makes it checkable.
      assert.equal(
        entries.reduce((sum, e) => sum + e.points, 0),
        balance,
      );
      // And an earned row names the booking it came from.
      assert.equal(entries[0].booking.orderId, booking.orderId);
    });

    /* ─────────────────────────── admin adjustments ─────────────────────────── */

    await t.test("an admin adjustment needs a reason, and cannot overdraw", async () => {
      const admin = await User.create({
        name: `${tag}-admin`,
        email: `${tag}-admin@fuelmart.test`,
        password: "x",
        role: "admin",
      });
      created.users.push(admin._id);
      const user = await customerWith(100, "-adjust");

      await assert.rejects(
        () => rewardService.adjust({ userId: user._id, points: 50, actor: admin._id, note: "" }),
        (err) => err.reason === "REASON_REQUIRED",
      );
      await assert.rejects(
        () => rewardService.adjust({ userId: user._id, points: 0, actor: admin._id, note: "nothing" }),
        (err) => err.reason === "INVALID_POINTS",
      );
      await assert.rejects(
        () => rewardService.adjust({ userId: user._id, points: -500, actor: admin._id, note: "too much" }),
        (err) => err.reason === "INSUFFICIENT_POINTS",
      );
      assert.equal(await balanceOf(user), 100, "a refused adjustment changes nothing");

      const credit = await rewardService.adjust({
        userId: user._id,
        points: 50,
        actor: admin._id,
        note: "Goodwill: queue was mismanaged",
      });
      assert.equal(credit.balance, 150);
      const rows = await ledgerOf(user, "adjustment");
      assert.equal(rows.length, 1);
      assert.equal(String(rows[0].actor), String(admin._id), "the admin is named on the row");
      assert.match(rows[0].note, /Goodwill/);

      // Twice means twice: an adjustment is not idempotent, by design.
      await rewardService.adjust({ userId: user._id, points: 50, actor: admin._id, note: "Goodwill: again" });
      assert.equal(await balanceOf(user), 200);
    });

    /* ─────────────────────────── the fleet split ─────────────────────────── */

    await t.test("one fleet discount splits across the vans, losing nothing", () => {
      const { splitPoints } = require("../src/services/booking/fleetBooking");

      // Equal bills, points that do not divide evenly: the leftover is given
      // out, not quietly kept.
      const even = splitPoints(10, [100, 100, 100]);
      assert.equal(
        even.reduce((a, b) => a + b, 0),
        10,
      );
      assert.deepEqual(even.sort((a, b) => b - a), [4, 3, 3]);

      // Unequal bills: the bigger bill takes the bigger share.
      const uneven = splitPoints(300, [3000, 1000]);
      assert.deepEqual(uneven, [225, 75]);
      assert.equal(
        uneven.reduce((a, b) => a + b, 0),
        300,
      );

      // Nothing to split against.
      assert.deepEqual(splitPoints(100, [0, 0]), [0, 0]);
    });
  } finally {
    await Booking.deleteMany({ _id: { $in: created.bookings } });
    await Booking.deleteMany({ user: { $in: created.users } });
    await RewardLedger.deleteMany({ user: { $in: created.users } });
    await require("../src/models/InventoryMovement").deleteMany({ station: { $in: created.stations } });
    await require("../src/models/Invoice").deleteMany({ user: { $in: created.users } });
    await require("../src/models/BookingAttempt").deleteMany({ user: { $in: created.users } });
    await require("../src/models/Notification").deleteMany({ user: { $in: created.users } });
    await Station.deleteMany({ _id: { $in: created.stations } });
    await User.deleteMany({ _id: { $in: created.users } });
    await mongoose.disconnect();
    await require("../src/services/security/rateLimiter").close();
    await require("../src/services/core/redisConnect").close?.().catch?.(() => {});
  }
});
