/**
 * Phase 3 of the chat feature: the assistant's context and its answers.
 *
 * The two rules this file exists to hold:
 *
 *   1. Every figure comes from the real system. A queue position the assistant
 *      states must be the one services/queue/queueInfo.js produced for that
 *      booking, the price must be the one the station published, the stock must
 *      be the station's own -- so the assistant can never contradict the
 *      screen the customer is looking at.
 *
 *   2. It never invents. An unpublished price is "not published", a queue that
 *      cannot be read is said to be unavailable, and an unrecognised question
 *      is answered with "I did not understand" rather than something
 *      plausible.
 *
 * Plus the obvious boundary: one customer's context never contains another
 * customer's booking, and a vendor's context never contains another vendor's
 * station.
 *
 * DEVELOPMENT TEST DATA: users, stations and bookings tagged "[chatbot]" in the
 * test database only, all removed at the end.
 *
 *   node --test test/chatbot.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");

const TAG = "[chatbot]";

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("the assistant against MongoDB", async (t) => {
  const testDb = require("./helpers/testDb");
  const MONGO = testDb.uri();
  testDb.isolateRedis();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const { User, Station, Booking, Conversation, Message } = require("../src/models");
  const chatbot = require("../src/services/chat/chatbot");
  const { dateKey } = require("../src/config/businessTime");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");
  const { BOOKABLE_SLOT_LABELS } = require("../src/config/booking");

  const made = { users: [], stations: [], bookings: [], conversations: [] };
  const uniq = () => Math.random().toString(36).slice(2, 10);

  const makeUser = async (role) => {
    const doc = await User.create({
      name: `${TAG} ${role}`,
      email: `bot.${uniq()}@example.com`,
      password: "x".repeat(60),
      role,
      ...(role === "vendor" ? { vendorStatus: "active", activated: true } : {}),
    });
    made.users.push(doc._id);
    return doc;
  };

  try {
    const customer = await makeUser("customer");
    const bookingless = await makeUser("customer");
    const vendor = await makeUser("vendor");
    const otherVendor = await makeUser("vendor");
    const admin = await makeUser("admin");

    // A station that publishes petrol but NOT cng: the unpublished price is
    // what the "never invents" assertions below hang on.
    const station = await Station.create({
      name: `${TAG} Baner Fuels`,
      address: `${TAG} Baner Road, Pune`,
      owner: vendor._id,
      status: "Active",
      fuelTypes: ["Petrol", "CNG"],
      prices: { petrol: 104.5, cng: null },
      inventory: { petrol: 4000, cng: 600 },
      inventoryCommitted: { petrol: 50, cng: 0 },
      tankCapacity: { petrol: 10000, cng: 2000 },
      contactPhone: "9876543210",
    });
    made.stations.push(station._id);

    const otherStation = await Station.create({
      name: `${TAG} Someone Else's Pump`,
      address: `${TAG} Elsewhere`,
      owner: otherVendor._id,
      status: "Active",
    });
    made.stations.push(otherStation._id);

    const today = dateKey();
    const label = BOOKABLE_SLOT_LABELS[10] || "05:00 AM";
    const window = nozzleScheduler.computeWindow("Petrol", nozzleScheduler.parseStartDateTime(today, label));

    const booking = await Booking.create({
      user: customer._id,
      station: station._id,
      fuelType: "Petrol",
      quantity: 12,
      price: 104.5,
      amount: 1254,
      bookingDate: today,
      timeSlot: label,
      bookingStartTime: window.start,
      bookingEndTime: window.end,
      serviceDurationSeconds: window.durationSeconds,
      orderId: `FM-2099-${uniq().toUpperCase()}`,
      verificationCode: "7788",
      payMethod: "station",
      paymentStatus: "due_at_station",
      status: "upcoming",
      vehiclePlate: "MH12AB3456",
    });
    made.bookings.push(booking._id);

    const asUser = (u) => ({ id: String(u._id), role: u.role });

    await t.test("a customer with a booking gets their own booking, with live figures", async () => {
      const ctx = await chatbot.contextFor(asUser(customer));

      assert.equal(ctx.role, "customer");
      assert.equal(ctx.booking.available, true);
      assert.equal(ctx.booking.hasBooking, true);

      const s = ctx.booking.summary;
      assert.equal(s.bookingId, String(booking._id));
      assert.equal(s.reference, booking.orderId);
      assert.equal(s.fuelType, "Petrol");
      assert.equal(s.quantity, 12);
      assert.equal(s.unit, "L", "petrol is litres");
      assert.equal(s.amount, 1254);
      assert.equal(s.timeSlot, label);
      assert.equal(s.station.name, station.name);
      assert.equal(s.station.phone, "9876543210");
      assert.equal(s.payment.status, "due_at_station");

      // The queue figures are queueInfo's own, for this booking.
      const [live] = await require("../src/services/queue/queueInfo").withQueueInfo([await Booking.findById(booking._id)]);
      assert.equal(s.queue.queuePosition, live.queueInfo.queuePosition);
      assert.equal(s.queue.expectedWaitingTime, live.queueInfo.expectedWaitingTime);

      // The PIN is theirs, and the truth about it is told: it does not work
      // until they have checked in at the pump.
      assert.deepEqual(s.pin, { code: "7788", usable: false });
      assert.equal(s.checkIn.done, false);

      // The quick actions are the booking ones, not the generic help list.
      assert.ok(ctx.quickActions.some((a) => a.id === "booking_queue"));
      assert.equal(ctx.canContactVendor, true);
    });

    await t.test("a customer with no booking is offered the help topics, not an empty card", async () => {
      const ctx = await chatbot.contextFor(asUser(bookingless));
      assert.equal(ctx.booking.available, true, "the read worked");
      assert.equal(ctx.booking.hasBooking, false, "they simply have none");
      assert.equal(ctx.booking.summary, null);
      assert.equal(ctx.canContactVendor, false);
      assert.match(ctx.greeting, /no active booking/i);
      for (const id of ["find_station", "book_slot", "cancel_booking", "check_in", "queue_eta", "payment"]) {
        assert.ok(ctx.quickActions.some((a) => a.id === id), `offers ${id}`);
      }
    });

    await t.test("one customer's context never contains another's booking", async () => {
      const ctx = await chatbot.contextFor(asUser(bookingless));
      assert.equal(JSON.stringify(ctx).includes(String(booking._id)), false);
      assert.equal(JSON.stringify(ctx).includes("7788"), false, "and never their code");
    });

    await t.test("\"Where is my booking?\" is answered from that booking", async () => {
      const r = await chatbot.answer(asUser(customer), { question: "where is my booking?" });
      assert.equal(r.understood, true);
      assert.equal(r.intent, "booking_where");
      assert.match(r.answer, new RegExp(booking.orderId));
      assert.match(r.answer, new RegExp(station.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(r.answer, /confirmed, waiting for you to arrive/);
      assert.match(r.answer, /have not checked in yet/);
      assert.match(r.answer, /Payment is due at the pump/);
    });

    await t.test("\"I want to book fuel\" guides a customer who has none", async () => {
      const r = await chatbot.answer(asUser(bookingless), { question: "I want to book fuel" });
      assert.equal(r.intent, "book_slot");
      assert.match(r.answer, /choose a time slot/i);
    });

    await t.test("the code answer tells the truth about when the code works", async () => {
      const before = await chatbot.answer(asUser(customer), { intent: "booking_checkin" });
      assert.match(before.answer, /7788/);
      assert.match(before.answer, /starts working the moment you check in/);

      await Booking.updateOne({ _id: booking._id }, { $set: { stationCheckInAt: new Date(), stationCheckInDistanceM: 40 } });
      const after = await chatbot.answer(asUser(customer), { intent: "booking_checkin" });
      assert.match(after.answer, /Show it to the attendant/);
      await Booking.updateOne({ _id: booking._id }, { $set: { stationCheckInAt: null, stationCheckInDistanceM: null } });
    });

    await t.test("a vendor is answered from their own station only", async () => {
      const ctx = await chatbot.contextFor(asUser(vendor));
      assert.equal(ctx.role, "vendor");
      assert.equal(ctx.stations.count, 1, "only the station they own");
      assert.equal(ctx.stations.list[0].stationId, String(station._id));
      assert.equal(JSON.stringify(ctx).includes(String(otherStation._id)), false);

      const waiting = await chatbot.answer(asUser(vendor), { question: "how many customers are waiting?" });
      assert.equal(waiting.intent, "vendor_waiting");
      assert.match(waiting.answer, new RegExp(station.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(waiting.answer, /vehicle\(s\) in line|queue could not be read/);

      const todayAnswer = await chatbot.answer(asUser(vendor), { question: "how many bookings today?" });
      assert.equal(todayAnswer.intent, "vendor_today");
      assert.match(todayAnswer.answer, /booking\(s\) today/);
    });

    await t.test("an unpublished price is reported as unpublished, never as a number", async () => {
      const ctx = await chatbot.contextFor(asUser(vendor));
      assert.equal(ctx.stations.list[0].prices.petrol, 104.5);
      assert.equal(ctx.stations.list[0].prices.cng, null, "cng has no published price");

      const r = await chatbot.answer(asUser(vendor), { intent: "vendor_prices" });
      assert.match(r.answer, /petrol: ₹104.5/);
      assert.match(r.answer, /cng: not published/);
      assert.equal(/cng: ₹0/.test(r.answer), false, "0 is not a price");
    });

    await t.test("stock is the station's own figures, with what bookings hold", async () => {
      const r = await chatbot.answer(asUser(vendor), { intent: "vendor_stock" });
      assert.match(r.answer, /petrol: 3950 free to sell of 4000 in tank \(50 held for bookings\)/);
      assert.match(r.answer, /cng: 600 free to sell of 600 in tank/);
    });

    await t.test("a vendor with no station is told so, not shown zeros as facts", async () => {
      const lonely = await makeUser("vendor");
      const ctx = await chatbot.contextFor(asUser(lonely));
      assert.equal(ctx.stations.count, 0);
      assert.match(ctx.greeting, /no station yet/);
      const r = await chatbot.answer(asUser(lonely), { intent: "vendor_waiting" });
      assert.match(r.answer, /no station yet/);
    });

    await t.test("an admin is answered from the support queue", async () => {
      const thread = await Conversation.create({
        kind: "vendor_admin",
        vendor: vendor._id,
        createdBy: vendor._id,
        participants: [{ user: vendor._id, role: "vendor" }],
        subject: `${TAG} price sync`,
        status: "open",
      });
      made.conversations.push(thread._id);

      const ctx = await chatbot.contextFor(asUser(admin));
      assert.equal(ctx.role, "admin");
      assert.equal(ctx.conversations.available, true);
      assert.ok((ctx.conversations.vendor.open || 0) >= 1);

      const r = await chatbot.answer(asUser(admin), { question: "show pending vendor issues" });
      assert.equal(r.intent, "admin_pending");
      assert.match(r.answer, /Vendor conversations: \d+ unresolved/);
      assert.deepEqual(r.action, { type: "open_centre", kind: "vendor_admin", status: "open" });
    });

    await t.test("a question it does not understand is not answered with a guess", async () => {
      const r = await chatbot.answer(asUser(customer), { question: "asdlkfj qwerty zxcv" });
      assert.equal(r.understood, false);
      assert.equal(r.intent, null);
      assert.match(r.answer, /did not understand/);
      assert.ok(r.quickActions.length > 0, "it offers what it can actually do");
    });

    await t.test("a tapped quick action wins over guessing at the words", async () => {
      // The words say "price", the button says check-in: the button is not a guess.
      const r = await chatbot.answer(asUser(customer), { question: "what is the price", intent: "booking_checkin" });
      assert.equal(r.intent, "booking_checkin");
    });

    await t.test("an unreadable queue is reported as unavailable, not as zero", async () => {
      // A waitlisted booking has no nozzle window, so it has no queue figures.
      const waitlisted = await Booking.create({
        user: (await makeUser("customer"))._id,
        station: station._id,
        fuelType: "CNG",
        quantity: 5,
        price: 0,
        amount: 5,
        bookingDate: today,
        timeSlot: label,
        status: "waitlisted",
        orderId: `FM-2099-${uniq().toUpperCase()}`,
      });
      made.bookings.push(waitlisted._id);

      const owner = { id: String(waitlisted.user), role: "customer" };
      const ctx = await chatbot.contextFor(owner);
      assert.equal(ctx.booking.summary.queue, null);
      const r = await chatbot.answer(owner, { intent: "booking_queue" });
      assert.match(r.answer, /not available/i);
      assert.equal(/number 0 in line/.test(r.answer), false);
    });
  } finally {
    await Promise.all([
      Message.deleteMany({ conversation: { $in: made.conversations } }),
      Conversation.deleteMany({ _id: { $in: made.conversations } }),
      Booking.deleteMany({ _id: { $in: made.bookings } }),
      Station.deleteMany({ _id: { $in: made.stations } }),
      User.deleteMany({ _id: { $in: made.users } }),
    ]);
    await mongoose.disconnect();
  }
});
