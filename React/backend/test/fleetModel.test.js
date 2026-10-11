/**
 * Phase 1 of fleet booking: the data model and its guards.
 *
 * The guard that had to change is the interesting one. "One live booking per
 * customer" was a unique index with no exceptions, and fleet booking is
 * exactly the exception -- five vans are five live bookings. These tests hold
 * both halves of the replacement:
 *
 *   - an ordinary booking is STILL one at a time per customer (including for
 *     bookings written before fleet booking existed, which carry no group
 *     field at all)
 *   - a group's members are allowed alongside each other, but the same vehicle
 *     is not allowed to hold two live slots
 *
 * DEVELOPMENT TEST DATA: users, a station and bookings tagged "[fleet-model]"
 * in the test database only, all removed at the end.
 *
 *   node --test test/fleetModel.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");

const TAG = "[fleet-model]";

test("fleet booking model against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const { User, Station, Booking, FleetBooking } = require("../src/models");
  await require("../src/services/core/schemaIndexes").ensureSchemaIndexes();

  const made = { users: [], stations: [], bookings: [], groups: [] };
  const uniq = () => Math.random().toString(36).slice(2, 10);

  const makeUser = async () => {
    const doc = await User.create({
      name: `${TAG} Fleet owner`,
      email: `fleet.${uniq()}@example.com`,
      password: "x".repeat(60),
    });
    made.users.push(doc._id);
    return doc;
  };

  const station = await Station.create({ name: `${TAG} Depot`, address: `${TAG} Road` });
  made.stations.push(station._id);

  /** A booking for `user`, optionally part of a group and/or for a vehicle. */
  const book = async (user, over = {}) => {
    const doc = await Booking.create({
      user: user._id,
      station: station._id,
      fuelType: "Diesel",
      quantity: 30,
      price: 90,
      amount: 2700,
      bookingDate: "2099-07-07",
      orderId: `FM-2099-${uniq().toUpperCase()}`,
      status: "upcoming",
      ...over,
    });
    made.bookings.push(doc._id);
    return doc;
  };

  const group = async (user, over = {}) => {
    const doc = await FleetBooking.create({
      reference: `FM-FLEET-2099-${uniq().toUpperCase()}`,
      user: user._id,
      station: station._id,
      fuelType: "Diesel",
      bookingDate: "2099-07-07",
      vehicleCount: 3,
      createdBy: user._id,
      ...over,
    });
    made.groups.push(doc._id);
    return doc;
  };

  try {
    await t.test("an ordinary booking is still one at a time per customer", async () => {
      const user = await makeUser();
      await book(user);
      await assert.rejects(() => book(user), (err) => err.code === 11000, "the second is refused");
    });

    await t.test("a booking written before fleet booking existed is still guarded", async () => {
      const user = await makeUser();
      const first = await book(user);
      // Exactly how an older row looks: no fleetGroup field at all.
      await Booking.collection.updateOne({ _id: first._id }, { $unset: { fleetGroup: "" } });
      const legacy = await Booking.collection.findOne({ _id: first._id });
      assert.equal("fleetGroup" in legacy, false, "the field really is absent");

      await assert.rejects(() => book(user), (err) => err.code === 11000);
    });

    await t.test("a group's members live side by side, one per vehicle", async () => {
      const user = await makeUser();
      const fleet = await group(user, { vehicleCount: 5 });

      const plates = ["MH12AB0001", "MH12AB0002", "MH12AB0003", "MH12AB0004", "MH12AB0005"];
      for (const [i, plate] of plates.entries()) {
        await book(user, {
          fleetGroup: fleet._id,
          fleetIndex: i + 1,
          vehiclePlate: plate,
          vehicleKey: plate,
          timeSlot: "10:00 AM",
        });
      }
      assert.equal(await Booking.countDocuments({ fleetGroup: fleet._id, status: "upcoming" }), 5);

      // The same van again, in the same group or any other: refused.
      await assert.rejects(
        () => book(user, { fleetGroup: fleet._id, fleetIndex: 6, vehiclePlate: plates[0], vehicleKey: plates[0] }),
        (err) => err.code === 11000,
        "one live booking per vehicle",
      );
    });

    await t.test("a fleet does not block, and is not blocked by, an ordinary booking", async () => {
      const user = await makeUser();
      const fleet = await group(user);
      await book(user, { fleetGroup: fleet._id, fleetIndex: 1, vehiclePlate: "MH14CD1111", vehicleKey: "MH14CD1111" });
      await book(user, { fleetGroup: fleet._id, fleetIndex: 2, vehiclePlate: "MH14CD2222", vehicleKey: "MH14CD2222" });

      // Their own single booking still works...
      const solo = await book(user, { vehiclePlate: "MH14CD3333", vehicleKey: "MH14CD3333" });
      // ...and is still one at a time.
      await assert.rejects(
        () => book(user, { vehiclePlate: "MH14CD4444", vehicleKey: "MH14CD4444" }),
        (err) => err.code === 11000,
      );
      assert.equal(solo.fleetGroup, null);
    });

    await t.test("cancelling one vehicle frees that vehicle and leaves the rest alone", async () => {
      const user = await makeUser();
      const fleet = await group(user, { vehicleCount: 2 });
      const first = await book(user, { fleetGroup: fleet._id, fleetIndex: 1, vehiclePlate: "MH01EF1111", vehicleKey: "MH01EF1111" });
      await book(user, { fleetGroup: fleet._id, fleetIndex: 2, vehiclePlate: "MH01EF2222", vehicleKey: "MH01EF2222" });

      await Booking.updateOne({ _id: first._id }, { $set: { status: "cancelled", cancelledAt: new Date(), cancelledBy: "customer" } });

      // The other vehicle is untouched...
      assert.equal(await Booking.countDocuments({ fleetGroup: fleet._id, status: "upcoming" }), 1);
      // ...and the cancelled van can be booked again.
      const again = await book(user, { fleetGroup: fleet._id, fleetIndex: 3, vehiclePlate: "MH01EF1111", vehicleKey: "MH01EF1111" });
      assert.equal(again.status, "upcoming");
    });

    await t.test("a group's state is read from its members, never stored", async () => {
      const user = await makeUser();
      const fleet = await group(user, { vehicleCount: 3 });
      const members = [];
      for (let i = 1; i <= 3; i += 1) {
        members.push(
          await book(user, { fleetGroup: fleet._id, fleetIndex: i, vehiclePlate: `MH02GH000${i}`, vehicleKey: `MH02GH000${i}` }),
        );
      }

      const read = async () => FleetBooking.statusOf(await Booking.find({ fleetGroup: fleet._id }).lean());
      assert.equal((await read()).state, "active");

      await Booking.updateOne({ _id: members[0]._id }, { $set: { status: "completed" } });
      assert.equal((await read()).state, "active", "still active while others are live");

      await Booking.updateMany({ fleetGroup: fleet._id, status: "upcoming" }, { $set: { status: "completed" } });
      assert.equal((await read()).state, "completed");

      await Booking.updateOne({ _id: members[2]._id }, { $set: { status: "cancelled" } });
      const mixed = await read();
      assert.equal(mixed.state, "partial", "some completed, some cancelled");
      assert.equal(mixed.completed, 2);
      assert.equal(mixed.cancelled, 1);
    });

    await t.test("a group's reference is unique and its shape is checked", async () => {
      const user = await makeUser();
      const first = await group(user);
      await assert.rejects(() => group(user, { reference: first.reference }), (err) => err.code === 11000);
      await assert.rejects(() => group(user, { bookingDate: "2099-7-7" }), /bookingDate/);
      await assert.rejects(() => group(user, { vehicleCount: 0 }), /vehicleCount/);
    });
  } finally {
    await Promise.all([
      Booking.deleteMany({ _id: { $in: made.bookings } }),
      FleetBooking.deleteMany({ _id: { $in: made.groups } }),
      Station.deleteMany({ _id: { $in: made.stations } }),
      User.deleteMany({ _id: { $in: made.users } }),
    ]);
    await mongoose.disconnect();
  }
});
