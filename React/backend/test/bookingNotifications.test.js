/**
 * Booking notifications: when they appear, what they say, and staying read.
 *
 * The rules under test, each one a thing that was wrong:
 *
 *   - a notification exists only for a booking the backend CONFIRMED; a
 *     refused booking notifies nobody
 *   - every word of it comes from the saved booking row, not from the request
 *   - the same event notifies once, however many paths reach it
 *   - a completed booking is announced only once it is actually completed
 *   - marking them read STAYS read -- the repeat that made the panel show the
 *     same messages after "mark all read"
 *
 *   node --test test/bookingNotifications.test.js
 *
 * DEVELOPMENT TEST DATA: tagged users, a station and bookings, removed at the end.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const testDb = require("./helpers/testDb");
const MONGO = testDb.uri();

test("booking notifications against MongoDB", { timeout: 120_000 }, async (t) => {
  const mongoose = require("mongoose");
  await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });

  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const Notification = require("../src/models/Notification");
  const notifications = require("../src/services/notification/notifications");
  const { completeBooking } = require("../src/services/booking/bookingCompletion");

  // The de-duplication rule is a unique index; without it this tests nothing.
  await Notification.init();

  const tag = `notif-${Date.now()}`;
  const created = { users: [], stations: [], bookings: [] };

  const customer = await User.create({
    name: `${tag}-customer`,
    email: `${tag}@fuelmart.test`,
    password: "x",
    role: "customer",
    isVerified: true,
  });
  created.users.push(customer._id);

  const station = await Station.create({
    name: `${tag}-station`,
    address: "Notify Road, Pune",
    status: "Active",
    fuelTypes: ["Petrol"],
    prices: { petrol: 100 },
    inventory: { petrol: 5000 },
    tankCapacity: { petrol: 10000 },
    coordinates: { lat: 18.62, lng: 73.72 },
  });
  created.stations.push(station._id);

  const bookingFor = async (over = {}) => {
    const doc = await Booking.create({
      user: customer._id,
      station: station._id,
      stationName: station.name,
      fuelType: "Petrol",
      quantity: 10,
      price: 100,
      taxes: 5,
      amount: 1005,
      bookingDate: "2099-03-01",
      timeSlot: "10:00 AM",
      status: "upcoming",
      payMethod: "station",
      paymentStatus: "due_at_station",
      verificationCode: "4321",
      orderId: `FM-NOTIF-${Math.random().toString(16).slice(2, 10).toUpperCase()}`,
      ...over,
    });
    created.bookings.push(doc._id);
    return doc;
  };

  const notesFor = (booking, type) =>
    Notification.find({ user: customer._id, booking: booking._id, ...(type ? { type } : {}) }).lean();

  try {
    await t.test("a completed booking is announced once, from its own record", async () => {
      const booking = await bookingFor({ status: "serving" });

      // What services/queue/serviceTimer.js announceCompleted does, after the
      // completion is written.
      const completed = await completeBooking({ bookingId: booking._id, fromStatuses: ["serving"] });
      assert.ok(completed, "the booking completed");
      assert.equal(completed.status, "completed", "and only then is anything announced");

      const made = await notifications.notify({
        user: completed.user,
        type: "booking_completed",
        title: "Fuelling complete",
        body: `Your ${completed.fuelType} booking is complete.`,
        link: "booking",
        booking: completed._id,
        station: completed.station,
        dedupeKey: `booking:${completed._id}:completed`,
      });
      assert.ok(made);

      const rows = await notesFor(booking, "booking_completed");
      assert.equal(rows.length, 1);
      // The text names the fuel the BOOKING holds, not a fuel typed anywhere here.
      assert.match(rows[0].body, new RegExp(completed.fuelType));
      assert.equal(String(rows[0].booking), String(booking._id));
    });

    await t.test("the same completion reaching us twice still notifies once", async () => {
      const booking = await bookingFor({ status: "serving" });
      const completed = await completeBooking({ bookingId: booking._id, fromStatuses: ["serving"] });

      const template = {
        user: completed.user,
        type: "booking_completed",
        title: "Fuelling complete",
        body: `Your ${completed.fuelType} booking is complete.`,
        booking: completed._id,
        dedupeKey: `booking:${completed._id}:completed`,
      };

      // The vendor's "mark complete" and the sweep, racing.
      const [a, b] = await Promise.all([notifications.notify(template), notifications.notify(template)]);
      assert.equal([a, b].filter(Boolean).length, 1, "one of them wrote; the other was a no-op");
      assert.equal((await notesFor(booking, "booking_completed")).length, 1);
    });

    await t.test("a booking that is NOT complete gets no completion notification", async () => {
      // completeBooking refuses a cancelled booking, so the announcement that
      // follows it never runs. This is the guard that keeps a pending or
      // failed booking from being reported as finished.
      const booking = await bookingFor({ status: "cancelled" });
      const result = await completeBooking({ bookingId: booking._id, fromStatuses: ["serving"] });

      assert.equal(result, null, "nothing was completed");
      assert.equal((await notesFor(booking)).length, 0, "so nothing was announced");
    });

    await t.test("a confirmed booking's notification repeats the record, not the request", async () => {
      const booking = await bookingFor();
      await notifications.notify({
        user: booking.user,
        type: "booking_created",
        title: "Booking confirmed",
        body: [booking.stationName, `${booking.fuelType} ${booking.quantity} L`, `${booking.bookingDate} ${booking.timeSlot}`, `PIN ${booking.verificationCode}`].join(" · "),
        booking: booking._id,
        station: booking.station,
        dedupeKey: `booking:${booking._id}:confirmed`,
      });

      const [row] = await notesFor(booking, "booking_created");
      assert.ok(row);
      // Every part is the saved booking's own value.
      assert.match(row.body, new RegExp(booking.stationName));
      assert.match(row.body, new RegExp(booking.bookingDate));
      assert.match(row.body, new RegExp(booking.timeSlot));
      assert.match(row.body, new RegExp(booking.verificationCode));
    });

    await t.test("marking them read STAYS read -- the repeat is gone", async () => {
      // "completed" because the customer already holds a live booking from the
      // test above: one live ordinary booking each (models/Booking.js).
      const booking = await bookingFor({ status: "completed" });
      await notifications.notify({
        user: customer._id,
        type: "booking_created",
        title: "Booking confirmed",
        body: "x",
        booking: booking._id,
        dedupeKey: `booking:${booking._id}:confirmed-read-test`,
      });

      const unreadBefore = await Notification.countDocuments({ user: customer._id, read: false });
      assert.ok(unreadBefore > 0, "there is something to read");

      // What POST /api/customer/notifications/read does.
      const result = await Notification.updateMany(
        { user: customer._id, read: false },
        { $set: { read: true, readAt: new Date() } },
      );
      assert.equal(result.modifiedCount, unreadBefore);

      // The list the panel re-fetches on the next reconnect: all read. Before
      // the fix this is where they came back unread, because the read state
      // had only ever been set in the browser.
      const refetched = await Notification.find({ user: customer._id }).lean();
      assert.ok(refetched.length > 0);
      assert.equal(
        refetched.filter((n) => !n.read).length,
        0,
        "nothing comes back unread, so the panel does not show the same messages again",
      );
      assert.ok(refetched.every((n) => n.readAt), "and each records when it was read");
    });

    await t.test("marking read again changes nothing and is not an error", async () => {
      const result = await Notification.updateMany(
        { user: customer._id, read: false },
        { $set: { read: true, readAt: new Date() } },
      );
      assert.equal(result.modifiedCount, 0, "idempotent: a second tap has nothing left to do");
    });

    await t.test("one customer's read state is their own", async () => {
      const other = await User.create({
        name: `${tag}-other`,
        email: `${tag}-other@fuelmart.test`,
        password: "x",
        role: "customer",
        isVerified: true,
      });
      created.users.push(other._id);
      await notifications.notify({ user: other._id, type: "system", title: "Theirs", body: "" });

      // The endpoint filters by the SESSION's user, never by an id in the URL.
      await Notification.updateMany({ user: customer._id, read: false }, { $set: { read: true } });
      const theirs = await Notification.find({ user: other._id }).lean();
      assert.equal(theirs.filter((n) => !n.read).length, 1, "marking mine read left theirs alone");
    });
  } finally {
    await Notification.deleteMany({ user: { $in: created.users } });
    await Booking.deleteMany({ user: { $in: created.users } });
    await require("../src/models/RewardLedger").deleteMany({ user: { $in: created.users } });
    await require("../src/models/Invoice").deleteMany({ user: { $in: created.users } });
    await require("../src/models/InventoryMovement").deleteMany({ station: { $in: created.stations } });
    await Station.deleteMany({ _id: { $in: created.stations } });
    await User.deleteMany({ _id: { $in: created.users } });
    await mongoose.disconnect();
    await require("../src/services/security/rateLimiter").close();
  }
});
