/**
 * Vehicle count and expected waiting time (services/queue/queueInfo.js),
 * end to end on real bookings made through createCustomerBooking -- the
 * scheduler, its locks and its placement -- never on hand-written numbers.
 *
 * Runs against the test database (helpers/testDb) only; bookings are dated
 * 2099 on a station of this test's own, all removed at the end.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");

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

test("vehicle count and expected waiting time against MongoDB", async (t) => {
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
  const { createCustomerBooking } = require("../src/services/booking/bookingCreate");
  const { queueInfoForBookings, formatWait } = require("../src/services/queue/queueInfo");
  const { buildQueuePreview } = require("../src/services/queue/stationQueue");
  const nozzleScheduler = require("../src/services/queue/nozzleScheduler");
  const nozzleService = require("../src/services/queue/nozzleService");
  const bookingController = require("../src/controllers/bookingController");
  const vendorPanel = require("../src/controllers/vendorPanelController");
  const { atBusinessTime } = require("../src/config/businessTime");

  const tag = `queueinfo-${Date.now()}`;
  const DAY = "2099-05-04";
  // A moment the day before: nothing is live yet, every figure comes from the reservations.
  const BEFORE = atBusinessTime("2099-05-03", 12, 0);
  let vendor = null;
  let station = null;
  let n = 0;

  const customer = async () => {
    const i = n++;
    return User.create({ name: `${tag}-c${i}`, email: `${tag}-c${i}@example.com`, password: "x", role: "customer", isVerified: true });
  };
  const book = async (fuelType, timeSlot, quantity = 5) => {
    const c = await customer();
    const b = await createCustomerBooking({
      user: { id: String(c._id) },
      body: { stationId: String(station._id), fuelType, quantity, bookingDate: DAY, timeSlot, payMethod: "station" },
    });
    return Booking.findById(b._id).lean();
  };
  const infoOf = async (bookings, now = BEFORE) => {
    const map = await queueInfoForBookings(bookings, { now });
    return bookings.map((b) => map.get(String(b._id)));
  };
  const windowStart = (label) => nozzleScheduler.parseStartDateTime(DAY, label).getTime();
  const waitOf = (b, label) => Math.round((new Date(b.bookingStartTime).getTime() - windowStart(label)) / 1000);

  try {
    vendor = await User.create({ name: `${tag}-v`, email: `${tag}-v@example.com`, password: "x", role: "vendor", vendorStatus: "active", activated: true });
    station = await Station.create({
      name: `${tag} Station`,
      address: "Queue Road",
      owner: vendor._id,
      status: "Active",
      fuelTypes: ["Petrol", "Diesel", "CNG"],
      prices: { petrol: 100, diesel: 90, cng: 80 },
      inventory: { petrol: 5000, diesel: 5000, cng: 5000 },
      // One app nozzle per fuel: every vehicle of a fuel waits for the one before it.
      nozzleConfig: { petrol: { total: 1, online: 1 }, diesel: { total: 1, online: 1 }, cng: { total: 1, online: 1 } },
    });

    const petrol = [];

    await t.test("petrol: each customer in the same slot is one further back, 40 s per vehicle", async () => {
      for (let i = 0; i < 4; i++) petrol.push(await book("Petrol", "10:00 AM"));
      const info = await infoOf(petrol);
      info.forEach((q, i) => {
        assert.equal(q.vehicleCountAhead, i, `customer ${i + 1}`);
        assert.equal(q.queuePosition, i + 1);
        assert.equal(q.expectedWaitingSeconds, waitOf(petrol[i], "10:00 AM"));
        assert.equal(q.expectedWaitingTime, formatWait(q.expectedWaitingSeconds));
        assert.match(q.estimatedStartTime, /^10:0\d AM$/);
      });
      // Back to back, 40 s each (a placement may round up to its grid, never less).
      for (let i = 1; i < 4; i++) {
        assert.ok(info[i].expectedWaitingSeconds - info[i - 1].expectedWaitingSeconds >= 40, "at least one petrol fill apart");
      }
      assert.equal(info[0].expectedWaitingSeconds, 0);
    });

    await t.test("diesel has its own nozzle: petrol ahead does not count", async () => {
      const d1 = await book("Diesel", "10:00 AM");
      const d2 = await book("Diesel", "10:00 AM");
      const [a, b] = await infoOf([d1, d2]);
      assert.equal(a.vehicleCountAhead, 0);
      assert.equal(a.expectedWaitingSeconds, 0);
      assert.equal(b.vehicleCountAhead, 1);
      assert.ok(b.expectedWaitingSeconds >= 40);
    });

    await t.test("CNG: 5 minutes per vehicle", async () => {
      const cng = [await book("CNG", "11:00 AM"), await book("CNG", "11:00 AM"), await book("CNG", "11:00 AM")];
      const info = await infoOf(cng);
      assert.deepEqual(info.map((q) => q.vehicleCountAhead), [0, 1, 2]);
      assert.equal(info[0].expectedWaitingSeconds, 0);
      assert.ok(info[1].expectedWaitingSeconds >= 300 && info[1].expectedWaitingSeconds < 330, String(info[1].expectedWaitingSeconds));
      assert.ok(info[2].expectedWaitingSeconds >= 600 && info[2].expectedWaitingSeconds < 660, String(info[2].expectedWaitingSeconds));
      assert.equal(info[1].expectedWaitingTime, formatWait(info[1].expectedWaitingSeconds));
    });

    await t.test("the preview before booking matches the booking made right after", async () => {
      const preview = await buildQueuePreview({
        stationId: String(station._id),
        fuelType: "Petrol",
        quantity: 5,
        slotStart: new Date(windowStart("10:00 AM")),
        bookingDate: DAY,
        timeSlot: "10:00 AM",
        now: BEFORE,
      });
      const fifth = await book("Petrol", "10:00 AM");
      petrol.push(fifth);
      const [mine] = await infoOf([fifth]);
      assert.equal(preview.you.vehicleCountAhead, 4);
      assert.equal(preview.you.queuePosition, 5);
      assert.equal(mine.vehicleCountAhead, preview.you.vehicleCountAhead);
      assert.equal(mine.queuePosition, preview.you.queuePosition);
      assert.equal(mine.expectedWaitingSeconds, preview.you.expectedWaitingSeconds);
      assert.equal(mine.estimatedStartTime, preview.you.estimatedStartTime);
    });

    await t.test("a cancelled booking no longer counts for anyone behind it", async () => {
      const last = petrol[4];
      assert.equal((await infoOf([last]))[0].vehicleCountAhead, 4);
      await Booking.updateOne({ _id: petrol[1]._id }, { $set: { status: "cancelled", cancelledAt: new Date(), cancelledBy: "customer" } });
      const [after] = await infoOf([last]);
      assert.equal(after.vehicleCountAhead, 3);
      assert.equal(after.queuePosition, 4);
      // The cancelled booking itself has no queue figures.
      const [gone] = await infoOf([await Booking.findById(petrol[1]._id).lean()]);
      assert.equal(gone, null);
    });

    await t.test("the vehicle at the nozzle counts for its remaining time only", async () => {
      // 10:00:00 on the day: the first petrol customer checks in and starts fuelling.
      const start = new Date(windowStart("10:00 AM"));
      const started = await nozzleService.checkIn({ bookingId: petrol[0]._id, now: start });
      assert.ok(["started", "queued"].includes(started.outcome), started.outcome);
      const serving = await Booking.findById(petrol[0]._id).lean();
      assert.equal(serving.status, "serving");

      // 25 s later: 15 s of that 40 s fill remain.
      const now = new Date(start.getTime() + 25_000);
      const [atPump, next] = await infoOf([serving, await Booking.findById(petrol[2]._id).lean()], now);
      assert.equal(atPump.vehicleCountAhead, 0);
      assert.equal(atPump.queuePosition, 1);
      assert.equal(atPump.expectedWaitingSeconds, 0);
      // The next one waits for the fill in progress: it is ahead, and the wait
      // is counted from now, not from the start of the slot.
      assert.ok(next.vehicleCountAhead >= 1);
      const nextStart = new Date((await Booking.findById(petrol[2]._id).lean()).bookingStartTime).getTime();
      assert.equal(next.expectedWaitingSeconds, Math.max(0, Math.round((nextStart - now.getTime()) / 1000)));
    });

    await t.test("customer and vendor see identical figures for the same booking", async () => {
      const target = petrol[4];
      const custRes = fakeRes();
      await bookingController.getBookingById({ params: { id: String(target._id) }, user: { id: String(target.user) } }, custRes);
      const vendRes = fakeRes();
      await vendorPanel.getStationBookings(
        { params: { id: String(station._id) }, query: {}, user: { id: String(vendor._id), role: "vendor" } },
        vendRes,
      );
      const fromVendor = vendRes.body.find((b) => String(b._id) === String(target._id));
      assert.ok(custRes.body.queueInfo, "customer view has queueInfo");
      assert.ok(fromVendor.queueInfo, "vendor view has queueInfo");
      for (const k of ["vehicleCountAhead", "queuePosition", "expectedWaitingSeconds", "expectedWaitingTime", "estimatedStartTime"]) {
        assert.equal(custRes.body.queueInfo[k], fromVendor.queueInfo[k], k);
      }
    });

    await t.test("concurrent bookings of one slot get distinct places", async () => {
      const users = await Promise.all([customer(), customer(), customer(), customer(), customer()]);
      const results = await Promise.allSettled(
        users.map((c) =>
          createCustomerBooking({
            user: { id: String(c._id) },
            body: { stationId: String(station._id), fuelType: "Petrol", quantity: 5, bookingDate: DAY, timeSlot: "2:00 PM", payMethod: "station" },
          }),
        ),
      );
      const made = await Booking.find({ _id: { $in: results.filter((r) => r.status === "fulfilled").map((r) => r.value._id) } }).lean();
      assert.equal(made.length, 5, JSON.stringify(results.map((r) => r.reason?.reason || "ok")));
      const info = await infoOf(made);
      const positions = info.map((q) => q.queuePosition).sort((a, b) => a - b);
      assert.deepEqual(positions, [1, 2, 3, 4, 5], "no two customers share a place");
      const starts = new Set(made.map((b) => new Date(b.bookingStartTime).getTime()));
      assert.equal(starts.size, 5, "no two customers share a start");
    });
  } finally {
    if (station) {
      await Booking.deleteMany({ station: station._id });
      await Station.deleteMany({ _id: station._id });
    }
    await User.deleteMany({ email: new RegExp(`^${tag}-`) });
    await mongoose.disconnect();
  }
});
