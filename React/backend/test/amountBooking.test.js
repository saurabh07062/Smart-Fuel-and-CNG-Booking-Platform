/**
 * Booking by money: "₹1000 of petrol".
 *
 * The quantity is worked out by the SERVER from the station's own published
 * price, and everything downstream -- what is charged, what is reserved from
 * the tank, what the receipt says -- follows that quantity. These tests hold
 * the parts that would be easy to get subtly wrong:
 *
 *   - the client's own arithmetic is never trusted; a quantity sent alongside
 *     an amount is refused rather than quietly preferred
 *   - the price used is the one in the database at the moment of booking, not
 *     the one the customer was shown
 *   - the money buying too little or too much fuel is refused in rupees, the
 *     units the customer typed in
 *   - stock is reserved for the DERIVED quantity
 *   - the quantity-based flow is untouched
 *
 * DEVELOPMENT TEST DATA: users, stations and bookings tagged "[amount-book]"
 * in the test database only, all removed at the end.
 *
 *   node --test test/amountBooking.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const TAG = "[amount-book]";

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("amount-based booking against MongoDB", async (t) => {
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
  const { dateKey } = require("../src/config/businessTime");

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

  const makeUser = async () => {
    const doc = await User.create({
      name: `${TAG} Customer`,
      email: `amount.${uniq()}@example.com`,
      password: "x".repeat(60),
      isVerified: true,
    });
    made.users.push(doc._id);
    return doc;
  };

  /** A station at a known price, so the arithmetic is checkable by hand. */
  const makeStation = async ({ price = 100, stock = 5000 } = {}) => {
    const doc = await Station.create({
      name: `${TAG} Pump ${uniq()}`,
      address: `${TAG} Road`,
      status: "Active",
      fuelTypes: ["Petrol"],
      prices: { petrol: price },
      inventory: { petrol: stock },
      nozzleConfig: { petrol: { total: 2, online: 2 } },
    });
    made.stations.push(doc._id);
    return doc;
  };

  /** Tomorrow in India, so every slot of the day is bookable. */
  const TOMORROW = (() => {
    const [y, m, d] = dateKey().split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  })();

  const book = async (token, station, body) =>
    call("POST", "/api/bookings", token, {
      stationId: String(station._id),
      fuelType: "Petrol",
      bookingDate: TOMORROW,
      timeSlot: "11:00 AM",
      payMethod: "station",
      vehiclePlate: `MH12AM${uniq().slice(0, 4).toUpperCase()}`,
      ...body,
    });

  try {
    await t.test("₹1000 at ₹100 a litre books 10 litres", async () => {
      const user = await makeUser();
      const station = await makeStation({ price: 100 });

      const r = await book(tokenFor(user._id), station, { fuelAmount: 1000 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const booking = r.body.booking;
      made.bookings.push(booking._id);

      assert.equal(booking.quantity, 10, "the server did the division");
      assert.equal(booking.bookedBy, "amount");
      assert.equal(booking.requestedAmount, 1000);
      assert.equal(booking.price, 100);
      // Charged like any other booking: fuel value plus the same flat fee.
      assert.equal(booking.amount, 1005);

      // The tank is reserved for the DERIVED quantity.
      const after = await Station.findById(station._id).select("inventoryCommitted").lean();
      assert.equal(after.inventoryCommitted.petrol, 10);
    });

    await t.test("a price that is not a round number gives a two-decimal quantity", async () => {
      const user = await makeUser();
      const station = await makeStation({ price: 104.5 });

      const r = await book(tokenFor(user._id), station, { fuelAmount: 1000 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      made.bookings.push(r.body.booking._id);

      // 1000 / 104.5 = 9.5693… -> 9.57 L, and the charge follows THAT figure
      // rather than the round sum the customer typed.
      assert.equal(r.body.booking.quantity, 9.57);
      assert.equal(r.body.booking.amount, 1005.07); // 9.57 x 104.5 + 5
      assert.equal(r.body.booking.requestedAmount, 1000);
    });

    await t.test("the client's own arithmetic is never used", async () => {
      const user = await makeUser();
      const station = await makeStation({ price: 100 });

      // Both given: refused rather than one silently preferred.
      const both = await book(tokenFor(user._id), station, { fuelAmount: 1000, quantity: 50 });
      assert.equal(both.status, 400);
      assert.equal(both.body.reason, "AMBIGUOUS_QUANTITY");

      // Neither given.
      const neither = await book(tokenFor(user._id), station, {});
      assert.equal(neither.status, 400);
      assert.equal(neither.body.reason, "QUANTITY_REQUIRED");
    });

    await t.test("the price used is the one in the database now, not the one shown", async () => {
      const user = await makeUser();
      const station = await makeStation({ price: 100 });

      // The vendor raises the price while the customer is deciding.
      await Station.updateOne({ _id: station._id }, { $set: { "prices.petrol": 125 } });

      const r = await book(tokenFor(user._id), station, { fuelAmount: 1000 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      made.bookings.push(r.body.booking._id);
      assert.equal(r.body.booking.price, 125, "the new price");
      assert.equal(r.body.booking.quantity, 8, "1000 / 125, not 1000 / 100");
    });

    await t.test("money that buys too little or too much fuel is refused in rupees", async () => {
      const user = await makeUser();
      const station = await makeStation({ price: 104.5 });

      const tooSmall = await book(tokenFor(user._id), station, { fuelAmount: 50 });
      assert.equal(tooSmall.status, 400);
      assert.equal(tooSmall.body.reason, "AMOUNT_TOO_SMALL");
      assert.match(tooSmall.body.msg, /₹50 buys only 0.48 L/);
      assert.match(tooSmall.body.msg, /about ₹105/, "says what the minimum costs");

      const tooBig = await book(tokenFor(user._id), station, { fuelAmount: 99999 });
      assert.equal(tooBig.status, 400);
      assert.equal(tooBig.body.reason, "AMOUNT_TOO_LARGE");
      assert.match(tooBig.body.msg, /60 L limit/);

      const junk = await book(tokenFor(user._id), station, { fuelAmount: -20 });
      assert.equal(junk.status, 400);
      assert.equal(junk.body.reason, "INVALID_AMOUNT");

      assert.equal(await Booking.countDocuments({ station: station._id }), 0, "nothing was booked");
    });

    await t.test("a station with no published price cannot be booked by amount", async () => {
      const user = await makeUser();
      const station = await Station.create({
        name: `${TAG} Unpriced ${uniq()}`,
        address: `${TAG} Road`,
        status: "Active",
        fuelTypes: ["Petrol"],
        prices: { petrol: null },
        inventory: { petrol: 1000 },
      });
      made.stations.push(station._id);

      const r = await book(tokenFor(user._id), station, { fuelAmount: 1000 });
      assert.equal(r.status, 409);
      assert.equal(r.body.reason, "PRICE_UNAVAILABLE");
    });

    await t.test("the receipt says it was booked for an amount", async () => {
      const user = await makeUser();
      const station = await makeStation({ price: 100 });
      const r = await book(tokenFor(user._id), station, { fuelAmount: 1000 });
      const booking = await Booking.findById(r.body.booking._id);
      made.bookings.push(booking._id);

      // The document the invoice is printed from (services/invoice/invoiceService.js).
      const data = await require("../src/services/invoice/invoiceService").buildInvoiceData(booking, {
        invoiceNo: "TEST/0001",
        verifyCode: "TESTCODE",
        issuedAt: new Date().toISOString(),
      });
      assert.equal(data.bookedBy, "amount");
      assert.equal(data.requestedAmount, 1000);
      assert.ok(
        data.lines[0].description.some((line) => /Booked for Rs 1000 of fuel/.test(line)),
        JSON.stringify(data.lines[0].description),
      );
      // The figures themselves are the quantity ones, unchanged.
      assert.equal(data.lines[0].qty, "10.00 L");
      assert.equal(data.lines[0].rate, 100);
    });

    await t.test("booking by quantity still behaves exactly as before", async () => {
      const user = await makeUser();
      const station = await makeStation({ price: 100 });

      const r = await book(tokenFor(user._id), station, { quantity: 12 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      made.bookings.push(r.body.booking._id);

      assert.equal(r.body.booking.quantity, 12);
      assert.equal(r.body.booking.amount, 1205);
      assert.equal(r.body.booking.bookedBy, "quantity");
      assert.equal(r.body.booking.requestedAmount, null);

      // And the old validation message for an impossible quantity.
      const silly = await book(tokenFor(await makeUser().then((u) => u._id)), station, { quantity: 0 });
      assert.equal(silly.status, 400);
      assert.equal(silly.body.reason, "INVALID_QUANTITY");
    });

    await t.test("a fleet can mix litres and rupees, vehicle by vehicle", async () => {
      const user = await makeUser();
      const station = await makeStation({ price: 100 });
      const token = tokenFor(user._id);

      const plan = await call("POST", "/api/bookings/fleet/plan", token, {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        preferredSlot: "2:00 PM",
        vehicles: [
          { vehiclePlate: "MH12MIX0001", quantity: 20 },
          { vehiclePlate: "MH12MIX0002", fuelAmount: 1500 },
          { vehiclePlate: "MH12MIX0003", fuelAmount: 500 },
        ],
      });
      assert.equal(plan.status, 200, JSON.stringify(plan.body));

      const byPlate = new Map(plan.body.vehicles.map((v) => [v.vehiclePlate, v]));
      assert.equal(byPlate.get("MH12MIX0001").quantity, 20);
      assert.equal(byPlate.get("MH12MIX0002").quantity, 15, "₹1500 / ₹100");
      assert.equal(byPlate.get("MH12MIX0003").quantity, 5, "₹500 / ₹100");
      assert.equal(plan.body.totals.quantity, 40, "the sum of the three");

      const confirm = await call("POST", "/api/bookings/fleet", token, {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        payMethod: "station",
        vehicles: [
          { vehiclePlate: "MH12MIX0001", quantity: 20, timeSlot: "2:00 PM" },
          { vehiclePlate: "MH12MIX0002", fuelAmount: 1500, timeSlot: "2:00 PM" },
          { vehiclePlate: "MH12MIX0003", fuelAmount: 500, timeSlot: "2:00 PM" },
        ],
      });
      assert.ok([201, 207].includes(confirm.status), JSON.stringify(confirm.body));
      for (const b of confirm.body.bookings) made.bookings.push(b.bookingId);
      if (confirm.body.group?.fleetId) made.groups.push(confirm.body.group.fleetId);

      const booked = new Map(confirm.body.bookings.map((b) => [b.vehiclePlate, b]));
      assert.equal(booked.get("MH12MIX0002").quantity, 15);
      assert.equal(booked.get("MH12MIX0002").bookedBy, "amount");
      assert.equal(booked.get("MH12MIX0002").requestedAmount, 1500);
      assert.equal(booked.get("MH12MIX0001").bookedBy, "quantity");

      // Stock committed is the sum of the resolved quantities.
      const after = await Station.findById(station._id).select("inventoryCommitted").lean();
      assert.equal(after.inventoryCommitted.petrol, 40);
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
