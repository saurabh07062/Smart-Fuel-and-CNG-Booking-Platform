/**
 * Phase 1 of the chat feature: the Conversation and Message schemas.
 *
 * These check the rules that are the security model rather than decoration: a
 * thread's sides must match its kind (or a vendor would appear in a thread
 * they were never part of), one live thread per person per kind, a customer
 * may only open a vendor thread about a booking, and a retried send is the
 * same message rather than a second one.
 *
 * DEVELOPMENT TEST DATA: users and threads tagged "[chat-test]" in the test
 * database only, all removed at the end.
 *
 *   node --test test/chatModels.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");

const TAG = "[chat-test]";

test("conversation and message schemas against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const { User, Station, Booking, Conversation, Message } = require("../src/models");
  await require("../src/services/core/schemaIndexes").ensureSchemaIndexes();

  const made = { users: [], stations: [], bookings: [], conversations: [], messages: [] };
  const uniq = () => Math.random().toString(36).slice(2, 10);

  const makeUser = async (role = "customer") => {
    const doc = await User.create({
      name: `${TAG} ${role}`,
      email: `chat.${uniq()}@example.com`,
      password: "x".repeat(60),
      role,
    });
    made.users.push(doc._id);
    return doc;
  };
  const makeStation = async (owner) => {
    const doc = await Station.create({ name: `${TAG} Pump`, address: `${TAG} Road`, owner: owner?._id ?? null });
    made.stations.push(doc._id);
    return doc;
  };
  const makeBooking = async (user, station) => {
    const doc = await Booking.create({
      user: user._id,
      station: station._id,
      fuelType: "Petrol",
      quantity: 10,
      price: 100,
      amount: 1000,
      bookingDate: "2099-05-05",
      orderId: `FM-2099-${uniq().toUpperCase()}`,
    });
    made.bookings.push(doc._id);
    return doc;
  };
  const thread = async (fields) => {
    const doc = await Conversation.create({ subject: `${TAG} Help`, ...fields });
    made.conversations.push(doc._id);
    return doc;
  };
  const customerAdmin = (customer) => ({
    kind: "customer_admin",
    customer: customer._id,
    createdBy: customer._id,
    participants: [{ user: customer._id, role: "customer" }],
  });

  try {
    await t.test("a customer support thread is the customer plus the admin team", async () => {
      const customer = await makeUser("customer");
      const conversation = await thread(customerAdmin(customer));

      assert.equal(conversation.status, "open");
      assert.equal(conversation.topic, "other");
      assert.deepEqual({ ...conversation.unread.toObject?.() ?? conversation.unread }, { customer: 0, vendor: 0, admin: 0 });
      assert.equal(conversation.vendor, null, "no vendor side");
      assert.ok(conversation.createdAt instanceof Date && conversation.updatedAt instanceof Date);
    });

    await t.test("a thread's sides must match its kind", async () => {
      const customer = await makeUser("customer");
      const vendor = await makeUser("vendor");

      // A customer thread carrying a vendor would show up in that vendor's list.
      await assert.rejects(
        () => thread({ ...customerAdmin(customer), vendor: vendor._id }),
        /no vendor side/,
      );
      // ...and one with no customer at all belongs to nobody.
      await assert.rejects(
        () =>
          thread({
            kind: "customer_admin",
            createdBy: customer._id,
            participants: [{ user: customer._id, role: "customer" }],
          }),
        /needs its customer/,
      );
      // A vendor thread needs its vendor as a participant, not just named.
      await assert.rejects(
        () =>
          thread({
            kind: "vendor_admin",
            vendor: vendor._id,
            createdBy: vendor._id,
            participants: [{ user: customer._id, role: "customer" }],
          }),
        /vendor must be a participant/,
      );
    });

    await t.test("a customer may only open a vendor thread about a booking", async () => {
      const customer = await makeUser("customer");
      const vendor = await makeUser("vendor");
      const station = await makeStation(vendor);

      await assert.rejects(
        () =>
          thread({
            kind: "customer_vendor",
            customer: customer._id,
            vendor: vendor._id,
            station: station._id,
            createdBy: customer._id,
            participants: [
              { user: customer._id, role: "customer" },
              { user: vendor._id, role: "vendor" },
            ],
          }),
        /only contact a vendor about a booking/,
        "without a booking there is no reason for the channel to exist",
      );

      const booking = await makeBooking(customer, station);
      const ok = await thread({
        kind: "customer_vendor",
        customer: customer._id,
        vendor: vendor._id,
        station: station._id,
        booking: booking._id,
        createdBy: customer._id,
        participants: [
          { user: customer._id, role: "customer" },
          { user: vendor._id, role: "vendor" },
        ],
      });
      assert.equal(String(ok.booking), String(booking._id));
    });

    await t.test("tapping Chat with Admin twice lands in the same thread", async () => {
      const customer = await makeUser("customer");
      await thread(customerAdmin(customer));

      await assert.rejects(
        () => thread(customerAdmin(customer)),
        (err) => err.code === 11000,
        "a second LIVE thread of the same kind is refused by uniq_live_thread",
      );

      // Once it is settled, they can start a new one.
      await Conversation.updateOne({ customer: customer._id }, { $set: { status: "resolved", closedAt: new Date() } });
      const second = await thread(customerAdmin(customer));
      assert.equal(second.status, "open");
    });

    await t.test("a message records who wrote it, in which role", async () => {
      const customer = await makeUser("customer");
      const conversation = await thread(customerAdmin(customer));
      const msg = await Message.create({
        conversation: conversation._id,
        sender: customer._id,
        senderRole: "customer",
        senderName: `${TAG} customer`,
        body: "My booking has not moved in the queue.",
      });
      made.messages.push(msg._id);

      assert.equal(msg.kind, "text");
      assert.deepEqual(msg.readBy.toObject?.() ?? msg.readBy, []);
      assert.ok(msg.createdAt instanceof Date);
      await assert.rejects(
        () => Message.create({ conversation: conversation._id, sender: customer._id, senderRole: "customer", body: "  " }),
        /body/,
        "an empty message is not a message",
      );
      await assert.rejects(
        () => Message.create({ conversation: conversation._id, sender: customer._id, senderRole: "nobody", body: "hi" }),
        /senderRole/,
      );
    });

    await t.test("a retried send is the same message, not a second one", async () => {
      const customer = await makeUser("customer");
      const conversation = await thread(customerAdmin(customer));
      const clientId = `c-${uniq()}`;
      const send = () =>
        Message.create({
          conversation: conversation._id,
          sender: customer._id,
          senderRole: "customer",
          body: "Sent once, retried after the connection dropped.",
          clientId,
        });

      const first = await send();
      made.messages.push(first._id);
      await assert.rejects(send, (err) => err.code === 11000);

      // The same client id in a DIFFERENT thread is a different message.
      const other = await thread({ ...customerAdmin(await makeUser("customer")) });
      const elsewhere = await Message.create({
        conversation: other._id,
        sender: other.customer,
        senderRole: "customer",
        body: "Different thread, same id.",
        clientId,
      });
      made.messages.push(elsewhere._id);
      assert.equal(await Message.countDocuments({ clientId }), 2);
    });

    await t.test("server-written messages without a client id never collide", async () => {
      const customer = await makeUser("customer");
      const conversation = await thread(customerAdmin(customer));
      const system = async (body) => {
        const m = await Message.create({
          conversation: conversation._id,
          sender: customer._id,
          senderRole: "admin",
          kind: "system",
          body,
        });
        made.messages.push(m._id);
        return m;
      };
      await system("Marked pending by the admin team.");
      await system("Marked resolved by the admin team.");
      assert.equal(await Message.countDocuments({ conversation: conversation._id, kind: "system" }), 2);
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
