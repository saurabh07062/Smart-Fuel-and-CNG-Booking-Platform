/**
 * DELETE /api/v1/admin/orders/:bookingId -- an admin removes a finished order.
 *
 * Finished orders (completed, cancelled, expired, no-show) are deleted with
 * their notifications; orders still in progress are refused and kept; only
 * admins may delete; other orders are untouched.
 *
 * DEVELOPMENT TEST DATA, test database only: tagged users, a station and its
 * bookings, removed at the end.
 *
 *   node --test test/adminOrderDelete.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const testDb = require("./helpers/testDb");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("admin order delete against MongoDB", async (t) => {
  const MONGO = testDb.uri();
  testDb.isolateRedis();
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
  const Notification = require("../src/models/Notification");
  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const tag = `orderdel-${Date.now()}`;
  const tokenFor = (id) =>
    jwt.sign({ user: { id: String(id) } }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "30m" });
  const mkUser = (suffix, role, extra = {}) =>
    User.create({ name: `${tag}-${suffix}`, email: `${tag}-${suffix}@example.com`, password: "unused", role, isVerified: true, ...extra });

  const admin = await mkUser("admin", "admin");
  const customer = await mkUser("customer", "customer");
  const vendor = await mkUser("vendor", "vendor", { vendorStatus: "active", activated: true });
  const station = await Station.create({ name: `${tag}-station`, address: "Order Road", owner: vendor._id });
  const extraUsers = [];

  /** A booking written raw with just what these checks need. */
  const booking = async (status, extra = {}) => {
    const _id = new mongoose.Types.ObjectId();
    await Booking.collection.insertOne({
      _id,
      user: customer._id,
      station: station._id,
      status,
      fuelType: "Petrol",
      quantity: 1,
      amount: 105,
      paymentStatus: status === "completed" ? "paid" : "due_at_station",
      createdAt: new Date(),
      ...extra,
    });
    return _id;
  };
  const del = (id, token = tokenFor(admin._id)) =>
    fetch(`${base}/api/v1/admin/orders/${id}`, { method: "DELETE", headers: { "x-auth-token": token } }).then(async (r) => ({
      status: r.status,
      body: await r.json().catch(() => ({})),
    }));

  try {
    await t.test("a completed order is deleted with its notifications; other orders stay", async () => {
      const done = await booking("completed");
      const other = await booking("completed");
      await Notification.collection.insertOne({ user: customer._id, type: "booking_completed", title: "done", booking: done, dedupeKey: `${tag}:${done}`, createdAt: new Date() });

      const r = await del(done);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await Booking.countDocuments({ _id: done }), 0);
      assert.equal(await Notification.countDocuments({ booking: done }), 0);
      assert.equal(await Booking.countDocuments({ _id: other }), 1, "another order was removed");
    });

    await t.test("cancelled, expired and no-show orders can be deleted too", async () => {
      for (const status of ["cancelled", "expired", "no_show"]) {
        const id = await booking(status);
        const r = await del(id);
        assert.equal(r.status, 200, `${status}: ${JSON.stringify(r.body)}`);
        assert.equal(await Booking.countDocuments({ _id: id }), 0, status);
      }
    });

    await t.test("an order still in progress is refused and kept", async () => {
      for (const status of ["upcoming", "waitlisted", "serving"]) {
        // One active booking per customer is enforced by a unique index.
        const holder = await mkUser(`active-${status}`, "customer");
        extraUsers.push(holder._id);
        const id = await booking(status, { user: holder._id });
        const r = await del(id);
        assert.equal(r.status, 409, `${status}: ${JSON.stringify(r.body)}`);
        assert.match(r.body.msg, new RegExp(`This order is ${status}`));
        assert.equal(await Booking.countDocuments({ _id: id }), 1, `${status} order was deleted`);
      }
    });

    await t.test("only an admin can delete, and nothing is removed otherwise", async () => {
      const id = await booking("completed");
      for (const token of [tokenFor(customer._id), tokenFor(vendor._id)]) {
        const r = await del(id, token);
        assert.ok([401, 403].includes(r.status), `expected refusal, got ${r.status}`);
      }
      const anon = await fetch(`${base}/api/v1/admin/orders/${id}`, { method: "DELETE" });
      assert.ok([401, 403].includes(anon.status));
      assert.equal(await Booking.countDocuments({ _id: id }), 1);
    });

    await t.test("an unknown or malformed id is answered, not a server error", async () => {
      assert.equal((await del(new mongoose.Types.ObjectId())).status, 404);
      assert.equal((await del("not-an-id")).status, 400);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const ids = (await Booking.find({ station: station._id }).select("_id").lean()).map((b) => b._id);
    await Notification.deleteMany({ booking: { $in: ids } });
    await Booking.deleteMany({ station: station._id });
    await Station.deleteOne({ _id: station._id });
    await User.deleteMany({ _id: { $in: [admin._id, customer._id, vendor._id, ...extraUsers] } });
    await mongoose.disconnect();
  }
});
