/**
 * Replay the risk rules over the REAL booking history, read-only.
 *
 *   node scripts/maintenance/riskReplay.js
 *
 * The question: would the risk engine (services/security/riskEngine.js) have blocked
 * or flagged any real customer? There is no labelled abuse data, so this
 * cannot measure how much abuse the rules catch -- it measures the cost that
 * matters most, false positives against genuine customers.
 *
 * Two replays:
 *   1. BookingAttempt rows (exact): every stored attempt is re-scored with
 *      the live evaluateBookingRisk at the moment it was made. Attempts expire
 *      after 30 days, so this covers only recent traffic.
 *   2. Booking rows (lower bound): older history has no attempt log, so each
 *      booking is scored with the bookings the same customer created in the
 *      preceding window standing in for attempts. Rejected attempts left no
 *      trace, so real counts were at least this high.
 * Customer cancellations are counted only where `cancelledBy` was recorded.
 *
 * Writes nothing.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const { evaluateBookingRisk, scoreFromCounts, RULES } = require("../../src/services/security/riskEngine");

const MONGO = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/fuelmart";
const minutes = (n) => n * 60_000;

async function main() {
  await mongoose.connect(MONGO);
  const Booking = require("../../src/models/Booking");
  const BookingAttempt = require("../../src/models/BookingAttempt");
  const User = require("../../src/models/User");

  // ---- 1. exact replay of stored attempts ---------------------------------
  const attempts = await BookingAttempt.find({}).sort({ createdAt: 1 }).lean();
  const attemptReplay = { attempts: attempts.length, flagged: 0, wouldBlock: 0, recordedBlocked: 0, mismatches: [] };
  for (const a of attempts) {
    const r = await evaluateBookingRisk({
      userId: a.user,
      stationId: a.station,
      bookingDate: a.bookingDate,
      timeSlot: a.timeSlot,
      fuelType: a.fuelType,
      excludeAttemptId: a._id,
      now: a.createdAt,
    });
    if (r.blocked) attemptReplay.wouldBlock += 1;
    else if (r.score > 0) attemptReplay.flagged += 1;
    if (a.outcome === "blocked") attemptReplay.recordedBlocked += 1;
    if ((a.outcome === "blocked") !== r.blocked && a.outcome !== "pending") {
      attemptReplay.mismatches.push({ attempt: String(a._id), recorded: a.outcome, replayBlocked: r.blocked });
    }
  }

  // ---- 2. lower-bound replay of booking history ----------------------------
  const bookings = await Booking.find({})
    .select("user station bookingDate timeSlot fuelType status cancelledBy cancelledAt createdAt")
    .sort({ createdAt: 1 })
    .lean();
  const byUser = new Map();
  for (const b of bookings) {
    const key = String(b.user);
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(b);
  }
  const users = await User.find({ _id: { $in: [...byUser.keys()] } }).select("role").lean();
  const roleOf = new Map(users.map((u) => [String(u._id), u.role]));

  const perUser = [];
  for (const [userId, list] of byUser) {
    let maxScore = 0;
    let flagged = 0;
    let wouldBlock = 0;
    for (const b of list) {
      const t = new Date(b.createdAt).getTime();
      const inWindow = (x, w) => new Date(x.createdAt).getTime() < t && new Date(x.createdAt).getTime() >= t - w;
      const velocity = list.filter((x) => inWindow(x, minutes(RULES.velocity.windowMinutes))).length;
      const duplicateSlot = list.filter(
        (x) =>
          inWindow(x, minutes(RULES.duplicateSlot.windowMinutes)) &&
          String(x.station) === String(b.station) &&
          x.bookingDate === b.bookingDate &&
          x.timeSlot === b.timeSlot &&
          x.fuelType === b.fuelType,
      ).length;
      const cancellations = list.filter(
        (x) =>
          x.cancelledBy === "customer" &&
          x.cancelledAt &&
          new Date(x.cancelledAt).getTime() < t &&
          new Date(x.cancelledAt).getTime() >= t - minutes(RULES.cancellations.windowMinutes),
      ).length;

      const r = scoreFromCounts({ velocity, duplicateSlot, cancellations });
      maxScore = Math.max(maxScore, r.score);
      if (r.blocked) wouldBlock += 1;
      else if (r.score > 0) flagged += 1;
    }
    perUser.push({
      user: userId,
      role: roleOf.get(userId) || "unknown",
      bookings: list.length,
      maxScore,
      flagged,
      wouldBlock,
      legacyCancellationsWithoutActor: list.filter((x) => x.status === "cancelled" && !x.cancelledBy).length,
    });
  }

  console.log(
    JSON.stringify(
      {
        attemptReplay,
        bookingReplay: {
          bookings: bookings.length,
          customers: perUser.length,
          wouldBlock: perUser.reduce((s, u) => s + u.wouldBlock, 0),
          flagged: perUser.reduce((s, u) => s + u.flagged, 0),
          perUser,
        },
      },
      null,
      2,
    ),
  );
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Replay failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
