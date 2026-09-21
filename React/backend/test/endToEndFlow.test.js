/**
 * The whole real flow, through the HTTP API and sockets, on the TEST database:
 *
 *   vendor registers -> admin approves -> vendor redeems the secret code
 *   -> vendor creates a station -> customer finds it nearby -> books a slot
 *   -> vendor checks the customer in with the PIN (fueling starts)
 *   -> fueling completes on its own -> stock deducted, queue refreshed
 *
 * with the isolation rules checked along the way (pending / unactivated
 * vendors, another vendor, another customer, a customer at the vendor API)
 * and booking-conflict prevention on the same slot.
 *
 * Needs the API running on the test database:
 *   npm run test:server        then        node --test test/endToEndFlow.test.js
 * Before writing anything it proves the API it is talking to uses the same
 * (test) database as this process, and stops otherwise.
 *
 * The secret code is normally only ever emailed. The test issues a fresh one
 * with the same service the admin "reissue" button uses and redeems that --
 * standing in for reading the email, not bypassing the check.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const testDb = require("./helpers/testDb");
const API = testDb.apiUrl();
const MONGO = testDb.uri();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, token, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "x-auth-token": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test("real flow: vendor -> station -> customer -> check-in -> completion", { timeout: 180_000 }, async (t) => {
  const reachable = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    t.skip(`Test API not reachable at ${API} -- run "npm run test:server" first`);
    return;
  }

  const mongoose = require("mongoose");
  const jwt = require("jsonwebtoken");
  await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });

  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const BookingAttempt = require("../src/models/BookingAttempt");
  const InventoryMovement = require("../src/models/InventoryMovement");
  const Notification = require("../src/models/Notification");
  const secretCode = require("../src/services/vendor/vendorSecretCode");
  const { dateKey } = require("../src/config/businessTime");

  const tag = `e2e-${Date.now()}`;
  const tokenFor = (id) => jwt.sign({ user: { id: String(id) } }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const created = { users: [], stations: [] };
  const sockets = [];

  try {
    // ---- the API must be on the same database as this process ---------------
    const probe = await Station.create({ name: `${tag}-probe`, address: "Probe", status: "Inactive" });
    created.stations.push(probe._id);
    const seen = await call("GET", `/api/stations/${probe._id}`);
    if (seen.status !== 200) {
      assert.fail(
        `The API at ${API} is not using the test database (${testDb.dbNameOf(MONGO)}). Start it with "npm run test:server". Nothing else was written.`,
      );
    }

    const admin = await User.create({ name: `${tag}-admin`, email: `${tag}-admin@fuelmart.test`, password: "x", role: "admin" });
    const otherVendor = await User.create({
      name: `${tag}-other-vendor`,
      email: `${tag}-other@fuelmart.test`,
      password: "x",
      role: "vendor",
      vendorStatus: "active",
      activated: true,
    });
    const customer = await User.create({ name: `${tag}-customer`, email: `${tag}-c@fuelmart.test`, password: "x", role: "customer", isVerified: true });
    const otherCustomer = await User.create({ name: `${tag}-customer2`, email: `${tag}-c2@fuelmart.test`, password: "x", role: "customer", isVerified: true });
    created.users.push(admin._id, otherVendor._id, customer._id, otherCustomer._id);

    const vendorEmail = `${tag}-vendor@fuelmart.test`;
    let vendorId;
    let vendorToken;
    let stationId;
    let booking;

    await t.test("vendor registers and is held until approved", async () => {
      const r = await call("POST", "/api/vendors/register", null, {
        name: `${tag}-vendor`,
        email: vendorEmail,
        password: "Vendor@12345",
        businessName: `${tag} Fuels`,
        phone: "9000000000",
        vendorAddress: "E2E Road, Pune",
        products: "petrol,diesel,cng",
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.user.vendorStatus, "pending");
      vendorId = r.body.user.id;
      created.users.push(vendorId);

      assert.equal(r.body.token, undefined, "registration does not sign a pending vendor in");
      const blocked = await call("GET", "/api/vendor-panel/stations", tokenFor(vendorId));
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.reason, "NOT_APPROVED");
    });

    await t.test("admin approves; the panel stays closed until the secret code is redeemed", async () => {
      assert.equal((await call("PATCH", `/api/vendors/${vendorId}/approve`, tokenFor(customer._id))).status, 403, "a customer cannot approve");
      const r = await call("PATCH", `/api/vendors/${vendorId}/approve`, tokenFor(admin._id));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.vendor.vendorStatus, "active");
      assert.equal(r.body.code, undefined, "the code is never in a response");

      const notYet = await call("GET", "/api/vendor-panel/stations", tokenFor(vendorId));
      assert.equal(notYet.status, 403);
      assert.equal(notYet.body.reason, "NOT_ACTIVATED");

      // Stand-in for the approval email (see header).
      const vendor = await User.findById(vendorId).select("+secretCodeHash");
      const { code } = await secretCode.issueSecretCode(vendor);
      await vendor.save();

      assert.equal((await call("POST", "/api/vendor-access/verify", null, { email: vendorEmail, code: "WRONGCODE1" })).status, 400);
      const redeemed = await call("POST", "/api/vendor-access/verify", null, { email: vendorEmail, code });
      assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
      // The session itself is an httpOnly cookie (covered in vendorSecretCode.test.js);
      // from here on this flow authenticates as the now-activated vendor by header.
      assert.equal(redeemed.body.token, undefined, "no token in the body");
      vendorToken = tokenFor(vendorId);
      assert.equal((await call("GET", "/api/vendor-panel/stations", vendorToken)).status, 200);
    });

    await t.test("the activated vendor creates a station with real details only", async () => {
      const r = await call("POST", "/api/vendor-panel/stations", vendorToken, {
        name: `${tag}-station`,
        address: "E2E Road, Pune",
        fuelTypes: ["Petrol", "CNG"],
        prices: { petrol: 101.5, cng: 88 },
        inventory: { petrol: 5000, cng: 400 },
        tankCapacity: { petrol: 10000, cng: 1000 },
        coordinates: { lat: 18.61, lng: 73.71 },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      stationId = r.body._id;
      created.stations.push(stationId);
      assert.equal(String(r.body.owner), String(vendorId));
      assert.equal(r.body.prices.diesel, null, "an unpriced fuel stays unpriced");

      const opening = await InventoryMovement.countDocuments({ station: stationId, type: "stock_count" });
      assert.ok(opening >= 1, "the opening stock is the first line of the stock history");
    });

    await t.test("another vendor and a customer cannot reach this station's vendor data", async () => {
      assert.equal((await call("GET", `/api/vendor-panel/stations/${stationId}/bookings`, tokenFor(otherVendor._id))).status, 404);
      assert.equal(
        (await call("PUT", `/api/vendor-panel/stations/${stationId}/price`, tokenFor(otherVendor._id), { fuelType: "Petrol", newPrice: 1 })).status,
        404,
      );
      assert.equal((await call("GET", "/api/vendor-panel/stations", tokenFor(customer._id))).status, 403);
      const mine = await call("GET", "/api/vendor-panel/stations", tokenFor(otherVendor._id));
      assert.ok(!mine.body.some((s) => String(s._id) === String(stationId)), "not in another vendor's list");
    });

    let slot = null;
    await t.test("the customer finds the station nearby, bookable, with a real free slot", async () => {
      const r = await call("GET", "/api/stations/nearby?latitude=18.605&longitude=73.705&fuelType=PETROL&radius=5&quantity=10", tokenFor(customer._id));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const found = r.body.stations.find((s) => String(s.stationId) === String(stationId));
      assert.ok(found, "the new station is in the results");
      assert.ok(found.distance > 0 && found.distance < 2);
      assert.equal(found._fuelPriceForDisplay, 101.5);
      if (found.canBook) {
        slot = found.preferredSlot.slot;
      } else {
        assert.equal(found.unavailableCode, "NO_SLOT_TODAY", JSON.stringify(found));
      }
    });

    if (!slot) {
      t.diagnostic("No bookable slot left today (India time), so booking, check-in and completion were not exercised in this run.");
      return;
    }

    await t.test("the customer books; stock is reserved; the next customer gets the next position, never the same one", async () => {
      const body = { stationId, fuelType: "Petrol", quantity: 10, bookingDate: dateKey(), timeSlot: slot, payMethod: "station" };
      const r = await call("POST", "/api/bookings", tokenFor(customer._id), body);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      booking = r.body.booking;
      assert.equal(booking.status, "upcoming");
      assert.equal(booking.price, 101.5, "priced by the server");
      assert.match(booking.verificationCode, /^\d{4}$/);

      const s = await Station.findById(stationId).lean();
      assert.equal(s.inventoryCommitted.petrol, 10);

      // The window holds 45 Petrol fills: a second customer is placed back to
      // back on the nozzle, starting when the first one's fill ends.
      const second = await call("POST", "/api/bookings", tokenFor(otherCustomer._id), body);
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(new Date(second.body.booking.bookingStartTime).getTime(), new Date(booking.bookingEndTime).getTime());
      // Taken back out, so the rest of the flow follows one customer.
      const out = await call("PATCH", `/api/bookings/${second.body.booking._id}/cancel`, tokenFor(otherCustomer._id));
      assert.equal(out.status, 200, JSON.stringify(out.body));
    });

    await t.test("customers see only their own bookings; only the owning vendor can check in", async () => {
      assert.equal((await call("GET", `/api/bookings/${booking._id}`, tokenFor(otherCustomer._id))).status, 404);
      assert.equal((await call("GET", `/api/bookings/${booking._id}`, tokenFor(customer._id))).status, 200);
      const theirs = await call("GET", "/api/bookings", tokenFor(otherCustomer._id));
      assert.ok(!theirs.body.some((b) => String(b._id) === String(booking._id)));

      assert.equal((await call("POST", "/api/bookings/verify", tokenFor(customer._id), { verificationCode: booking.verificationCode })).status, 403);
      assert.equal((await call("POST", "/api/bookings/verify", tokenFor(otherVendor._id), { verificationCode: booking.verificationCode })).status, 404);

      const list = await call("GET", `/api/vendor-panel/stations/${stationId}/bookings`, vendorToken);
      assert.ok(list.body.some((b) => String(b._id) === String(booking._id)), "the owning vendor sees it");
    });

    await t.test("PIN check-in starts fueling; it completes on its own; stock and queue follow; the customer hears it live", async () => {
      let events = [];
      try {
        const { io } = require("socket.io-client");
        const sock = io(API, { auth: { token: tokenFor(customer._id) }, reconnection: false, transports: ["websocket"] });
        sockets.push(sock);
        await new Promise((resolve, reject) => {
          sock.on("connect", resolve);
          sock.on("connect_error", reject);
          setTimeout(() => reject(new Error("socket timeout")), 5000);
        });
        sock.onAny((event, payload) => events.push({ event, payload }));
      } catch (err) {
        t.diagnostic(`socket not connected (${err.message}); live-event checks skipped`);
        events = null;
      }

      const r = await call("POST", "/api/bookings/verify", vendorToken, { verificationCode: booking.verificationCode });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.booking.status, "serving");
      assert.ok(r.body.booking.arrivalTime && r.body.booking.fuelingStartTime);
      assert.ok(new Date(r.body.completesAt) > new Date(r.body.booking.fuelingStartTime));

      const twice = await call("POST", "/api/bookings/verify", vendorToken, { verificationCode: booking.verificationCode });
      assert.equal(twice.status, 409);

      const queue = await call("GET", `/api/v1/discovery/stations/${stationId}/eta`);
      assert.equal(queue.status, 200);
      assert.equal(queue.body.queueLength, 1, "the car being fueled is in the line");

      assert.equal((await Station.findById(stationId).lean()).inventory.petrol, 5000, "nothing leaves the tank before fueling completes");

      // Petrol takes 40 s; the in-progress sweep runs every 5 s.
      let current = null;
      for (let i = 0; i < 30; i++) {
        await sleep(3000);
        current = (await call("GET", `/api/bookings/${booking._id}`, tokenFor(customer._id))).body;
        if (current.status === "completed") break;
      }
      assert.equal(current.status, "completed", "fueling completed on its own");

      const s = await Station.findById(stationId).lean();
      assert.equal(s.inventory.petrol, 4990, "the booked 10 L left the tank");
      assert.equal(s.inventoryCommitted.petrol, 0, "and are no longer held for the booking");
      assert.equal(await InventoryMovement.countDocuments({ booking: booking._id, type: "sale" }), 1);

      const after = await call("GET", `/api/v1/discovery/stations/${stationId}/eta`);
      assert.equal(after.body.queueLength, 0, "the line is clear");

      if (events) {
        const statuses = events
          .filter((e) => /^booking/.test(e.event) && String(e.payload?._id || e.payload?.bookingId) === String(booking._id))
          .map((e) => e.payload.status)
          .filter(Boolean);
        assert.ok(statuses.includes("serving"), `customer heard check-in live: ${JSON.stringify(statuses)}`);
        assert.ok(statuses.includes("completed"), `customer heard completion live: ${JSON.stringify(statuses)}`);
        assert.ok(
          events.some((e) => e.event === "notification:created" && /complete/i.test(e.payload?.title || "")),
          "a completion notification arrived",
        );
      }
    });
  } finally {
    sockets.forEach((s) => s.close());
    const stationIds = created.stations;
    await Booking.deleteMany({ $or: [{ station: { $in: stationIds } }, { user: { $in: created.users } }] });
    await BookingAttempt.deleteMany({ user: { $in: created.users } });
    await InventoryMovement.deleteMany({ station: { $in: stationIds } });
    await Notification.deleteMany({ user: { $in: created.users } });
    await Station.deleteMany({ _id: { $in: stationIds } });
    await User.deleteMany({ $or: [{ _id: { $in: created.users } }, { email: new RegExp(`^${tag}`) }] });
    await mongoose.disconnect();
  }
});
