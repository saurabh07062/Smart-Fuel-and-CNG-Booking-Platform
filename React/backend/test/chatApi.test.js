/**
 * Phase 2 of the chat feature: the /api/chat endpoints.
 *
 * Driven over real HTTP against the app (an in-process listener, as the other
 * API tests do), because the thing being checked is the whole request path:
 * authentication, the role the SERVER resolves, the conversation's own
 * participants, and the answer a caller who is not entitled to a thread gets.
 *
 * The authorization cases are the point of this file. A customer must not be
 * able to read another customer's support thread by guessing its id, a vendor
 * must not be able to read a customer's thread with the admin team, and
 * neither may be achieved by sending a different role or user id in the body.
 *
 * DEVELOPMENT TEST DATA: users, a station, bookings and threads tagged
 * "[chat-api]" in the test database only, all removed at the end.
 *
 *   node --test test/chatApi.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const TAG = "[chat-api]";

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("chat API against MongoDB", async (t) => {
  const testDb = require("./helpers/testDb");
  const MONGO = testDb.uri();
  testDb.isolateRedis();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const { User, Station, Booking, Conversation, Message } = require("../src/models");
  await require("../src/services/core/schemaIndexes").ensureSchemaIndexes();

  const tokenFor = (id) =>
    jwt.sign({ user: { id: String(id) } }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "30m" });

  const call = async (method, route, token, body) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { "x-auth-token": token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const made = { users: [], stations: [], bookings: [], conversations: [] };
  const uniq = () => Math.random().toString(36).slice(2, 10);

  const makeUser = async (role, extra = {}) => {
    const doc = await User.create({
      name: `${TAG} ${role}`,
      email: `chatapi.${uniq()}@example.com`,
      password: "x".repeat(60),
      role,
      isVerified: true,
      ...(role === "vendor" ? { vendorStatus: "active", activated: true } : {}),
      ...extra,
    });
    made.users.push(doc._id);
    return doc;
  };

  try {
    const customer = await makeUser("customer");
    const otherCustomer = await makeUser("customer");
    const vendor = await makeUser("vendor");
    const otherVendor = await makeUser("vendor");
    const admin = await makeUser("admin");

    const station = await Station.create({
      name: `${TAG} Pump`,
      address: `${TAG} Road, Pune`,
      owner: vendor._id,
      status: "Active",
      fuelTypes: ["Petrol", "CNG"],
      prices: { petrol: 104, cng: null },
      inventory: { petrol: 5000, cng: 800 },
      contactPhone: "9876543210",
    });
    made.stations.push(station._id);

    const booking = await Booking.create({
      user: customer._id,
      station: station._id,
      fuelType: "Petrol",
      quantity: 10,
      price: 104,
      amount: 1046,
      bookingDate: "2099-04-04",
      timeSlot: "10:00 AM",
      orderId: `FM-2099-${uniq().toUpperCase()}`,
      verificationCode: "4321",
      payMethod: "station",
      paymentStatus: "due_at_station",
    });
    made.bookings.push(booking._id);

    const cToken = tokenFor(customer._id);
    const oToken = tokenFor(otherCustomer._id);
    const vToken = tokenFor(vendor._id);
    const ovToken = tokenFor(otherVendor._id);
    const aToken = tokenFor(admin._id);

    let customerThreadId = null;

    await t.test("chat is signed-in only", async () => {
      assert.equal((await call("GET", "/api/chat/context", null)).status, 401);
      assert.equal((await call("GET", "/api/chat/conversations", null)).status, 401);
      assert.equal((await call("POST", "/api/chat/conversations", null, { with: "admin" })).status, 401);
    });

    await t.test("a customer opens one support thread, and re-entering finds it", async () => {
      const first = await call("POST", "/api/chat/conversations", cToken, {
        with: "admin",
        topic: "booking",
        subject: `${TAG} my booking has not moved`,
        bookingId: String(booking._id),
        message: "My booking has not moved in the queue for 20 minutes.",
      });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body.created, true);
      customerThreadId = first.body.conversation.conversationId;
      made.conversations.push(customerThreadId);

      assert.equal(first.body.conversation.kind, "customer_admin");
      assert.equal(first.body.conversation.status, "open");
      assert.equal(first.body.conversation.topic, "booking");
      assert.equal(first.body.messages.length, 1);
      assert.equal(first.body.messages[0].senderRole, "customer", "the server decides the role");
      // The booking snapshot is attached by the server from the real booking.
      assert.equal(first.body.messages[0].context.reference, booking.orderId);
      assert.equal(first.body.messages[0].context.station.name, station.name);

      // Tapping "Chat with Admin" again is the same thread, not a second one.
      const again = await call("POST", "/api/chat/conversations", cToken, { with: "admin" });
      assert.equal(again.status, 200);
      assert.equal(again.body.created, false);
      assert.equal(again.body.conversation.conversationId, customerThreadId);
      assert.equal(await Conversation.countDocuments({ customer: customer._id, kind: "customer_admin" }), 1);
    });

    await t.test("a customer cannot attach someone else's booking", async () => {
      const r = await call("POST", "/api/chat/conversations", oToken, {
        with: "admin",
        subject: `${TAG} not my booking`,
        bookingId: String(booking._id),
      });
      assert.equal(r.status, 201);
      made.conversations.push(r.body.conversation.conversationId);
      assert.equal(r.body.conversation.booking, null, "the other customer's booking is not attached");
    });

    await t.test("another customer cannot read or write the thread", async () => {
      const read = await call("GET", `/api/chat/conversations/${customerThreadId}`, oToken);
      assert.equal(read.status, 404, "404, not 403: whose thread it is stays private");
      const write = await call("POST", `/api/chat/conversations/${customerThreadId}/messages`, oToken, { body: "let me in" });
      assert.equal(write.status, 404);
      assert.equal(await Message.countDocuments({ conversation: customerThreadId }), 1);
    });

    await t.test("a vendor cannot read a customer's thread with the admin team", async () => {
      const read = await call("GET", `/api/chat/conversations/${customerThreadId}`, vToken);
      assert.equal(read.status, 404, "even though the booking is at this vendor's own station");
    });

    await t.test("the customer's own list shows only their own threads", async () => {
      const mine = await call("GET", "/api/chat/conversations", cToken);
      assert.equal(mine.status, 200);
      assert.equal(mine.body.conversations.length, 1);
      assert.equal(mine.body.conversations[0].conversationId, customerThreadId);
      // No admin identity, no other side's contact details.
      assert.equal(mine.body.conversations[0].customer, undefined);
      assert.deepEqual(mine.body.conversations[0].counterparty, { role: "admin", name: "FuelMart support" });
    });

    await t.test("the admin sees it, replies, and the unread counts follow", async () => {
      const waiting = await call("GET", "/api/chat/unread", aToken);
      assert.equal(waiting.status, 200);
      assert.ok(waiting.body.threads >= 1, JSON.stringify(waiting.body));

      const list = await call("GET", "/api/chat/conversations?kind=customer_admin&status=open", aToken);
      assert.equal(list.status, 200);
      const row = list.body.conversations.find((c) => c.conversationId === customerThreadId);
      assert.ok(row, "the admin centre lists the thread");
      assert.equal(row.customer.name, `${TAG} customer`, "the admin console identifies the account");
      assert.equal(row.unread, 1, "one message waiting for the team");

      // Opening it clears the team's count.
      const opened = await call("GET", `/api/chat/conversations/${customerThreadId}`, aToken);
      assert.equal(opened.status, 200);
      assert.equal(opened.body.conversation.unread, 0);

      const reply = await call("POST", `/api/chat/conversations/${customerThreadId}/messages`, aToken, {
        body: "Thanks -- we are checking with the station now.",
      });
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      assert.equal(reply.body.message.senderRole, "admin");

      const stored = await Conversation.findById(customerThreadId).lean();
      assert.equal(stored.unread.customer, 1, "the customer now has one unread");
      assert.equal(stored.unread.admin, 0);
      assert.equal(stored.lastMessage.text, "Thanks -- we are checking with the station now.");
      assert.ok(stored.assignedAdmin, "the replying admin is recorded");
    });

    await t.test("a retried send is the same message", async () => {
      const clientId = `retry-${uniq()}`;
      const once = await call("POST", `/api/chat/conversations/${customerThreadId}/messages`, cToken, {
        body: "Sending this once.",
        clientId,
      });
      assert.equal(once.status, 201);
      const twice = await call("POST", `/api/chat/conversations/${customerThreadId}/messages`, cToken, {
        body: "Sending this once.",
        clientId,
      });
      assert.equal(twice.status, 200);
      assert.equal(twice.body.duplicate, true);
      assert.equal(twice.body.message.messageId, once.body.message.messageId);
      assert.equal(await Message.countDocuments({ conversation: customerThreadId, clientId }), 1);
    });

    await t.test("an empty message is refused", async () => {
      const r = await call("POST", `/api/chat/conversations/${customerThreadId}/messages`, cToken, { body: "   " });
      assert.equal(r.status, 400);
      assert.match(r.body.msg, /Type a message/);
    });

    await t.test("the role in the body changes nothing", async () => {
      // The classic attempt: claim to be an admin in the payload.
      const r = await call("POST", `/api/chat/conversations/${customerThreadId}/messages`, cToken, {
        body: "I am the admin now.",
        senderRole: "admin",
        role: "admin",
        sender: String(admin._id),
      });
      assert.equal(r.status, 201);
      assert.equal(r.body.message.senderRole, "customer", "the server resolved the role from the session");
      assert.equal(r.body.message.senderId, String(customer._id));
    });

    await t.test("a vendor opens their own support thread with the admin team", async () => {
      const r = await call("POST", "/api/chat/conversations", vToken, {
        with: "admin",
        topic: "station",
        subject: `${TAG} price update not showing`,
        message: "I published a new petrol price and customers still see the old one.",
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const id = r.body.conversation.conversationId;
      made.conversations.push(id);
      assert.equal(r.body.conversation.kind, "vendor_admin");
      assert.equal(r.body.messages[0].senderRole, "vendor");

      // Another vendor cannot see it.
      assert.equal((await call("GET", `/api/chat/conversations/${id}`, ovToken)).status, 404);
      const theirs = await call("GET", "/api/chat/conversations", ovToken);
      assert.equal(theirs.body.conversations.length, 0);

      // The admin centre lists it with the vendor and station identified.
      const list = await call("GET", "/api/chat/conversations?kind=vendor_admin", aToken);
      const row = list.body.conversations.find((c) => c.conversationId === id);
      assert.ok(row);
      assert.equal(row.vendor.userId, String(vendor._id));
    });

    await t.test("Contact Vendor opens a booking-scoped thread with the station", async () => {
      const r = await call("POST", "/api/chat/conversations", cToken, {
        with: "vendor",
        bookingId: String(booking._id),
        message: "Will my slot still be honoured if I am five minutes late?",
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const id = r.body.conversation.conversationId;
      made.conversations.push(id);
      assert.equal(r.body.conversation.kind, "customer_vendor");
      assert.equal(r.body.conversation.booking.bookingId, String(booking._id));
      assert.equal(r.body.conversation.counterparty.role, "vendor");

      // The station's own vendor can read and reply.
      const vendorRead = await call("GET", `/api/chat/conversations/${id}`, vToken);
      assert.equal(vendorRead.status, 200);
      assert.equal(vendorRead.body.conversation.counterparty.role, "customer");
      const vendorReply = await call("POST", `/api/chat/conversations/${id}/messages`, vToken, { body: "Yes, come in -- we will hold it." });
      assert.equal(vendorReply.status, 201);
      assert.equal(vendorReply.body.message.senderRole, "vendor");

      // A different vendor cannot.
      assert.equal((await call("GET", `/api/chat/conversations/${id}`, ovToken)).status, 404);
      // And an admin does not join it: it is between those two.
      assert.equal((await call("GET", `/api/chat/conversations/${id}`, aToken)).status, 404);
    });

    await t.test("a customer cannot contact a vendor about a booking that is not theirs", async () => {
      const r = await call("POST", "/api/chat/conversations", oToken, { with: "vendor", bookingId: String(booking._id) });
      assert.equal(r.status, 404);
      assert.match(r.body.msg, /Booking not found/);
    });

    await t.test("only an admin changes a thread's status, and it is recorded", async () => {
      const refused = await call("PATCH", `/api/chat/conversations/${customerThreadId}/status`, cToken, { status: "resolved" });
      assert.equal(refused.status, 403);

      const done = await call("PATCH", `/api/chat/conversations/${customerThreadId}/status`, aToken, { status: "resolved" });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal(done.body.conversation.status, "resolved");

      const thread = await call("GET", `/api/chat/conversations/${customerThreadId}`, cToken);
      const notes = thread.body.messages.filter((m) => m.kind === "system");
      assert.equal(notes.length, 1, "both sides can see that the team resolved it");
      assert.match(notes[0].body, /resolved/);

      const junk = await call("PATCH", `/api/chat/conversations/${customerThreadId}/status`, aToken, { status: "sorted" });
      assert.equal(junk.status, 400);
    });

    await t.test("a customer's reply reopens a resolved thread", async () => {
      const r = await call("POST", `/api/chat/conversations/${customerThreadId}/messages`, cToken, { body: "It happened again today." });
      assert.equal(r.status, 201);
      assert.equal((await Conversation.findById(customerThreadId).lean()).status, "open");
    });

    await t.test("a closed thread is history: readable, not writable", async () => {
      await call("PATCH", `/api/chat/conversations/${customerThreadId}/status`, aToken, { status: "closed" });
      const read = await call("GET", `/api/chat/conversations/${customerThreadId}`, cToken);
      assert.equal(read.status, 200, "history stays readable");
      const write = await call("POST", `/api/chat/conversations/${customerThreadId}/messages`, cToken, { body: "hello?" });
      assert.equal(write.status, 409);
      assert.equal(write.body.reason, "CONVERSATION_CLOSED");
    });

    await t.test("a made-up or malformed conversation id is not found", async () => {
      assert.equal((await call("GET", "/api/chat/conversations/not-an-id", cToken)).status, 404);
      assert.equal((await call("GET", `/api/chat/conversations/${new mongoose.Types.ObjectId()}`, cToken)).status, 404);
    });
  } finally {
    await Promise.all([
      Message.deleteMany({ conversation: { $in: made.conversations } }),
      Conversation.deleteMany({ $or: [{ _id: { $in: made.conversations } }, { createdBy: { $in: made.users } }] }),
      Booking.deleteMany({ _id: { $in: made.bookings } }),
      Station.deleteMany({ _id: { $in: made.stations } }),
      User.deleteMany({ _id: { $in: made.users } }),
    ]);
    server.close();
    await mongoose.disconnect();
  }
});
