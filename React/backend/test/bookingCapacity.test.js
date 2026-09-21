/**
 * Time-based booking capacity, end to end on the test database: the booking
 * window (30-minute label), service durations (Petrol/Diesel 40 s, CNG 300 s),
 * app nozzles (resources), the live line and walk-ins, through the real
 * availability, queue-preview and booking APIs.
 *
 * Tagged users, station and bookings are removed at the end.
 *   node --test test/bookingCapacity.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const mongoose = require("mongoose");
const testDb = require("./helpers/testDb");

test.after(async () => {
  require("../src/services/queue/serviceTimer").clearAllTimers();
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("booking capacity, allocation, queue and ETA", { timeout: 120_000 }, async (t) => {
  testDb.isolateRedis();
  try {
    await mongoose.connect(testDb.uri(), { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }
  const jwt = require("jsonwebtoken");
  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");
  const WalkIn = require("../src/models/WalkIn");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");
  const { buildQueuePreview } = require("../src/services/queue/stationQueue");
  const { getServiceDurationSeconds } = require("../src/config/fuelDurations");
  const realtime = require("../src/services/notification/realtime");
  await require("../src/services/core/schedulingIndexes").ensureSchedulingIndexes();
  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokenFor = (id) => jwt.sign({ user: { id: String(id) } }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "30m" });
  const call = async (method, route, token, body) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { "x-auth-token": token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const D = "2099-06-10"; // a fixed future day: nothing else books it
  const tag = `capacity-${Date.now()}`;
  const vendor = await User.create({ name: `${tag}-v`, email: `${tag}-v@fuelmart.test`, password: "x", role: "vendor", vendorStatus: "active", activated: true, isVerified: true });
  const customers = await User.insertMany(
    Array.from({ length: 40 }, (_, i) => ({ name: `${tag}-c${i}`, email: `${tag}-c${i}@fuelmart.test`, password: "x", role: "customer", isVerified: true })),
  );
  const mkStation = (name, extra = {}) =>
    Station.create({
      name: `${tag}-${name}`, address: "Capacity Road", owner: vendor._id, status: "Active",
      fuelTypes: ["Petrol", "Diesel", "CNG"], prices: { petrol: 100, diesel: 90, cng: 80 },
      inventory: { petrol: 5000, diesel: 5000, cng: 5000 }, coordinates: { lat: 18.62, lng: 73.72 },
      ...extra,
    });
  const station = await mkStation("main");
  const id = String(station._id);
  const stations = [station._id];
  let nextCustomer = 0;
  const customer = () => customers[nextCustomer++];
  const book = (fuelType, timeSlot, who = customer()) =>
    call("POST", "/api/bookings", tokenFor(who._id), { stationId: id, fuelType, quantity: 5, bookingDate: D, timeSlot, payMethod: "station" });
  const availability = async (fuelType, label, sid = id) => {
    const r = await call("GET", `/api/bookings/availability?stationId=${sid}&fuelType=${fuelType}&date=${D}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.slots.find((s) => s.label === label);
  };
  const windowStart = (label) => nozzleScheduler.parseStartDateTime(D, label).getTime();

  try {
    await t.test("1-3. a 30-minute window: Petrol 45, Diesel 45, CNG 6 (floor(1800 / duration))", async () => {
      for (const [fuel, total] of [["Petrol", 45], ["Diesel", 45], ["CNG", 6]]) {
        const row = await availability(fuel, "10:00 AM");
        assert.equal(row.capacity.total, total, fuel);
        assert.equal(row.capacity.available, total, fuel);
        assert.equal(row.capacity.resources, 1);
      }
    });

    await t.test("12. service duration comes from config/fuelDurations.js and sizes each booking", async () => {
      const r = await book("Petrol", "11:00 AM");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const b = r.body.booking;
      assert.equal(b.serviceDurationSeconds, getServiceDurationSeconds("Petrol", 5));
      assert.equal(new Date(b.bookingEndTime) - new Date(b.bookingStartTime), b.serviceDurationSeconds * 1000);
      // The next booking in that window follows back-to-back.
      const r2 = await book("Petrol", "11:00 AM");
      assert.equal(new Date(r2.body.booking.bookingStartTime).getTime(), new Date(b.bookingEndTime).getTime());
      assert.equal((await availability("Petrol", "11:00 AM")).capacity.available, 43);
    });

    await t.test("4-5. two CNG nozzles double the capacity; bookings are spread over them", async () => {
      const setup = await call("PATCH", `/api/vendor-panel/stations/${id}/nozzles`, tokenFor(vendor._id), { cng: { total: 2, online: 2 } });
      assert.equal(setup.status, 200, JSON.stringify(setup.body));
      const before = await availability("CNG", "12:00 PM");
      assert.deepEqual([before.capacity.total, before.capacity.available, before.capacity.resources], [12, 12, 2]);

      const a = (await book("CNG", "12:00 PM")).body.booking;
      const b = (await book("CNG", "12:00 PM")).body.booking;
      assert.deepEqual([a.resource, b.resource].sort(), [1, 2], "one on each nozzle");
      assert.equal(new Date(a.bookingStartTime).getTime(), windowStart("12:00 PM"));
      assert.equal(new Date(b.bookingStartTime).getTime(), windowStart("12:00 PM"), "both start at once, in parallel");
      const after = await availability("CNG", "12:00 PM");
      assert.equal(after.capacity.available, 10, "existing bookings reduce what is left");
    });

    let fullCng = [];
    await t.test("14. boundary: the last CNG position ends exactly at the window's end; then it is full", async () => {
      await call("PATCH", `/api/vendor-panel/stations/${id}/nozzles`, tokenFor(vendor._id), { cng: { total: 1, online: 1 } });
      for (let i = 0; i < 6; i++) {
        const r = await book("CNG", "2:00 PM");
        assert.equal(r.status, 200, JSON.stringify(r.body));
        fullCng.push(r.body.booking);
      }
      const last = fullCng[5];
      assert.equal(new Date(last.bookingEndTime).getTime(), windowStart("2:00 PM") + 30 * 60_000);
      const seventh = await book("CNG", "2:00 PM");
      assert.equal(seventh.status, 400);
      assert.equal(seventh.body.reason, "SLOT_FULL");
      const row = await availability("CNG", "2:00 PM");
      assert.equal(row.reason, "RESERVED");
      assert.equal(row.capacity.available, 0);
    });

    await t.test("8. cancelling releases its capacity at once", async () => {
      const victim = fullCng[2];
      const r = await call("PATCH", `/api/bookings/${victim._id}/cancel`, tokenFor(victim.user));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const row = await availability("CNG", "2:00 PM");
      assert.equal(row.capacity.available, 1);
      assert.equal(row.start, new Date(victim.bookingStartTime).toISOString(), "the freed position is offered");
    });

    await t.test("10. two bookings can never share a nozzle start (database guard)", async () => {
      const taken = fullCng[0];
      await assert.rejects(
        Booking.create({
          user: new mongoose.Types.ObjectId(), station: station._id, fuelType: "CNG", quantity: 5, price: 80, amount: 405,
          bookingDate: D, timeSlot: "2:00 PM", status: "upcoming", resource: 1,
          bookingStartTime: taken.bookingStartTime, bookingEndTime: taken.bookingEndTime,
        }),
        (err) => err.code === 11000 && /uniq_active_start_per_resource/.test(err.message),
      );
      const overlapping = new Date(new Date(taken.bookingStartTime).getTime() + 60_000);
      assert.equal(
        await nozzleScheduler.hasOverlap(station._id, overlapping, new Date(overlapping.getTime() + 300_000), null, { fuelType: "CNG", resource: 1 }),
        true,
        "an overlapping position on the same nozzle is a conflict",
      );
    });

    await t.test("11. concurrent requests never exceed capacity or overlap", async () => {
      // 10 customers at once for a window that holds 6 CNG fills.
      const results = await Promise.all(Array.from({ length: 10 }, () => book("CNG", "3:00 PM")));
      const ok = results.filter((r) => r.status === 200).map((r) => r.body.booking);
      assert.ok(ok.length <= 6, `${ok.length} accepted`);
      assert.ok(results.every((r) => r.status === 200 || ["SLOT_FULL", "NOZZLE_BUSY"].includes(r.body.reason)), JSON.stringify(results.map((r) => r.body.reason)));
      const spans = ok.map((b) => [new Date(b.bookingStartTime).getTime(), new Date(b.bookingEndTime).getTime()]).sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] >= spans[i - 1][1], "no two overlap on the one CNG nozzle");
      const inDb = await Booking.countDocuments({ station: station._id, fuelType: "CNG", timeSlot: "3:00 PM", status: "upcoming" });
      assert.equal(inDb, ok.length);
    });

    // ---- the live line on a fixed day, with the clock set by the test
    const q = await mkStation("queue");
    stations.push(q._id);
    const qid = String(q._id);
    const now = new Date(windowStart("10:00 AM") + 5 * 60_000); // 10:05 on day D
    let slotK = 0;
    // Each fixture its own position in the window (the database refuses two
    // live bookings with the same start on one nozzle).
    const liveBooking = (fields) => {
      const k = slotK++;
      return Booking.create({
        user: customer()._id, station: q._id, fuelType: "Petrol", quantity: 5, price: 100, amount: 505,
        bookingDate: D, timeSlot: "10:00 AM", status: "upcoming", resource: 1, serviceDurationSeconds: 40,
        bookingStartTime: new Date(windowStart("10:00 AM") + k * 40_000),
        bookingEndTime: new Date(windowStart("10:00 AM") + (k + 1) * 40_000),
        ...fields,
      });
    };
    const preview = () =>
      buildQueuePreview({ stationId: qid, fuelType: "Petrol", quantity: 5, bookingDate: D, timeSlot: "10:00 AM", slotStart: new Date(windowStart("10:00 AM")), now });

    let serving;
    await t.test("6. queue-based ETA: 3 vehicles ahead x 40 s = 120 s; start 10:07", async () => {
      serving = await liveBooking({ status: "serving", arrivalTime: now, fuelingStartTime: now });
      await liveBooking({ arrivalTime: new Date(now.getTime() - 1000) });
      await liveBooking({ arrivalTime: new Date(now.getTime() - 500) });
      const p = await preview();
      assert.equal(p.schedule.vehiclesServing, 1);
      assert.equal(p.schedule.queueAhead, 3);
      assert.equal(p.schedule.expectedWaitSeconds, 120);
      assert.equal(new Date(p.schedule.estimatedStartTime).getTime(), now.getTime() + 120_000);
      assert.equal(new Date(p.schedule.estimatedCompletionTime).getTime(), now.getTime() + 160_000);
      assert.equal(p.schedule.serviceDurationSeconds, 40);
      assert.equal(p.schedule.totalCapacity, 45);
      assert.equal(p.schedule.resourceAvailable, true);
    });

    await t.test("7. a walk-in at the shared nozzle adds its fill to the wait", async () => {
      await WalkIn.create({
        station: q._id, fuelType: "Petrol", quantity: 5, status: "waiting", businessDate: D,
        arrivalTime: new Date(now.getTime() - 100), serviceDurationSeconds: 40,
      });
      const p = await preview();
      assert.equal(p.schedule.queueAhead, 4);
      assert.equal(p.schedule.expectedWaitSeconds, 160);
    });

    await t.test("9. a completed fill releases its time", async () => {
      await Booking.updateOne({ _id: serving._id }, { $set: { status: "completed", completionTime: now } });
      const p = await preview();
      assert.equal(p.schedule.queueAhead, 3);
      assert.equal(p.schedule.expectedWaitSeconds, 120, "the two checked-in cars and the walk-in: 3 x 40 s");
    });

    await t.test("13. booking changes are pushed to watchers in real time", async () => {
      const sent = [];
      const original = realtime.toStation;
      realtime.toStation = (sid, event, payload) => {
        sent.push({ sid: String(sid), event });
        return original.call(realtime, sid, event, payload);
      };
      try {
        const r = await book("Diesel", "4:00 PM");
        assert.equal(r.status, 200, JSON.stringify(r.body));
        await call("PATCH", `/api/bookings/${r.body.booking._id}/cancel`, tokenFor(r.body.booking.user));
      } finally {
        realtime.toStation = original;
      }
      const slotEvents = sent.filter((e) => e.sid === id && e.event === realtime.EVENTS.SLOT_UPDATED);
      assert.ok(slotEvents.length >= 2, "one push for the booking, one for the cancellation");
    });

    await t.test("two online nozzles: two checked-in cars fuel at once, the third waits", async () => {
      const two = await mkStation("two-nozzles", { nozzleConfig: { petrol: { total: 2, online: 2 } } });
      stations.push(two._id);
      const nozzleService = require("../src/services/queue/nozzleService");
      const { dateKey } = require("../src/config/businessTime");
      const today = dateKey();
      const mk = (k) =>
        Booking.create({
          user: customer()._id, station: two._id, fuelType: "Petrol", quantity: 5, price: 100, amount: 505,
          bookingDate: today, timeSlot: "9:30 PM", status: "upcoming", resource: (k % 2) + 1, serviceDurationSeconds: 40,
          bookingStartTime: new Date(Date.now() + 3_600_000 + k * 40_000), bookingEndTime: new Date(Date.now() + 3_600_000 + (k + 1) * 40_000),
          payMethod: "station", paymentStatus: "due_at_station",
        });
      const [a, b, c] = [await mk(0), await mk(1), await mk(2)];
      const ra = await nozzleService.checkIn({ bookingId: a._id });
      const rb = await nozzleService.checkIn({ bookingId: b._id });
      const rc = await nozzleService.checkIn({ bookingId: c._id });
      assert.deepEqual([ra.outcome, rb.outcome, rc.outcome], ["started", "started", "queued"]);
      assert.deepEqual([ra.booking.resource, rb.booking.resource].sort(), [1, 2], "one car on each nozzle");
      require("../src/services/queue/serviceTimer").clearAllTimers();
    });

    await t.test("15. a closed station window takes no bookings", async () => {
      const day = new Date(`${D}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }).toLowerCase();
      const closed = await mkStation("closed", { operatingSchedule: { [day]: { is24h: false, open: "08:00", close: "12:00", isClosed: false } } });
      stations.push(closed._id);
      const row = await availability("Petrol", "6:00 PM", String(closed._id));
      assert.equal(row.reason, "CLOSED");
      assert.equal(row.capacity.available, 0);
      const r = await call("POST", "/api/bookings", tokenFor(customer()._id), {
        stationId: String(closed._id), fuelType: "Petrol", quantity: 5, bookingDate: D, timeSlot: "6:00 PM", payMethod: "station",
      });
      assert.equal(r.status >= 400, true, JSON.stringify(r.body));
    });
  } finally {
    server.close();
    await Booking.deleteMany({ station: { $in: stations } });
    await WalkIn.deleteMany({ station: { $in: stations } });
    await require("../src/models/InventoryMovement").deleteMany({ station: { $in: stations } });
    await require("../src/models/Notification").deleteMany({ user: { $in: customers.map((c) => c._id) } });
    await Station.deleteMany({ _id: { $in: stations } });
    await User.deleteMany({ _id: { $in: [vendor._id, ...customers.map((c) => c._id)] } });
    await mongoose.disconnect();
  }
});
