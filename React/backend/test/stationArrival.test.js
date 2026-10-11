/**
 * "Check In at Petrol Pump" (services/booking/stationArrival.js) and the
 * first-come-first-served guard on the attendant's PIN check-in.
 * Runs against the test database (helpers/testDb) only.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");

// The real checks: the developer's .env may switch the testing mode on.
process.env.CHECKIN_DEMO_MODE = "false";

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

const fakeRes = () => ({
  statusCode: 200,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
  send(b) { this.body = b; return this; },
});

// The station's pump, and points about 100 m and 2 km away.
const PUMP = { lat: 18.5805621, lng: 73.9753407 };
const NEAR = { lat: 18.5814, lng: 73.9756 };
const FAR = { lat: 18.5985, lng: 73.9753 };

test("station check-in against MongoDB", async (t) => {
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
  const bookingController = require("../src/controllers/bookingController");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");
  const { dateKey, clockParts } = require("../src/config/businessTime");
  const { BOOKABLE_SLOT_LABELS } = require("../src/config/booking");

  const tag = `arrival-${Date.now()}`;
  const TODAY = dateKey();
  // The slot running now (India time), so check-in is open.
  const at = clockParts(new Date());
  const nowLabel = BOOKABLE_SLOT_LABELS[at.hours * 2 + (at.minutes >= 30 ? 1 : 0)];
  const stationIds = [];
  let vendor = null;
  let n = 0;

  const makeStation = async (online = 1) => {
    const s = await Station.create({
      name: `${tag} Pump ${stationIds.length}`,
      address: "Arrival Road",
      owner: vendor._id,
      status: "Active",
      fuelTypes: ["Petrol"],
      prices: { petrol: 100 },
      inventory: { petrol: 5000 },
      coordinates: PUMP,
      location: { type: "Point", coordinates: [PUMP.lng, PUMP.lat] },
      nozzleConfig: { petrol: { total: Math.max(online, 1), online } },
    });
    stationIds.push(s._id);
    return s;
  };
  // Back to back on the nozzle, as the scheduler places them: one fill apart.
  const perStation = new Map();
  const book = async (station, { date = TODAY, label = nowLabel, code } = {}) => {
    const i = n++;
    const k = `${station._id}|${date}|${label}`;
    const place = perStation.get(k) ?? 0;
    perStation.set(k, place + 1);
    const c = await User.create({ name: `${tag}-c${i}`, email: `${tag}-c${i}@example.com`, password: "x", role: "customer", isVerified: true });
    const w = nozzleScheduler.computeWindow("Petrol", new Date(nozzleScheduler.parseStartDateTime(date, label).getTime() + place * 40_000));
    return Booking.create({
      user: c._id, station: station._id, fuelType: "Petrol", quantity: 5, price: 100, amount: 505,
      bookingDate: date, timeSlot: label, bookingStartTime: w.start, bookingEndTime: w.end,
      payMethod: "station", paymentStatus: "due_at_station", status: "upcoming",
      vehiclePlate: `MH12AB${1000 + i}`, verificationCode: code ?? String(4000 + i),
    });
  };
  const checkIn = async (b, coords, userId = b.user) => {
    const res = fakeRes();
    await bookingController.stationCheckIn(
      { params: { id: String(b._id) }, user: { id: String(userId) }, body: coords ? { latitude: coords.lat, longitude: coords.lng } : {}, app: { get: () => null } },
      res,
    );
    return res;
  };
  const verify = async (b, extra = {}) => {
    const res = fakeRes();
    await bookingController.verifyBooking(
      { body: { bookingId: String(b._id), ...extra }, user: { id: String(vendor._id), role: "vendor" }, app: { get: () => null } },
      res,
    );
    return res;
  };

  try {
    vendor = await User.create({ name: `${tag}-v`, email: `${tag}-v@example.com`, password: "x", role: "vendor", vendorStatus: "active", activated: true });

    await t.test("refused: far away, no location, another day, someone else's booking", async () => {
      const s = await makeStation();
      const b = await book(s);
      let res = await checkIn(b, FAR);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.reason, "TOO_FAR");
      assert.ok(res.body.distanceM > 1000);
      res = await checkIn(b, null);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.reason, "LOCATION_REQUIRED");
      res = await checkIn(b, NEAR, new mongoose.Types.ObjectId());
      assert.equal(res.statusCode, 404);
      const tomorrow = await book(s, { date: "2099-06-01", label: "10:00 AM" });
      res = await checkIn(tomorrow, NEAR);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.reason, "NOT_TODAY");
      assert.equal((await Booking.findById(b._id).lean()).stationCheckInAt, null, "nothing recorded");
    });

    await t.test("at the pump: checked in once, with the distance; a repeat changes nothing", async () => {
      const s = await makeStation();
      const b = await book(s);
      const res = await checkIn(b, NEAR);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.alreadyCheckedIn, false);
      assert.ok(res.body.distanceM > 50 && res.body.distanceM < 200, String(res.body.distanceM));
      const first = (await Booking.findById(b._id).lean()).stationCheckInAt;
      assert.ok(first instanceof Date);
      // Not the start of service.
      assert.equal((await Booking.findById(b._id).lean()).status, "upcoming");
      const again = await checkIn(b, PUMP);
      assert.equal(again.body.alreadyCheckedIn, true);
      assert.equal((await Booking.findById(b._id).lean()).stationCheckInAt.getTime(), first.getTime());
    });

    await t.test("B checked in first: A's PIN is held back until the attendant confirms", async () => {
      const s = await makeStation(1);
      const a = await book(s);
      const b = await book(s);
      assert.equal((await checkIn(b, NEAR)).statusCode, 200); // B reaches the pump first
      await new Promise((r) => setTimeout(r, 15));
      assert.equal((await checkIn(a, NEAR)).statusCode, 200); // then A

      const held = await verify(a);
      assert.equal(held.statusCode, 409);
      assert.equal(held.body.reason, "EARLIER_ARRIVAL");
      assert.equal(held.body.earlier[0].bookingId, String(b._id));
      assert.match(held.body.msg, /checked in at the pump first/);
      assert.equal((await Booking.findById(a._id).lean()).status, "upcoming", "A not started");

      // B's own PIN goes straight through.
      const bRes = await verify(b);
      assert.equal(bRes.statusCode, 200, JSON.stringify(bRes.body));
      assert.equal(bRes.body.started, true);
    });

    await t.test("the attendant can still continue (override), e.g. when the earlier customer left", async () => {
      const s = await makeStation(1);
      const a = await book(s);
      const b = await book(s);
      await checkIn(b, NEAR);
      await new Promise((r) => setTimeout(r, 15));
      await checkIn(a, NEAR); // A is at the pump too -- the PIN needs that first
      const res = await verify(a, { override: true });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.started, true);
    });

    await t.test("two free app nozzles: nobody is jumped, no warning", async () => {
      const s = await makeStation(2);
      const a = await book(s);
      const b = await book(s);
      await checkIn(b, NEAR);
      await new Promise((r) => setTimeout(r, 15));
      await checkIn(a, NEAR);
      const res = await verify(a);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    });

    await t.test("testing mode (CHECKIN_DEMO_MODE=true): no location needed, far away is fine", async () => {
      process.env.CHECKIN_DEMO_MODE = "true";
      try {
        const s = await makeStation();
        const far = await book(s);
        assert.equal((await checkIn(far, FAR)).statusCode, 200);
        const none = await book(s);
        const res = await checkIn(none, null);
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.ok((await Booking.findById(none._id).lean()).stationCheckInAt instanceof Date);
        // Another day is still refused.
        const tomorrow = await book(s, { date: "2099-06-02", label: "10:00 AM" });
        assert.equal((await checkIn(tomorrow, null)).body.reason, "NOT_TODAY");
      } finally {
        process.env.CHECKIN_DEMO_MODE = "false";
      }
    });

    await t.test("without an app check-in the PIN does nothing; after one it works", async () => {
      // The code is only valid once the customer has checked in AT the pump.
      // It used to work on its own, which meant the 4 digits -- readable over
      // a shoulder, or sent to a friend -- were enough to start a fill for a
      // customer who was not there.
      const s = await makeStation(1);
      const a = await book(s);

      const refused = await verify(a);
      assert.equal(refused.statusCode, 409, JSON.stringify(refused.body));
      assert.equal(refused.body.reason, "NOT_CHECKED_IN");
      assert.equal((await Booking.findById(a._id).lean()).status, "upcoming", "nothing started");

      assert.equal((await checkIn(a, NEAR)).statusCode, 200);
      const res = await verify(a);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.started, true);
    });
  } finally {
    await Booking.deleteMany({ station: { $in: stationIds } });
    await Station.deleteMany({ _id: { $in: stationIds } });
    await User.deleteMany({ email: new RegExp(`^${tag}-`) });
    await mongoose.disconnect();
  }
});
