/**
 * Check-in with a code for a booking on another day tells the vendor when to
 * come back, instead of "no matching booking".
 *
 * Needs the API on the test database:
 *   npm run test:server        then        node --test test/checkInOtherDay.test.js
 *
 * DEVELOPMENT TEST DATA: tagged users, station and booking, removed at the end.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const testDb = require("./helpers/testDb");
const API = testDb.apiUrl();

test("check-in for tomorrow's booking says come back tomorrow, with the time", { timeout: 60_000 }, async (t) => {
  const reachable = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    t.skip(`Test API not reachable at ${API} -- run "npm run test:server" first`);
    return;
  }
  const mongoose = require("mongoose");
  const jwt = require("jsonwebtoken");
  await mongoose.connect(testDb.uri(), { serverSelectionTimeoutMS: 2500 });
  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const { dateKey } = require("../src/config/businessTime");

  const tag = `checkin-day-${Date.now()}`;
  const users = [];
  const stations = [];
  const post = async (token, body) => {
    const res = await fetch(`${API}/api/bookings/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-auth-token": token },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    const probe = await Station.create({ name: `${tag}-probe`, address: "Probe", status: "Inactive" });
    stations.push(probe._id);
    const probeRes = await fetch(`${API}/api/stations/${probe._id}`);
    if (probeRes.status !== 200) assert.fail(`The API at ${API} is not using the test database.`);

    const vendor = await User.create({ name: `${tag}-v`, email: `${tag}-v@fuelmart.test`, password: "x", role: "vendor", vendorStatus: "active", activated: true });
    const customer = await User.create({ name: `${tag}-c`, email: `${tag}-c@fuelmart.test`, password: "x", role: "customer", isVerified: true });
    users.push(vendor._id, customer._id);
    const station = await Station.create({
      name: `${tag}-station`, address: "Road", owner: vendor._id, status: "Active",
      fuelTypes: ["Petrol"], prices: { petrol: 100 }, inventory: { petrol: 5000 }, tankCapacity: { petrol: 10000 },
      coordinates: { lat: 18.62, lng: 73.72 },
    });
    stations.push(station._id);

    const tomorrow = new Date(`${dateKey()}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const code = String(1000 + Math.floor(Math.random() * 9000));
    await Booking.create({
      user: customer._id, station: station._id, fuelType: "Petrol", quantity: 5, price: 100, amount: 505, taxes: 5,
      bookingDate: tomorrow.toISOString().slice(0, 10), timeSlot: "6:00 AM", status: "upcoming",
      payMethod: "station", verificationCode: code,
    });

    const token = jwt.sign({ user: { id: String(vendor._id) } }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "30m" });
    const r = await post(token, { verificationCode: code });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.reason, "NOT_TODAY");
    assert.match(r.body.msg, /tomorrow/);
    assert.match(r.body.msg, /come back tomorrow at 6:00 AM/);
    assert.equal(await Booking.countDocuments({ station: station._id, status: "upcoming" }), 1, "nothing started");
  } finally {
    await Booking.deleteMany({ station: { $in: stations } });
    await Station.deleteMany({ _id: { $in: stations } });
    await User.deleteMany({ _id: { $in: users } });
    await mongoose.disconnect();
  }
});
