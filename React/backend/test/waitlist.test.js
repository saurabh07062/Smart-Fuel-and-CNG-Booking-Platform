/**
 * Waitlist: joining a full slot, slot-specific promotion, positions,
 * leaving, stock rules, expiry and the vendor view.
 *
 * services/booking/bookingCreate.js (joinWaitlist), services/booking/booking.js
 * (promoteFromWaitlist, attachWaitlistPositions), controllers/bookingController
 * (cancel), services/booking/bookingSweep.js and GET /api/v1/slots/waitlist/:stationId.
 *
 * DEVELOPMENT TEST DATA, test database only: tagged users and stations with
 * no map position, bookings on 2099 dates (plus one today for expiry), all
 * removed at the end. Services are called directly, so no email is sent.
 *
 *   node --test test/waitlist.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("waitlist against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const jwt = require("jsonwebtoken");
  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const BookingAttempt = require("../src/models/BookingAttempt");
  const Notification = require("../src/models/Notification");
  const SecurityEvent = require("../src/models/SecurityEvent");
  const { createCustomerBooking } = require("../src/services/booking/bookingCreate");
  const bookingService = require("../src/services/booking/booking");
  const { transitionBooking } = require("../src/services/booking/bookingTransitions");
  const { sweepStaleBookings } = require("../src/services/booking/bookingSweep");
  const bookingController = require("../src/controllers/bookingController");
  const { dateKey, clockParts } = require("../src/config/businessTime");
  await Promise.all([Booking.init(), Notification.init()]);

  const DATE = "2099-11-02";
  const tag = `wl-${Date.now()}`;
  const [vendor, otherVendor] = await User.insertMany(
    ["v", "o"].map((k) => ({
      name: `${tag}-${k}`,
      email: `${tag}-${k}@example.com`,
      password: "not-a-real-hash",
      role: "vendor",
      vendorStatus: "active",
    })),
  );
  const customers = await User.insertMany(
    Array.from({ length: 8 }, (_, i) => ({
      name: `${tag}-c${i}`,
      email: `${tag}-c${i}@example.com`,
      password: "not-a-real-hash",
      role: "customer",
      isVerified: true,
    })),
  );
  const [A, B, C, D, E, F, G] = customers;
  const userIds = [vendor._id, otherVendor._id, ...customers.map((c) => c._id)];

  const stationIds = [];
  const makeStation = async (name) => {
    const s = await Station.create({
      name: `${tag}-${name}`,
      address: "Waitlist Test",
      owner: vendor._id,
      status: "Active",
      fuelTypes: ["Petrol"],
      prices: { petrol: 100 },
      inventory: { petrol: 100 },
    });
    stationIds.push(s._id);
    return s;
  };
  const station = await makeStation("main");

  const book = (user, timeSlot, extra = {}) =>
    createCustomerBooking({
      user: { id: String(user._id) },
      body: { stationId: String(station._id), fuelType: "Petrol", quantity: 10, bookingDate: DATE, timeSlot, payMethod: "station", ...extra },
    });
  const reload = (b) => Booking.findById(b._id).lean();
  const committed = async () => (await Station.findById(station._id).lean()).inventoryCommitted?.petrol || 0;
  const res = () => ({
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  });

  try {
    let a;
    let b;
    let c;
    let d;
    let e;

    await t.test("a full slot is refused without joinWaitlist, and a waitlist request must pay at the station", async () => {
      a = await book(A, "10:00 AM");
      assert.equal(a.status, "upcoming");
      await assert.rejects(book(B, "10:00 AM"), { reason: "SLOT_FULL" });
      await assert.rejects(book(B, "10:00 AM", { joinWaitlist: true, payMethod: "UPI" }), { reason: "WAITLIST_PAY_AT_STATION" });
    });

    await t.test("joining: waitlisted, no PIN, no stock reserved, first come first served", async () => {
      b = await book(B, "10:00 AM", { joinWaitlist: true });
      c = await book(C, "10:00 AM", { joinWaitlist: true });
      assert.equal(b.status, "waitlisted");
      assert.equal(b.stockReserved, false);
      assert.equal(b.verificationCode, undefined);
      assert.equal(await committed(), 10, "only the confirmed booking holds stock");

      const [pb, pc] = await bookingService.attachWaitlistPositions([await Booking.findById(b._id), await Booking.findById(c._id)]);
      assert.equal(pb.waitlistPosition, 1);
      assert.equal(pc.waitlistPosition, 2);
    });

    await t.test("joinWaitlist on a slot that is actually free simply books it", async () => {
      d = await book(D, "10:30 AM", { joinWaitlist: true });
      assert.equal(d.status, "upcoming");
      assert.equal(d.stockReserved, true);
      e = await book(E, "10:30 AM", { joinWaitlist: true });
      assert.equal(e.status, "waitlisted");
      assert.equal(await committed(), 20);
    });

    await t.test("waiting for fuel the station cannot sell is refused", async () => {
      // 11:00 is free, so book it to fill it, then 70 L in the tank with 30 L
      // committed leaves 40 L: a 50 L waitlist request cannot be honoured.
      const holder = await book(F, "11:00 AM");
      await Station.updateOne({ _id: station._id }, { $set: { "inventory.petrol": 70 } });
      try {
        await assert.rejects(book(G, "11:00 AM", { quantity: 50, joinWaitlist: true }), { reason: "INSUFFICIENT_STOCK" });
      } finally {
        await Station.updateOne({ _id: station._id }, { $set: { "inventory.petrol": 100 } });
        await transitionBooking({ bookingId: holder._id, to: "cancelled", set: { cancelledBy: "customer" } });
      }
      assert.equal(await committed(), 20);
    });

    await t.test("a customer cancelling promotes the first customer waiting for THAT slot only", async () => {
      const r = res();
      await bookingController.cancelBooking({ params: { id: String(a._id) }, user: { id: String(A._id) } }, r);
      assert.equal(r.statusCode, 200, JSON.stringify(r.body));

      const pb = await reload(b);
      assert.equal(pb.status, "upcoming", "B joined first for 10:00");
      assert.match(pb.verificationCode, /^\d{4}$/, "promotion issues the PIN");
      assert.equal(pb.stockReserved, true);
      assert.equal(pb.waitlistPriority, null);
      assert.equal((await reload(c)).status, "waitlisted", "only one nozzle window freed");
      assert.equal((await reload(e)).status, "waitlisted", "10:30 is still held by D");
      assert.equal(await committed(), 20, "A's 10 L released, B's 10 L reserved");

      const [pc] = await bookingService.attachWaitlistPositions([await Booking.findById(c._id)]);
      assert.equal(pc.waitlistPosition, 1, "C moves up");

      const note = await Notification.findOne({ user: B._id, type: "booking_promoted" }).lean();
      assert.ok(note, "the promoted customer is notified");
    });

    await t.test("leaving the waitlist cancels it and promotes nobody", async () => {
      const r = res();
      await bookingController.cancelBooking({ params: { id: String(c._id) }, user: { id: String(C._id) } }, r);
      assert.equal(r.body.msg, "Left the waitlist");
      assert.equal((await reload(c)).status, "cancelled");
      assert.equal(await committed(), 20);
    });

    await t.test("a waitlisted booking whose slot has passed is never promoted", async () => {
      await transitionBooking({ bookingId: d._id, to: "cancelled", set: { cancelledBy: "vendor" } });
      assert.equal(await bookingService.promoteFromWaitlist(station._id, undefined, { now: new Date("2100-01-01T00:00:00Z") }), null);
      assert.equal((await reload(e)).status, "waitlisted");

      const promoted = await bookingService.promoteFromWaitlist(station._id);
      assert.equal(String(promoted?._id), String(e._id), "with the slot still ahead, E gets 10:30");
    });

    await t.test("the vendor view lists the waitlist to the station's owner only", async () => {
      await book(G, "10:00 AM", { joinWaitlist: true });
      const express = require("express");
      const app = express().use("/s", require("../src/routes/slotRoutes"));
      const server = app.listen(0);
      try {
        const url = `http://127.0.0.1:${server.address().port}/s/waitlist/${station._id}`;
        const get = (user) => {
          const token = jwt.sign({ user: { id: String(user._id), role: user.role } }, process.env.JWT_SECRET, { expiresIn: "5m" });
          return fetch(url, { headers: { "x-auth-token": token, Authorization: `Bearer ${token}` } });
        };
        assert.equal((await get(otherVendor)).status, 403);
        const ok = await get(vendor);
        assert.equal(ok.status, 200);
        const body = await ok.json();
        assert.equal(body.length, 1);
        assert.equal(body.entries[0].timeSlot, "10:00 AM");
      } finally {
        server.close();
      }
    });

    await t.test("the sweep expires today's waitlist requests whose slot has passed", async (st) => {
      const now = clockParts(new Date());
      if (now.hours * 60 + now.minutes < 6 * 60 + 31) {
        st.skip("needs the 6:00 AM slot to have passed today (India time)");
        return;
      }
      const other = await makeStation("sweep");
      const lapsed = await Booking.create({
        user: F._id,
        station: other._id,
        fuelType: "Petrol",
        quantity: 10,
        price: 100,
        amount: 1000,
        bookingDate: dateKey(),
        timeSlot: "6:00 AM",
        status: "waitlisted",
        waitlistPriority: Date.now(),
      });
      const result = await sweepStaleBookings(undefined, { stationIds: [other._id] });
      assert.equal(result.waitlistExpired, 1);
      assert.equal((await reload(lapsed)).status, "expired");
    });
  } finally {
    await Booking.deleteMany({ station: { $in: stationIds } });
    await BookingAttempt.deleteMany({ user: { $in: userIds } });
    await Notification.deleteMany({ user: { $in: userIds } });
    await SecurityEvent.deleteMany({ user: { $in: userIds } });
    await Station.deleteMany({ _id: { $in: stationIds } });
    await User.deleteMany({ _id: { $in: userIds } });
    await mongoose.disconnect();
  }
});
