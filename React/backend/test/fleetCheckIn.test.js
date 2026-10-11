/**
 * One PIN for a whole fleet.
 *
 * A fleet booking's vehicles share a single four-digit code, and typing it
 * once checks the whole group in. What these tests hold:
 *
 *   - every member carries the SAME code, and the group reports it once
 *   - one tap of "Check In at Petrol Pump" checks in every van of the group
 *     (they arrived together), and nobody else's booking
 *   - the attendant's one entry starts the first van and records the rest as
 *     waiting -- it does not pretend five nozzles exist
 *   - the code still only works after arrival, still only at that station,
 *     still only today: sharing it weakens none of those
 *   - two unrelated bookings that happen to share four digits are still
 *     refused as ambiguous
 *   - a single-vehicle booking's own PIN behaves exactly as before
 *
 * DEVELOPMENT TEST DATA: users, stations and bookings tagged "[fleet-pin]" in
 * the test database only, all removed at the end.
 *
 *   node --test test/fleetCheckIn.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const TAG = "[fleet-pin]";

// The real rules, whatever the developer's .env says about demo mode.
process.env.CHECKIN_DEMO_MODE = "false";

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("one PIN for a fleet, against MongoDB", async (t) => {
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

  const { User, Station, Booking, FleetBooking } = require("../src/models");
  await require("../src/services/core/schemaIndexes").ensureSchemaIndexes();

  const { dateKey, clockParts } = require("../src/config/businessTime");
  const { BOOKABLE_SLOT_LABELS } = require("../src/config/booking");

  const tokenFor = (id) => jwt.sign({ user: { id: String(id) } }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "30m" });
  const call = async (method, route, token, body) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { "x-auth-token": token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const made = { users: [], stations: [], bookings: [], groups: [] };
  const uniq = () => Math.random().toString(36).slice(2, 10);

  const makeUser = async (role = "customer") => {
    const doc = await User.create({
      name: `${TAG} ${role}`,
      email: `pin.${uniq()}@example.com`,
      password: "x".repeat(60),
      role,
      isVerified: true,
      ...(role === "vendor" ? { vendorStatus: "active", activated: true } : {}),
    });
    made.users.push(doc._id);
    return doc;
  };

  // The station, its owner, and the customer's position at the pump.
  const PUMP = { lat: 18.5805621, lng: 73.9753407 };
  const vendor = await makeUser("vendor");
  const admin = await makeUser("admin");

  const makeStation = async ({ nozzles = 1 } = {}) => {
    const doc = await Station.create({
      name: `${TAG} Depot ${uniq()}`,
      address: `${TAG} Road`,
      owner: vendor._id,
      status: "Active",
      fuelTypes: ["Petrol"],
      prices: { petrol: 100 },
      inventory: { petrol: 9000 },
      nozzleConfig: { petrol: { total: nozzles, online: nozzles } },
      coordinates: PUMP,
      location: { type: "Point", coordinates: [PUMP.lng, PUMP.lat] },
    });
    made.stations.push(doc._id);
    return doc;
  };

  const TODAY = dateKey();
  /** The slot running now, so check-in is open. */
  const nowLabel = (() => {
    const at = clockParts(new Date());
    return BOOKABLE_SLOT_LABELS[at.hours * 2 + (at.minutes >= 30 ? 1 : 0)];
  })();

  /** Book `n` vehicles as one fleet, for today's current slot. */
  const bookFleet = async (customer, station, n = 3) => {
    const vehicles = Array.from({ length: n }, (_, i) => ({
      vehiclePlate: `MH12PN${uniq().slice(0, 2).toUpperCase()}${i}`,
      quantity: 10,
      timeSlot: nowLabel,
    }));
    const r = await call("POST", "/api/bookings/fleet", tokenFor(customer._id), {
      stationId: String(station._id),
      fuelType: "Petrol",
      bookingDate: TODAY,
      payMethod: "station",
      vehicles,
    });
    for (const b of r.body.bookings || []) made.bookings.push(b.bookingId);
    if (r.body.group?.fleetId) made.groups.push(r.body.group.fleetId);
    return r;
  };

  try {
    await t.test("every vehicle of a group carries the same code, and the group shows it once", async () => {
      const customer = await makeUser();
      const station = await makeStation({ nozzles: 2 });
      const r = await bookFleet(customer, station, 3);
      assert.ok([201, 207].includes(r.status), JSON.stringify(r.body));

      const codes = new Set(r.body.bookings.map((b) => b.verificationCode));
      assert.equal(codes.size, 1, "one code across the group");
      assert.match([...codes][0], /^\d{4}$/);

      // The group's own read reports it once, for the customer to show.
      const group = await call("GET", `/api/bookings/fleet/${r.body.group.fleetId}`, tokenFor(customer._id));
      assert.equal(group.body.pin, [...codes][0]);

      // Order ids and QR codes stay per vehicle: only the PIN is shared.
      assert.equal(new Set(r.body.bookings.map((b) => b.orderId)).size, 3);
      assert.equal(new Set(r.body.bookings.map((b) => b.qrCodeData)).size, 3);
    });

    await t.test("one tap checks the whole group in, and nobody else", async () => {
      const customer = await makeUser();
      const other = await makeUser();
      const station = await makeStation({ nozzles: 2 });
      const mine = await bookFleet(customer, station, 3);
      const theirs = await bookFleet(other, station, 2);

      const first = mine.body.bookings[0];
      const tap = await call("POST", `/api/bookings/${first.bookingId}/station-check-in`, tokenFor(customer._id), {
        latitude: PUMP.lat,
        longitude: PUMP.lng,
      });
      assert.equal(tap.status, 200, JSON.stringify(tap.body));

      const mineRows = await Booking.find({ _id: { $in: mine.body.bookings.map((b) => b.bookingId) } }).lean();
      assert.ok(mineRows.every((b) => b.stationCheckInAt), "every van of the group is checked in");

      const theirRows = await Booking.find({ _id: { $in: theirs.body.bookings.map((b) => b.bookingId) } }).lean();
      assert.ok(theirRows.every((b) => !b.stationCheckInAt), "another customer's fleet is untouched");
    });

    await t.test("the attendant types it once: the first van fuels, the rest wait", async () => {
      const customer = await makeUser();
      const station = await makeStation({ nozzles: 1 });
      const fleet = await bookFleet(customer, station, 3);
      const code = fleet.body.bookings[0].verificationCode;

      await call("POST", `/api/bookings/${fleet.body.bookings[0].bookingId}/station-check-in`, tokenFor(customer._id), {
        latitude: PUMP.lat,
        longitude: PUMP.lng,
      });

      const verified = await call("POST", "/api/bookings/verify", tokenFor(vendor._id), { verificationCode: code });
      assert.equal(verified.status, 200, JSON.stringify(verified.body));
      assert.equal(verified.body.fleet, true);
      assert.equal(verified.body.vehicles.started.length, 1, "one nozzle, so one van starts");
      assert.equal(verified.body.vehicles.queued.length, 2, "the rest are waiting at the pump");
      assert.match(verified.body.msg, /fuelling now|is fuelling/);
      assert.match(verified.body.msg, /waiting at the pump/);

      // The database agrees: exactly one serving, and the others have arrived.
      const rows = await Booking.find({ fleetGroup: fleet.body.group.fleetId }).lean();
      assert.equal(rows.filter((b) => b.status === "serving").length, 1);
      assert.equal(rows.filter((b) => b.status === "upcoming" && b.arrivalTime).length, 2);

      // The vans start in the order they were booked.
      const serving = rows.find((b) => b.status === "serving");
      assert.equal(serving.fleetIndex, 1);
    });

    await t.test("two free nozzles: two vans start together, the third waits", async () => {
      const customer = await makeUser();
      const station = await makeStation({ nozzles: 2 });
      const fleet = await bookFleet(customer, station, 3);

      await call("POST", `/api/bookings/${fleet.body.bookings[0].bookingId}/station-check-in`, tokenFor(customer._id), {
        latitude: PUMP.lat,
        longitude: PUMP.lng,
      });
      const verified = await call("POST", "/api/bookings/verify", tokenFor(vendor._id), {
        verificationCode: fleet.body.bookings[0].verificationCode,
      });

      assert.equal(verified.status, 200, JSON.stringify(verified.body));
      // How many start is the nozzles' answer, not this feature's.
      const rows = await Booking.find({ fleetGroup: fleet.body.group.fleetId }).lean();
      assert.equal(rows.filter((b) => b.status === "serving").length, verified.body.vehicles.started.length);
      assert.ok(verified.body.vehicles.started.length >= 1);
      assert.equal(verified.body.vehicles.started.length + verified.body.vehicles.queued.length, 3);
    });

    await t.test("the shared code still does nothing until the customer is at the pump", async () => {
      const customer = await makeUser();
      const station = await makeStation({ nozzles: 2 });
      const fleet = await bookFleet(customer, station, 2);

      const early = await call("POST", "/api/bookings/verify", tokenFor(vendor._id), {
        verificationCode: fleet.body.bookings[0].verificationCode,
      });
      assert.equal(early.status, 409, JSON.stringify(early.body));
      assert.equal(early.body.reason, "NOT_CHECKED_IN");

      const rows = await Booking.find({ fleetGroup: fleet.body.group.fleetId }).lean();
      assert.ok(rows.every((b) => b.status === "upcoming" && !b.arrivalTime), "nothing started");
    });

    await t.test("an admin can still override for a customer whose app cannot check in", async () => {
      const customer = await makeUser();
      const station = await makeStation({ nozzles: 1 });
      const fleet = await bookFleet(customer, station, 2);

      const forced = await call("POST", "/api/bookings/verify", tokenFor(admin._id), {
        verificationCode: fleet.body.bookings[0].verificationCode,
        override: true,
      });
      assert.equal(forced.status, 200, JSON.stringify(forced.body));
      assert.equal(forced.body.vehicles.started.length, 1);
    });

    await t.test("another station's attendant cannot use the code", async () => {
      const customer = await makeUser();
      const station = await makeStation({ nozzles: 2 });
      const fleet = await bookFleet(customer, station, 2);
      await call("POST", `/api/bookings/${fleet.body.bookings[0].bookingId}/station-check-in`, tokenFor(customer._id), {
        latitude: PUMP.lat,
        longitude: PUMP.lng,
      });

      const stranger = await makeUser("vendor");
      const r = await call("POST", "/api/bookings/verify", tokenFor(stranger._id), {
        verificationCode: fleet.body.bookings[0].verificationCode,
      });
      assert.equal(r.status, 404, "not at your station");
      assert.equal((await Booking.countDocuments({ fleetGroup: fleet.body.group.fleetId, status: "serving" })), 0);
    });

    await t.test("two unrelated bookings sharing four digits are still refused as ambiguous", async () => {
      const station = await makeStation({ nozzles: 3 });
      const a = await makeUser();
      const b = await makeUser();

      const code = "3737";
      const rows = [];
      for (const user of [a, b]) {
        const doc = await Booking.create({
          user: user._id,
          station: station._id,
          fuelType: "Petrol",
          quantity: 10,
          price: 100,
          amount: 1005,
          bookingDate: TODAY,
          timeSlot: nowLabel,
          status: "upcoming",
          verificationCode: code,
          orderId: `FM-2099-${uniq().toUpperCase()}`,
          stationCheckInAt: new Date(),
          vehiclePlate: `MH12AM${uniq().slice(0, 4).toUpperCase()}`,
        });
        made.bookings.push(doc._id);
        rows.push(doc);
      }

      const r = await call("POST", "/api/bookings/verify", tokenFor(vendor._id), { verificationCode: code });
      assert.equal(r.status, 409);
      assert.match(r.body.msg, /More than one booking/);
      assert.equal(await Booking.countDocuments({ _id: { $in: rows.map((x) => x._id) }, status: "serving" }), 0);
    });

    await t.test("a single-vehicle booking's own PIN works exactly as before", async () => {
      const customer = await makeUser();
      const station = await makeStation({ nozzles: 1 });

      const one = await call("POST", "/api/bookings", tokenFor(customer._id), {
        stationId: String(station._id),
        fuelType: "Petrol",
        quantity: 10,
        bookingDate: TODAY,
        timeSlot: nowLabel,
        payMethod: "station",
        vehiclePlate: `MH12SOLO${uniq().slice(0, 2).toUpperCase()}`,
      });
      assert.equal(one.status, 200, JSON.stringify(one.body));
      const booking = one.body.booking;
      made.bookings.push(booking._id);
      assert.equal(booking.fleetGroup ?? null, null);

      await call("POST", `/api/bookings/${booking._id}/station-check-in`, tokenFor(customer._id), {
        latitude: PUMP.lat,
        longitude: PUMP.lng,
      });
      const verified = await call("POST", "/api/bookings/verify", tokenFor(vendor._id), {
        verificationCode: booking.verificationCode,
      });
      assert.equal(verified.status, 200, JSON.stringify(verified.body));
      assert.equal(verified.body.started, true);
      assert.equal(verified.body.fleet, undefined, "not a group answer");
    });
  } finally {
    await Promise.all([
      Booking.deleteMany({ station: { $in: made.stations } }),
      FleetBooking.deleteMany({ user: { $in: made.users } }),
      Station.deleteMany({ _id: { $in: made.stations } }),
      User.deleteMany({ _id: { $in: made.users } }),
      require("../src/models/Notification").deleteMany({ user: { $in: made.users } }),
    ]);
    server.close();
    await mongoose.disconnect();
  }
});
