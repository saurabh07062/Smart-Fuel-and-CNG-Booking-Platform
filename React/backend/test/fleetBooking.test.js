/**
 * Phases 2 and 3 of fleet booking: planning a schedule, and confirming it.
 *
 * Driven over HTTP, because the things worth checking are end-to-end:
 *
 *   - the suggested schedule fits the station's REAL capacity (it is built
 *     with the same allocator a single booking uses, with each placed vehicle
 *     occupying the nozzle the next one is placed around)
 *   - consecutive where possible, the nearest following windows where not,
 *     and it SAYS which of the two happened
 *   - confirming allocates again, so a plan that went stale costs one vehicle
 *     its slot instead of booking the wrong time
 *   - one vehicle failing leaves the others booked (the explicit rule for this
 *     feature), and the group is still coherent
 *   - a fleet member is an ordinary booking: its own id, PIN, QR, payment and
 *     status, cancellable on its own
 *   - the single-vehicle flow still behaves exactly as before
 *
 * DEVELOPMENT TEST DATA: users, stations and bookings tagged "[fleet-api]" in
 * the test database only, all removed at the end.
 *
 *   node --test test/fleetBooking.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const TAG = "[fleet-api]";

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("fleet booking API against MongoDB", async (t) => {
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

  const { BOOKABLE_SLOT_LABELS } = require("../src/config/booking");
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
      name: `${TAG} Fleet owner`,
      email: `fleetapi.${uniq()}@example.com`,
      password: "x".repeat(60),
      isVerified: true,
    });
    made.users.push(doc._id);
    return doc;
  };

  /** A station with `nozzles` online nozzles for petrol, and plenty of stock. */
  const makeStation = async ({ nozzles = 1, stock = 5000 } = {}) => {
    const doc = await Station.create({
      name: `${TAG} Depot ${uniq()}`,
      address: `${TAG} Industrial Road`,
      status: "Active",
      fuelTypes: ["Petrol"],
      prices: { petrol: 100 },
      inventory: { petrol: stock },
      nozzleConfig: { petrol: { total: nozzles, online: nozzles } },
      coordinates: { lat: 18.52, lng: 73.85 },
    });
    made.stations.push(doc._id);
    return doc;
  };

  /**
   * Tomorrow, in INDIA -- a whole day of slots, none of them elapsed.
   *
   * Computed from the India date key rather than from a Date, because
   * `toISOString()` is UTC: midnight IST is 18:30 the previous day in UTC, so
   * the obvious version of this produced today's date and every slot read as
   * already passed.
   */
  const TOMORROW = (() => {
    const [y, m, d] = dateKey().split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    return next.toISOString().slice(0, 10);
  })();

  const vans = (n, quantity = 20) =>
    Array.from({ length: n }, (_, i) => ({ vehiclePlate: `MH12${uniq().slice(0, 2).toUpperCase()}${1000 + i}`, quantity }));

  const track = (result) => {
    for (const b of result.bookings || []) made.bookings.push(b.bookingId);
    if (result.group?.fleetId) made.groups.push(result.group.fleetId);
    return result;
  };

  try {
    await t.test("fleet endpoints need a signed-in customer", async () => {
      assert.equal((await call("POST", "/api/bookings/fleet/plan", null, {})).status, 401);
      assert.equal((await call("POST", "/api/bookings/fleet", null, {})).status, 401);
      assert.equal((await call("GET", "/api/bookings/fleet", null)).status, 401);
    });

    await t.test("the plan is refused before it starts when the request makes no sense", async () => {
      const user = await makeUser();
      const token = tokenFor(user._id);
      const station = await makeStation();
      const base = { stationId: String(station._id), fuelType: "Petrol", bookingDate: TOMORROW };

      const one = await call("POST", "/api/bookings/fleet/plan", token, { ...base, vehicles: vans(1) });
      assert.equal(one.status, 400);
      assert.equal(one.body.reason, "TOO_FEW_VEHICLES");
      assert.match(one.body.msg, /use the normal booking/);

      const plate = "MH12ZZ9999";
      const twice = await call("POST", "/api/bookings/fleet/plan", token, {
        ...base,
        vehicles: [{ vehiclePlate: plate, quantity: 10 }, { vehiclePlate: plate, quantity: 10 }],
      });
      assert.equal(twice.status, 400);
      assert.equal(twice.body.reason, "DUPLICATE_VEHICLE");
      assert.match(twice.body.msg, /twice/);

      const badQuantity = await call("POST", "/api/bookings/fleet/plan", token, {
        ...base,
        vehicles: [{ vehiclePlate: "MH12AA1111", quantity: 10 }, { vehiclePlate: "MH12AA2222", quantity: 0 }],
      });
      assert.equal(badQuantity.status, 400);
      assert.equal(badQuantity.body.reason, "INVALID_QUANTITY");

      const noPlate = await call("POST", "/api/bookings/fleet/plan", token, {
        ...base,
        vehicles: [{ vehiclePlate: "MH12AA1111", quantity: 10 }, { quantity: 10 }],
      });
      assert.equal(noPlate.status, 400);
      assert.equal(noPlate.body.reason, "VEHICLE_PLATE_REQUIRED");
    });

    await t.test("five vans on one nozzle are placed back to back and said to be", async () => {
      const user = await makeUser();
      const station = await makeStation({ nozzles: 1 });
      const r = await call("POST", "/api/bookings/fleet/plan", tokenFor(user._id), {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        preferredSlot: "10:00 AM",
        vehicles: vans(5, 20),
      });

      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.totals.scheduled, 5);
      assert.equal(r.body.totals.unavailable, 0);
      assert.equal(r.body.consecutive, true, JSON.stringify(r.body.vehicles.map((v) => v.timeSlot)));

      // Every vehicle has a real position, and no two share a nozzle at once.
      const placed = r.body.vehicles;
      assert.ok(placed.every((v) => v.state === "suggested" && v.startTime && v.resource >= 1));
      const byResource = new Map();
      for (const v of placed) {
        const list = byResource.get(v.resource) || [];
        for (const other of list) {
          const overlap = new Date(v.startsAt) < new Date(other.endsAt) && new Date(v.endsAt) > new Date(other.startsAt);
          assert.equal(overlap, false, `${v.vehiclePlate} overlaps ${other.vehiclePlate} on nozzle ${v.resource}`);
        }
        list.push(v);
        byResource.set(v.resource, list);
      }

      // The run starts where they asked, and the money is the station's price.
      assert.equal(placed[0].timeSlot, "10:00 AM");
      assert.equal(placed[0].pricePerUnit, 100);
      // Petrol fills take well under a minute, so five of them fit one
      // 30-minute window: the summary says so in those words rather than
      // "from 8:00 AM to 8:00 AM".
      assert.match(r.body.summary, /one after another|back to back/);
    });

    await t.test("each vehicle gets its own quantity, its own fill time and its own price", async () => {
      const user = await makeUser();
      const token = tokenFor(user._id);
      const station = await makeStation({ nozzles: 1 });

      // Five vans, five different fills -- a bike topping up 5 L beside a van
      // taking 45 L, which is the normal shape of a real fleet.
      const wanted = [5, 12, 20, 35, 45];
      const vehicles = vans(5).map((v, i) => ({ ...v, quantity: wanted[i] }));

      const plan = await call("POST", "/api/bookings/fleet/plan", token, {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        preferredSlot: "5:00 AM",
        vehicles,
      });
      assert.equal(plan.status, 200, JSON.stringify(plan.body));
      assert.equal(plan.body.totals.scheduled, 5);

      // Each row carries the quantity that was asked for it, and a price
      // worked out from THAT quantity at the station's published rate.
      const byPlate = new Map(plan.body.vehicles.map((v) => [v.vehiclePlate, v]));
      for (const v of vehicles) {
        const row = byPlate.get(v.vehiclePlate);
        assert.equal(row.quantity, v.quantity, `${v.vehiclePlate} keeps its own quantity`);
        assert.equal(row.pricePerUnit, 100);
        assert.equal(row.amount, 100 * v.quantity + 5, `${v.vehiclePlate} is priced on its own fill`);
        // Its window is its own fill's length, not a shared one.
        assert.ok(row.durationSeconds > 0);
      }
      // The total is the sum of the five different fills, not 5 x one figure.
      assert.equal(plan.body.totals.quantity, wanted.reduce((a, b) => a + b, 0));
      assert.equal(plan.body.totals.amount, wanted.reduce((sum, q) => sum + 100 * q + 5, 0));

      // And the bookings that are written carry them too.
      const confirm = await call("POST", "/api/bookings/fleet", token, {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        payMethod: "station",
        vehicles: plan.body.vehicles.map((v) => ({ vehiclePlate: v.vehiclePlate, quantity: v.quantity, timeSlot: v.timeSlot })),
      });
      assert.ok([201, 207].includes(confirm.status), JSON.stringify(confirm.body));
      track(confirm.body);

      for (const b of confirm.body.bookings) {
        const asked = vehicles.find((v) => v.vehiclePlate === b.vehiclePlate);
        assert.equal(b.quantity, asked.quantity);
        assert.equal(b.amount, 100 * asked.quantity + 5);
      }

      // The station's committed stock is the sum of what was actually booked.
      const booked = confirm.body.bookings.reduce((sum, b) => sum + b.quantity, 0);
      const after = await Station.findById(station._id).select("inventoryCommitted").lean();
      assert.equal(after.inventoryCommitted.petrol, booked);
    });

    await t.test("a full window pushes the run on, and the summary explains it", async () => {
      const user = await makeUser();
      const other = await makeUser();
      const station = await makeStation({ nozzles: 1 });

      // Fill 10:00-10:30 with somebody else's long CNG-length fill: a 30-minute
      // window with one nozzle has room for one 25-minute service and no more.
      const { windowOf } = require("../src/services/queue/nozzleScheduler");
      const win = windowOf(TOMORROW, "10:00 AM");
      const blocker = await Booking.create({
        user: other._id,
        station: station._id,
        fuelType: "Petrol",
        quantity: 20,
        price: 100,
        amount: 2005,
        bookingDate: TOMORROW,
        timeSlot: "10:00 AM",
        bookingStartTime: win.start,
        bookingEndTime: new Date(win.start.getTime() + 30 * 60_000),
        serviceDurationSeconds: 30 * 60,
        resource: 1,
        status: "upcoming",
        orderId: `FM-2099-${uniq().toUpperCase()}`,
      });
      made.bookings.push(blocker._id);

      const r = await call("POST", "/api/bookings/fleet/plan", tokenFor(user._id), {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        preferredSlot: "10:00 AM",
        vehicles: vans(2, 20),
      });

      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.totals.scheduled, 2);
      assert.notEqual(r.body.vehicles[0].timeSlot, "10:00 AM", "the blocked window is not offered");
      assert.match(r.body.summary, /10:00 AM was full/);
    });

    await t.test("a vehicle that is already booked is flagged, not silently dropped", async () => {
      const user = await makeUser();
      const station = await makeStation({ nozzles: 2 });
      const plate = "MH12BB4321";

      const existing = await Booking.create({
        user: user._id,
        station: station._id,
        fuelType: "Petrol",
        quantity: 10,
        price: 100,
        amount: 1005,
        bookingDate: TOMORROW,
        timeSlot: "9:00 AM",
        status: "upcoming",
        vehiclePlate: plate,
        vehicleKey: plate,
        orderId: `FM-2099-${uniq().toUpperCase()}`,
      });
      made.bookings.push(existing._id);

      const r = await call("POST", "/api/bookings/fleet/plan", tokenFor(user._id), {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        preferredSlot: "11:00 AM",
        vehicles: [{ vehiclePlate: plate, quantity: 10 }, ...vans(2, 10)],
      });

      assert.equal(r.status, 200);
      const flagged = r.body.vehicles.find((v) => v.vehiclePlate === plate);
      assert.equal(flagged.state, "conflict");
      assert.equal(flagged.reason, "VEHICLE_ALREADY_BOOKED");
      assert.match(flagged.message, /already has a booking/);
      assert.equal(r.body.totals.scheduled, 2, "the other two are still planned");
      assert.match(r.body.summary, /left out/);
    });

    await t.test("confirming writes one booking per vehicle under one group", async () => {
      const user = await makeUser();
      const token = tokenFor(user._id);
      const station = await makeStation({ nozzles: 2 });

      const plan = await call("POST", "/api/bookings/fleet/plan", token, {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        preferredSlot: "2:00 PM",
        vehicles: vans(4, 15),
      });
      assert.equal(plan.status, 200);

      const confirm = await call("POST", "/api/bookings/fleet", token, {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        payMethod: "station",
        vehicles: plan.body.vehicles.map((v) => ({ vehiclePlate: v.vehiclePlate, quantity: v.quantity, timeSlot: v.timeSlot })),
      });
      assert.equal(confirm.status, 201, JSON.stringify(confirm.body));
      track(confirm.body);

      assert.equal(confirm.body.bookings.length, 4);
      assert.equal(confirm.body.failures.length, 0);
      assert.match(confirm.body.group.reference, /^FM-FLEET-/);
      assert.equal(confirm.body.group.status, "active");
      assert.equal(confirm.body.group.counts.live, 4);

      // Each is a real, independent booking.
      for (const [i, b] of confirm.body.bookings.entries()) {
        assert.ok(b.bookingId);
        assert.match(b.orderId, /^FM-/);
        assert.equal(b.fleetIndex, i + 1);
        assert.match(String(b.verificationCode), /^\d{4}$/, "its own PIN");
        assert.ok(b.qrCodeData, "its own QR");
        assert.equal(b.paymentStatus, "due_at_station");
        assert.equal(b.status, "upcoming");
      }
      // Distinct PINs, distinct order ids, distinct vehicles.
      assert.equal(new Set(confirm.body.bookings.map((b) => b.orderId)).size, 4);
      assert.equal(new Set(confirm.body.bookings.map((b) => b.vehiclePlate)).size, 4);

      // The station's stock is committed for all four.
      const after = await Station.findById(station._id).select("inventoryCommitted").lean();
      assert.equal(after.inventoryCommitted.petrol, 60);

      // And they show up in the customer's ordinary booking list.
      const mine = await call("GET", "/api/bookings", token);
      assert.equal(mine.body.filter((b) => String(b.fleetGroup) === confirm.body.group.fleetId).length, 4);
    });

    await t.test("a vehicle whose slot was taken in the meantime is the only one that misses out", async () => {
      const user = await makeUser();
      const thief = await makeUser();
      const token = tokenFor(user._id);
      const station = await makeStation({ nozzles: 1 });

      const vehicles = vans(3, 20);
      const plan = await call("POST", "/api/bookings/fleet/plan", token, {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        preferredSlot: "4:00 PM",
        vehicles,
      });
      assert.equal(plan.status, 200);
      const planned = plan.body.vehicles;

      /*
       * Somebody else takes almost all of that window while the customer is
       * looking at the plan.
       *
       * "Almost" is the point. A petrol fill is 40 seconds, so a 30-minute
       * window on one nozzle holds dozens of them and all three vans were
       * planned into the SAME window -- blocking the whole thing would lose
       * every van and prove nothing about partial success. This blocker leaves
       * exactly one fill's worth of room at the end, so one van still gets in
       * and two do not.
       */
      const { windowOf } = require("../src/services/queue/nozzleScheduler");
      const stolen = windowOf(TOMORROW, planned[0].timeSlot);
      const blocker = await Booking.create({
        user: thief._id,
        station: station._id,
        fuelType: "Petrol",
        quantity: 20,
        price: 100,
        amount: 2005,
        bookingDate: TOMORROW,
        timeSlot: planned[0].timeSlot,
        bookingStartTime: stolen.start,
        bookingEndTime: new Date(stolen.end.getTime() - 60_000),
        serviceDurationSeconds: 29 * 60,
        resource: 1,
        status: "upcoming",
        orderId: `FM-2099-${uniq().toUpperCase()}`,
      });
      made.bookings.push(blocker._id);

      const confirm = await call("POST", "/api/bookings/fleet", token, {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        payMethod: "station",
        vehicles: planned.map((v) => ({ vehiclePlate: v.vehiclePlate, quantity: v.quantity, timeSlot: v.timeSlot })),
      });

      // 207: some booked, some not -- and the ones that booked are real.
      assert.equal(confirm.status, 207, JSON.stringify(confirm.body));
      track(confirm.body);
      assert.equal(confirm.body.bookings.length, 1, "what fitted was booked");
      assert.equal(confirm.body.failures.length, 2, "the group was NOT cancelled over the misses");
      assert.ok(confirm.body.failures.every((f) => f.reason === "SLOT_TAKEN"));
      assert.match(confirm.body.failures[0].message, /filled up|was taken/);
      assert.match(confirm.body.summary, /could not be booked/);

      // The group reports what it actually holds.
      const group = await call("GET", `/api/bookings/fleet/${confirm.body.group.fleetId}`, token);
      assert.equal(group.body.counts.total, 1);
      assert.equal(group.body.counts.live, 1);
    });

    await t.test("the same vehicle cannot be confirmed twice, even by racing requests", async () => {
      const user = await makeUser();
      const token = tokenFor(user._id);
      const station = await makeStation({ nozzles: 3 });
      const vehicles = vans(2, 10);
      const payload = {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        payMethod: "station",
        vehicles: vehicles.map((v) => ({ ...v, timeSlot: "6:00 AM" })),
      };

      const [a, b] = await Promise.all([
        call("POST", "/api/bookings/fleet", token, payload),
        call("POST", "/api/bookings/fleet", token, payload),
      ]);
      track(a.body);
      track(b.body);

      // Whatever the interleaving, each van holds exactly one live booking.
      for (const v of vehicles) {
        const live = await Booking.countDocuments({
          user: user._id,
          vehicleKey: v.vehiclePlate.toUpperCase(),
          status: { $in: ["upcoming", "serving", "waitlisted"] },
        });
        assert.equal(live, 1, `${v.vehiclePlate} holds ${live} live bookings`);
      }
    });

    await t.test("each vehicle is cancelled on its own, and the group follows", async () => {
      const user = await makeUser();
      const token = tokenFor(user._id);
      const station = await makeStation({ nozzles: 2 });

      const confirm = await call("POST", "/api/bookings/fleet", token, {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        payMethod: "station",
        vehicles: vans(3, 10).map((v) => ({ ...v, timeSlot: "7:00 AM" })),
      });
      assert.ok([201, 207].includes(confirm.status), JSON.stringify(confirm.body));
      track(confirm.body);
      const booked = confirm.body.bookings;
      assert.ok(booked.length >= 2);

      // The ordinary cancel endpoint, on one member.
      const cancelled = await call("PATCH", `/api/bookings/${booked[0].bookingId}/cancel`, token, {});
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

      const group = await call("GET", `/api/bookings/fleet/${confirm.body.group.fleetId}`, token);
      assert.equal(group.body.counts.cancelled, 1);
      assert.equal(group.body.counts.live, booked.length - 1, "the others are untouched");
      assert.equal(group.body.status, "active");

      // The cancelled van is free to be booked again.
      const again = await call("POST", "/api/bookings/fleet/plan", token, {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        preferredSlot: "8:00 AM",
        vehicles: [{ vehiclePlate: booked[0].vehiclePlate, quantity: 10 }, ...vans(1, 10)],
      });
      const freed = again.body.vehicles.find((v) => v.vehiclePlate === booked[0].vehiclePlate);
      assert.equal(freed.state, "suggested", JSON.stringify(freed));
    });

    await t.test("one vehicle's slot can be changed without moving the others", async () => {
      const user = await makeUser();
      const token = tokenFor(user._id);
      const station = await makeStation({ nozzles: 2 });
      const vehicles = vans(3, 10);

      const plan = await call("POST", "/api/bookings/fleet/plan", token, {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        preferredSlot: "9:00 AM",
        vehicles,
      });
      const planned = plan.body.vehicles;

      const moved = await call("POST", "/api/bookings/fleet/plan-vehicle", token, {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        vehicles: planned,
        vehiclePlate: planned[2].vehiclePlate,
        timeSlot: "1:00 PM",
      });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.equal(moved.body.state, "suggested");
      assert.equal(moved.body.timeSlot, "1:00 PM");
      assert.equal(moved.body.vehiclePlate, planned[2].vehiclePlate);

      // A window the station is not open for, or one in the past, is refused.
      const past = await call("POST", "/api/bookings/fleet/plan-vehicle", token, {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: dateKey(),
        vehicles: planned,
        vehiclePlate: planned[0].vehiclePlate,
        timeSlot: "12:00 AM",
      });
      assert.equal(past.status, 400);
      assert.equal(past.body.reason, "SLOT_PASSED");
    });

    await t.test("a customer sees only their own groups", async () => {
      const mine = await makeUser();
      const theirs = await makeUser();
      const station = await makeStation({ nozzles: 2 });

      const confirm = await call("POST", "/api/bookings/fleet", tokenFor(mine._id), {
        stationId: String(station._id),
        fuelType: "Petrol",
        bookingDate: TOMORROW,
        payMethod: "station",
        vehicles: vans(2, 10).map((v) => ({ ...v, timeSlot: "8:30 AM" })),
      });
      track(confirm.body);
      const id = confirm.body.group.fleetId;

      const other = await call("GET", `/api/bookings/fleet/${id}`, tokenFor(theirs._id));
      assert.equal(other.status, 404, "someone else's group is not found");
      assert.equal((await call("GET", "/api/bookings/fleet", tokenFor(theirs._id))).body.groups.length, 0);
      assert.equal((await call("GET", "/api/bookings/fleet", tokenFor(mine._id))).body.groups.length, 1);
    });

    await t.test("the single-vehicle booking flow is unchanged", async () => {
      const user = await makeUser();
      const token = tokenFor(user._id);
      const station = await makeStation({ nozzles: 2 });

      const one = await call("POST", "/api/bookings", token, {
        stationId: String(station._id),
        fuelType: "Petrol",
        quantity: 10,
        bookingDate: TOMORROW,
        timeSlot: "3:00 PM",
        payMethod: "station",
        vehiclePlate: "MH12SOLO1",
      });
      assert.equal(one.status, 200, JSON.stringify(one.body)); // the contract it has always had
      made.bookings.push(one.body.booking?._id || one.body._id);
      const solo = one.body.booking || one.body;
      assert.equal(solo.fleetGroup ?? null, null, "an ordinary booking carries no group");

      // Still one at a time.
      const second = await call("POST", "/api/bookings", token, {
        stationId: String(station._id),
        fuelType: "Petrol",
        quantity: 10,
        bookingDate: TOMORROW,
        timeSlot: "3:30 PM",
        payMethod: "station",
        vehiclePlate: "MH12SOLO2",
      });
      assert.equal(second.status, 400);
      assert.equal(second.body.reason, "ACTIVE_BOOKING_EXISTS");
    });
  } finally {
    const groupIds = made.groups.filter(Boolean);
    await Promise.all([
      Booking.deleteMany({ $or: [{ _id: { $in: made.bookings.filter(Boolean) } }, { station: { $in: made.stations } }] }),
      FleetBooking.deleteMany({ $or: [{ _id: { $in: groupIds } }, { user: { $in: made.users } }] }),
      Station.deleteMany({ _id: { $in: made.stations } }),
      User.deleteMany({ _id: { $in: made.users } }),
      require("../src/models/Notification").deleteMany({ user: { $in: made.users } }),
    ]);
    server.close();
    await mongoose.disconnect();
  }
});
