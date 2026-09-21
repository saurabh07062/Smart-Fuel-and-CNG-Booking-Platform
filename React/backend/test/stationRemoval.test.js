/**
 * Deleting a station deletes everything that belongs to it, whichever way it
 * is deleted: the vendor panel, the admin endpoint, or deleting the vendor.
 *
 * Each case builds two stations with a record in every related collection
 * and photo files on disk, deletes one, and checks that nothing of it is left
 * while the other station keeps all of its data.
 *
 * DEVELOPMENT TEST DATA, test database only: tagged users, stations, related
 * rows and files, all removed at the end.
 *
 *   node --test test/stationRemoval.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const testDb = require("./helpers/testDb");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("station removal against MongoDB", async (t) => {
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
  const models = {
    Booking: require("../src/models/Booking"),
    Notification: require("../src/models/Notification"),
    BookingAttempt: require("../src/models/BookingAttempt"),
    InventoryMovement: require("../src/models/InventoryMovement"),
    WalkIn: require("../src/models/WalkIn"),
    Employee: require("../src/models/Employee"),
    PriceHistory: require("../src/models/PriceHistory"),
  };
  const SecurityEvent = require("../src/models/SecurityEvent");
  const { UPLOAD_ROOT } = require("../src/middleware/upload");
  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const tag = `stationrm-${Date.now()}`;
  const tokenFor = (id) =>
    jwt.sign({ user: { id: String(id) } }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "30m" });
  const users = [];
  const mkUser = async (suffix, role, extra = {}) => {
    const u = await User.create({
      name: `${tag}-${suffix}`,
      email: `${tag}-${suffix}@example.com`,
      password: "not-used-in-this-test",
      role,
      isVerified: true,
      ...extra,
    });
    users.push(u._id);
    return u;
  };

  const customer = await mkUser("customer", "customer");
  const admin = await mkUser("admin", "admin");

  /** A real file under uploads/stations, and its public path. */
  const photo = (name) => {
    const dir = path.join(UPLOAD_ROOT, "stations");
    fs.mkdirSync(dir, { recursive: true });
    const file = `${tag}-${name}.png`;
    fs.writeFileSync(path.join(dir, file), "png");
    return `/uploads/stations/${file}`;
  };
  const onDisk = (p) => fs.existsSync(path.join(UPLOAD_ROOT, p.replace(/^\/uploads\//, "")));

  /** A station with one row in every related collection, written raw. */
  const stationWithData = async (owner, suffix) => {
    const images = [photo(`${suffix}-cover`)];
    const pumpImages = { petrol: photo(`${suffix}-petrol`), cng: photo(`${suffix}-cng`) };
    const station = await Station.create({ name: `${tag}-${suffix}`, address: "Removal Road", owner: owner._id, images, pumpImages });
    const s = station._id;
    const booking = new mongoose.Types.ObjectId();
    const now = new Date();
    await models.Booking.collection.insertOne({ _id: booking, user: customer._id, station: s, status: "completed", fuelType: "Petrol", createdAt: now });
    await models.Notification.collection.insertMany([
      { user: customer._id, type: "system", title: "about the station", station: s, dedupeKey: `${tag}:${s}:station`, createdAt: now },
      { user: customer._id, type: "booking_completed", title: "about a booking", booking, dedupeKey: `${tag}:${booking}:booking`, createdAt: now },
    ]);
    await models.BookingAttempt.collection.insertOne({ user: customer._id, station: s, status: "confirmed", createdAt: now });
    await models.InventoryMovement.collection.insertOne({ station: s, fuel: "petrol", type: "delivery", createdAt: now });
    await models.WalkIn.collection.insertOne({ station: s, fuelType: "Petrol", quantity: 5, status: "waiting", createdAt: now });
    await models.Employee.collection.insertOne({ station: s, name: "Attendant", phone: "9000000000", createdAt: now });
    await models.PriceHistory.collection.insertOne({ station: s, fuelType: "Petrol", oldPrice: 100, newPrice: 101, createdAt: now });
    await SecurityEvent.collection.insertOne({ user: customer._id, station: s, rule: "velocity", reason: "test", score: 1, threshold: 1, createdAt: now });
    return { id: s, booking, files: [...images, pumpImages.petrol, pumpImages.cng] };
  };

  /** How many rows in each related collection still point at this station. */
  const leftovers = async ({ id, booking }) => {
    const counts = {};
    for (const [name, Model] of Object.entries(models)) {
      const filter = name === "Notification" ? { $or: [{ station: id }, { booking }] } : { station: id };
      counts[name] = await Model.collection.countDocuments(filter);
    }
    counts.Station = await Station.countDocuments({ _id: id });
    counts.SecurityEventLinked = await SecurityEvent.collection.countDocuments({ station: id });
    return counts;
  };
  const NONE = { Booking: 0, Notification: 0, BookingAttempt: 0, InventoryMovement: 0, WalkIn: 0, Employee: 0, PriceHistory: 0, Station: 0, SecurityEventLinked: 0 };
  const ALL = { Booking: 1, Notification: 2, BookingAttempt: 1, InventoryMovement: 1, WalkIn: 1, Employee: 1, PriceHistory: 1, Station: 1, SecurityEventLinked: 1 };

  const created = [];
  const track = (x) => (created.push(x), x);

  const expectGone = async (s) => {
    assert.deepEqual(await leftovers(s), NONE, "records of the deleted station remain");
    for (const f of s.files) assert.equal(onDisk(f), false, `${f} is still on disk`);
    assert.equal(await SecurityEvent.collection.countDocuments({ user: customer._id, station: null, rule: "velocity" }) > 0, true, "the security audit row is kept, unlinked");
  };
  const expectKept = async (s) => {
    assert.deepEqual(await leftovers(s), ALL, "another station's data was touched");
    for (const f of s.files) assert.ok(onDisk(f), `${f} was removed but belongs to another station`);
  };

  try {
    await t.test("vendor panel delete removes the station and all of its details", async () => {
      const vendor = await mkUser("v1", "vendor", { vendorStatus: "active", activated: true });
      const doomed = track(await stationWithData(vendor, "v1-a"));
      const kept = track(await stationWithData(vendor, "v1-b"));

      const res = await fetch(`${base}/api/vendor-panel/stations/${doomed.id}`, {
        method: "DELETE",
        headers: { "x-auth-token": tokenFor(vendor._id) },
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.stations, 1);
      assert.equal(body.files, 3);

      await expectGone(doomed);
      await expectKept(kept);
    });

    await t.test("another vendor cannot delete it, and nothing is removed", async () => {
      const owner = await mkUser("v2", "vendor", { vendorStatus: "active", activated: true });
      const intruder = await mkUser("v2x", "vendor", { vendorStatus: "active", activated: true });
      const s = track(await stationWithData(owner, "v2-a"));
      const res = await fetch(`${base}/api/vendor-panel/stations/${s.id}`, {
        method: "DELETE",
        headers: { "x-auth-token": tokenFor(intruder._id) },
      });
      assert.equal(res.status, 404);
      await expectKept(s);
    });

    await t.test("admin delete removes the station and all of its details (it used to leave everything behind)", async () => {
      const vendor = await mkUser("v3", "vendor", { vendorStatus: "active", activated: true });
      const doomed = track(await stationWithData(vendor, "v3-a"));
      const kept = track(await stationWithData(vendor, "v3-b"));

      const res = await fetch(`${base}/api/stations/${doomed.id}`, {
        method: "DELETE",
        headers: { "x-auth-token": tokenFor(admin._id) },
      });
      assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));

      await expectGone(doomed);
      await expectKept(kept);
    });

    await t.test("deleting a vendor removes each of their stations with all of its details", async () => {
      const vendor = await mkUser("v4", "vendor", { vendorStatus: "active", activated: true });
      const other = await mkUser("v5", "vendor", { vendorStatus: "active", activated: true });
      const first = track(await stationWithData(vendor, "v4-a"));
      const second = track(await stationWithData(vendor, "v4-b"));
      const kept = track(await stationWithData(other, "v5-a"));

      const res = await fetch(`${base}/api/vendors/${vendor._id}`, {
        method: "DELETE",
        headers: { "x-auth-token": tokenFor(admin._id) },
      });
      assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));

      await expectGone(first);
      await expectGone(second);
      await expectKept(kept);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const ids = created.map((c) => c.id);
    const bookings = created.map((c) => c.booking);
    for (const [name, Model] of Object.entries(models)) {
      await Model.collection.deleteMany(name === "Notification" ? { $or: [{ station: { $in: ids } }, { booking: { $in: bookings } }] } : { station: { $in: ids } });
    }
    await SecurityEvent.collection.deleteMany({ user: customer._id });
    await Station.deleteMany({ _id: { $in: ids } });
    await User.deleteMany({ _id: { $in: users } });
    created.flatMap((c) => c.files).forEach((f) => fs.rmSync(path.join(UPLOAD_ROOT, f.replace(/^\/uploads\//, "")), { force: true }));
    await mongoose.disconnect();
  }
});
