/**
 * Phase 7: the risk engine.
 *
 * Genuine-customer patterns must not be blocked; scripted patterns must be,
 * with a truthful retry time; one tripped rule is flagged for admins without
 * blocking; malformed floods are counted; and the admin report reflects it.
 *
 * DEVELOPMENT TEST DATA: tagged users and a station without a map position;
 * attempts are inserted with explicit timestamps; all removed at the end.
 * Booking creation is called as a service, so no email is sent.
 *
 *   node --test test/riskEngine.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { RULES, DEFAULT_THRESHOLD, scoreFromCounts, combine } = require("../src/services/security/riskEngine");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

test("no rule can block on its own; any two can", () => {
  const rules = Object.values(RULES);
  for (const r of rules) assert.ok(r.points < DEFAULT_THRESHOLD, r.name);
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      assert.ok(rules[i].points + rules[j].points >= DEFAULT_THRESHOLD, `${rules[i].name}+${rules[j].name}`);
    }
  }
});

test("scoreFromCounts: limits are 'more than', not 'at least'", () => {
  assert.equal(scoreFromCounts({ velocity: 6, duplicateSlot: 3, cancellations: 2 }).score, 0);
  const r = scoreFromCounts({ velocity: 7, duplicateSlot: 4 });
  assert.equal(r.score, 80);
  assert.equal(r.blocked, true);
  assert.deepEqual(r.reasons.map((x) => x.rule), ["velocity", "duplicate-slot"]);
  assert.equal(scoreFromCounts({ cancellations: 3 }).blocked, false);
});

test("security events expire after the retention period; booking attempts after 30 days", () => {
  const ttlOf = (Model) => Model.schema.indexes().find(([keys, opts]) => keys.createdAt === 1 && opts?.expireAfterSeconds)?.[1].expireAfterSeconds;
  assert.equal(ttlOf(require("../src/models/SecurityEvent")), 180 * 24 * 60 * 60);
  assert.equal(ttlOf(require("../src/models/BookingAttempt")), 30 * 24 * 60 * 60);
});

test("combine: retry time is when one rule clears enough to drop below the threshold", () => {
  const r = combine([
    { rule: "velocity", hit: true, points: 40, reason: "v", retryAfterSeconds: 300 },
    { rule: "duplicate-slot", hit: true, points: 40, reason: "d", retryAfterSeconds: 120 },
  ]);
  assert.equal(r.retryAfterSeconds, 120);
  assert.equal(combine([{ rule: "velocity", hit: true, points: 40, reason: "v", retryAfterSeconds: 300 }]).retryAfterSeconds, 0);
});

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

test("risk engine against MongoDB", async (t) => {
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
  const BookingAttempt = require("../src/models/BookingAttempt");
  const SecurityEvent = require("../src/models/SecurityEvent");
  const { evaluateBookingRisk } = require("../src/services/security/riskEngine");
  const { createCustomerBooking } = require("../src/services/booking/bookingCreate");

  const tag = `risk-${Date.now()}`;
  const mkUser = (n, role = "customer") =>
    User.create({ name: `${tag}-${n}`, email: `${tag}-${n}@example.com`, password: "not-a-real-hash", role, isVerified: true });
  const [genuine, retrier, script, flagged, flood, admin, rate] = await Promise.all([
    mkUser("genuine"),
    mkUser("retrier"),
    mkUser("script"),
    mkUser("flagged"),
    mkUser("flood"),
    mkUser("admin", "admin"),
    mkUser("rate"),
  ]);
  const userIds = [genuine, retrier, script, flagged, flood, admin, rate].map((u) => u._id);
  const station = await Station.create({
    name: `${tag}-station`,
    address: "Risk Test",
    status: "Active",
    fuelTypes: ["Petrol"],
    prices: { petrol: 100 },
    inventory: { petrol: 1000 },
  });

  const DATE = "2099-10-01";
  const now = new Date();
  const ago = (s) => new Date(now.getTime() - s * 1000);
  /** Insert attempts with real past timestamps (the model would stamp "now"). */
  const insertAttempts = (user, rows) =>
    BookingAttempt.collection.insertMany(
      rows.map((r) => ({
        user: user._id,
        station: station._id,
        bookingDate: DATE,
        fuelType: "petrol",
        outcome: "rejected",
        reason: "SLOT_FULL",
        ...r,
        updatedAt: r.createdAt,
      })),
    );
  const evalFor = (user, timeSlot, at = now) =>
    evaluateBookingRisk({ userId: user._id, stationId: station._id, bookingDate: DATE, timeSlot, fuelType: "petrol", now: at });

  try {
    await t.test("genuine: six tries across different slots in 10 minutes is not suspicious", async () => {
      const slots = ["8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM"];
      await insertAttempts(genuine, slots.map((timeSlot, i) => ({ timeSlot, createdAt: ago(540 - i * 60) })));
      const r = await evalFor(genuine, "11:00 AM");
      assert.equal(r.score, 0, JSON.stringify(r.reasons));
    });

    await t.test("genuine: retrying one full slot three times plus a few others is not blocked", async () => {
      await insertAttempts(retrier, [
        ...[1, 2, 3].map((i) => ({ timeSlot: "9:00 AM", createdAt: ago(300 - i * 30) })),
        ...["9:30 AM", "10:00 AM", "10:30 AM"].map((timeSlot, i) => ({ timeSlot, createdAt: ago(150 - i * 30) })),
      ]);
      const r = await evalFor(retrier, "9:00 AM");
      assert.equal(r.blocked, false);
      assert.equal(r.score, 0, "3 same-slot and 6 total are within the limits");
    });

    await t.test("scripted: 12 hits on one slot in 4 minutes is blocked, with a truthful retry time", async () => {
      const rows = Array.from({ length: 12 }, (_, i) => ({ timeSlot: "9:00 AM", createdAt: ago(240 - i * 20) }));
      await insertAttempts(script, rows);
      const r = await evalFor(script, "9:00 AM");
      assert.equal(r.blocked, true);
      assert.equal(r.score, 80);

      // velocity: 12 > 6 -> clears once the 6th oldest ages out; duplicate-slot:
      // 12 > 3 -> needs the 9th oldest gone. The sooner one is enough.
      const sixthOldest = rows[5].createdAt.getTime();
      const expected = Math.ceil((sixthOldest + RULES.velocity.windowMinutes * 60_000 - now.getTime()) / 1000);
      assert.ok(Math.abs(r.retryAfterSeconds - expected) <= 1, `${r.retryAfterSeconds} vs ${expected}`);

      const later = await evalFor(script, "9:00 AM", new Date(now.getTime() + (r.retryAfterSeconds + 1) * 1000));
      assert.equal(later.blocked, false, "no longer blocked once the retry time has passed");
    });

    await t.test("one tripped rule: the booking goes through and admins get one flagged event", async () => {
      await insertAttempts(
        flagged,
        ["6:00 AM", "6:30 AM", "7:00 AM", "7:30 AM", "8:00 AM", "8:30 AM", "9:00 AM"].map((timeSlot, i) => ({
          timeSlot,
          createdAt: ago(400 - i * 30),
        })),
      );
      const body = { stationId: String(station._id), fuelType: "Petrol", quantity: 5, bookingDate: DATE, timeSlot: "11:00 AM", payMethod: "station" };
      const booking = await createCustomerBooking({ user: { id: String(flagged._id) }, body });
      assert.ok(booking._id, "a single signal never blocks");

      // A second request (refused for another reason) must not log a second flag.
      await assert.rejects(createCustomerBooking({ user: { id: String(flagged._id) }, body: { ...body, timeSlot: "11:30 AM" } }));
      const events = await SecurityEvent.find({ user: flagged._id }).lean();
      assert.equal(events.length, 1);
      assert.equal(events[0].action, "flagged");
      assert.equal(events[0].rule, "velocity");
    });

    await t.test("blocked through booking creation: 429 details, a blocked event, the attempt marked blocked", async () => {
      const body = { stationId: String(station._id), fuelType: "Petrol", quantity: 5, bookingDate: DATE, timeSlot: "9:00 AM", payMethod: "station" };
      await assert.rejects(createCustomerBooking({ user: { id: String(script._id) }, body }), (err) => {
        assert.equal(err.status, 429);
        assert.equal(err.reason, "RISK_BLOCKED");
        assert.ok(err.extra.retryAfterSeconds > 0);
        assert.match(err.message, /try again in about \d+ minute/);
        return true;
      });
      assert.equal(await SecurityEvent.countDocuments({ user: script._id, action: "blocked" }), 1);
      const last = await BookingAttempt.findOne({ user: script._id }).sort({ createdAt: -1 }).lean();
      assert.equal(last.outcome, "blocked");
    });

    await t.test("malformed requests are recorded as attempts and count toward velocity", async () => {
      for (let i = 0; i < 7; i++) {
        await assert.rejects(
          createCustomerBooking({ user: { id: String(flood._id) }, body: { stationId: "not-an-id", fuelType: "Petrol", quantity: 5, bookingDate: DATE, timeSlot: "9:07 AM" } }),
          (err) => err.status === 400,
        );
      }
      const rows = await BookingAttempt.find({ user: flood._id }).lean();
      assert.equal(rows.length, 7);
      assert.ok(rows.every((r) => r.outcome === "rejected" && r.station === null));
      const r = await evalFor(flood, "9:00 AM", new Date());
      assert.ok(r.reasons.some((x) => x.rule === "velocity"));
    });

    await t.test("POST /api/bookings: a per-account request ceiling stops a flood before any database work", async () => {
      const express = require("express");
      const { BOOKING_REQUESTS_PER_MINUTE: LIMIT } = require("../src/config/booking");
      const app = express().use(express.json()).use("/b", require("../src/routes/bookingRoutes"));
      const server = app.listen(0);
      try {
        const token = jwt.sign({ user: { id: String(rate._id) } }, process.env.JWT_SECRET, { expiresIn: "5m" });
        const statuses = [];
        for (let i = 0; i < LIMIT + 6; i++) {
          const r = await fetch(`http://127.0.0.1:${server.address().port}/b`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-auth-token": token },
            // Malformed on purpose: an allowed request is refused with 400 and no email.
            body: JSON.stringify({ stationId: "not-an-id", fuelType: "Petrol", quantity: 5, bookingDate: DATE, timeSlot: "9:07 AM" }),
          });
          statuses.push(r.status);
          if (r.status === 429) assert.ok(Number(r.headers.get("retry-after")) > 0, "Retry-After on a refusal");
        }
        const allowed = statuses.filter((s) => s === 400).length;
        const refused = statuses.filter((s) => s === 429).length;
        // The sliding window can admit one extra request across a minute boundary.
        assert.ok(allowed >= LIMIT && allowed <= LIMIT + 1, `allowed ${allowed}`);
        assert.equal(allowed + refused, LIMIT + 6);
        assert.equal(await BookingAttempt.countDocuments({ user: rate._id }), allowed, "a refused request writes no attempt");

        // Logged once (not once per refusal), after the response.
        let events = 0;
        for (let i = 0; i < 40 && events === 0; i++) {
          events = await SecurityEvent.countDocuments({ user: rate._id, rule: "booking-rate" });
          if (events === 0) await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(events, 1);
      } finally {
        server.close();
      }
    });

    await t.test("recordOnce: ten concurrent writes of one event in one window store exactly one", async () => {
      const event = { rule: "dedupe-check", reason: "concurrency test", score: 40, threshold: 70, action: "flagged", user: rate._id };
      const written = await Promise.all(
        Array.from({ length: 10 }, () => SecurityEvent.recordOnce(event, { windowMs: 10 * 60_000 })),
      );
      assert.equal(written.filter(Boolean).length, 1, "exactly one call reports it wrote the event");
      assert.equal(await SecurityEvent.countDocuments({ user: rate._id, rule: "dedupe-check" }), 1);
      const row = await SecurityEvent.findOne({ user: rate._id, rule: "dedupe-check" }).lean();
      assert.ok(row.createdAt instanceof Date, "createdAt is set, so the retention TTL applies");
    });

    await t.test("admin report: totals, per-rule counts, top accounts and the rules in force", async () => {
      const express = require("express");
      const app = express().use("/a", require("../src/routes/adminRoutes"));
      const server = app.listen(0);
      try {
        const token = jwt.sign({ user: { id: String(admin._id), role: "admin" } }, process.env.JWT_SECRET, { expiresIn: "5m" });
        const base = `http://127.0.0.1:${server.address().port}/a/security-events`;
        const get = async (q = "") => {
          const res = await fetch(`${base}${q}`, { headers: { "x-auth-token": token, Authorization: `Bearer ${token}` } });
          return { status: res.status, body: await res.json() };
        };

        const all = await get();
        assert.equal(all.status, 200, JSON.stringify(all.body));
        assert.ok(all.body.last24h.blocked >= 1);
        assert.ok(all.body.last24h.flagged >= 1);
        assert.equal(all.body.rules.threshold, DEFAULT_THRESHOLD);
        assert.equal(all.body.rules.requestLimit.rule, "booking-rate");
        assert.equal(all.body.rules.requestLimit.perMinute, require("../src/config/booking").BOOKING_REQUESTS_PER_MINUTE);
        assert.ok(all.body.byRule7d.some((r) => r.rule === "booking-rate" && r.action === "blocked"));
        assert.deepEqual(all.body.rules.list.map((r) => r.rule), ["velocity", "duplicate-slot", "cancellations"]);
        assert.ok(all.body.topUsers7d.some((u) => u.email === script.email && u.blocked >= 1));
        assert.ok(all.body.byRule7d.some((r) => r.action === "flagged" && r.rule === "velocity"));
        assert.ok(all.body.attempts24h.total >= 1);

        const onlyFlagged = await get("?action=flagged");
        assert.ok(onlyFlagged.body.events.length >= 1);
        assert.ok(onlyFlagged.body.events.every((e) => e.action === "flagged"));

        const byRule = await get("?rule=duplicate-slot");
        assert.ok(byRule.body.events.every((e) => e.rule.split("+").includes("duplicate-slot")));

        const anon = await fetch(base);
        assert.ok([401, 403].includes(anon.status), "admins only");
      } finally {
        server.close();
      }
    });
  } finally {
    await Booking.deleteMany({ user: { $in: userIds } });
    await BookingAttempt.deleteMany({ user: { $in: userIds } });
    await SecurityEvent.deleteMany({ user: { $in: userIds } });
    await Station.deleteOne({ _id: station._id });
    await User.deleteMany({ _id: { $in: userIds } });
    await mongoose.disconnect();
  }
});
