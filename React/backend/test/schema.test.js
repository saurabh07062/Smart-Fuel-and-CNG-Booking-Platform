/**
 * The schema itself: validation, uniqueness, relationships and indexes.
 *
 * What these tests are for -- every rule added to the models is a promise about
 * what can reach the database. This checks the promises hold from the outside:
 * an invalid record is refused, a duplicate cannot be written twice, a
 * reference is declared, and a document that was stored before a rule existed
 * can still be saved (models/shared/fieldValidators.js explains why that last
 * one matters -- a strict rule applied to every path on every save would make
 * old real records unsaveable, which would break approving a vendor who
 * registered before the rule existed).
 *
 * DEVELOPMENT TEST DATA: users, stations, employees and bookings tagged
 * "[schema-test]" in the test database only, all removed at the end.
 *
 *   node --test test/schema.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const TAG = "[schema-test]";

test("schema rules against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const { models, RELATIONS } = require("../src/models");
  const { User, Station, Booking, Employee } = models;

  // Indexes have to exist before a uniqueness test means anything.
  const { built, failed } = await require("../src/services/core/schemaIndexes").ensureSchemaIndexes();

  const made = { users: [], stations: [], employees: [], bookings: [] };
  const uniq = () => Math.random().toString(36).slice(2, 10);

  const makeUser = async (extra = {}) => {
    const doc = await User.create({
      name: `${TAG} Person`,
      email: `schema.${uniq()}@example.com`,
      password: "x".repeat(60),
      ...extra,
    });
    made.users.push(doc._id);
    return doc;
  };

  const makeStation = async (extra = {}) => {
    const doc = await Station.create({ name: `${TAG} Pump`, address: `${TAG} Road, Pune`, ...extra });
    made.stations.push(doc._id);
    return doc;
  };

  /** A booking for a brand-new customer, so the one-live-booking guard is not what fails. */
  const makeBooking = async (extra = {}) => {
    const user = await makeUser();
    const station = await makeStation();
    const doc = await Booking.create({
      user: user._id,
      station: station._id,
      fuelType: "Petrol",
      quantity: 10,
      price: 100,
      amount: 1000,
      bookingDate: "2099-01-01",
      orderId: `FM-2099-${uniq().toUpperCase()}`,
      ...extra,
    });
    made.bookings.push(doc._id);
    return doc;
  };

  try {
    await t.test("every index the models declare is built", () => {
      assert.equal(
        failed.length,
        0,
        `these collections' indexes did not build: ${failed.map((f) => `${f.model} (${f.kind}: ${f.error})`).join("; ")}`,
      );
      assert.equal(built.length, Object.keys(models).length);
    });

    await t.test("an email is one account, whatever case it is typed in", async () => {
      const address = `Schema.Mixed.${uniq()}@Example.COM`;
      const user = await makeUser({ email: address });
      assert.equal(user.email, address.toLowerCase(), "stored lowercase");

      await assert.rejects(
        () => makeUser({ email: address.toUpperCase() }),
        (err) => err.code === 11000,
        "the same address in another case is refused by the unique index",
      );
    });

    await t.test("a user's phone and GSTIN must be real when they are written", async () => {
      await assert.rejects(() => makeUser({ phone: "12345" }), /10-digit/);
      await assert.rejects(() => makeUser({ role: "vendor", gstNumber: "NOTAGST" }), /GSTIN/);
      const ok = await makeUser({ phone: "9876543210", role: "vendor", gstNumber: "27aapfu0939f1zv" });
      assert.equal(ok.gstNumber, "27AAPFU0939F1ZV", "stored upper case");
      assert.ok(ok.createdAt instanceof Date && ok.updatedAt instanceof Date, "timestamps recorded");
    });

    await t.test("a record stored before a rule existed can still be saved", async () => {
      // Exactly the situation these write-scoped validators exist for: a vendor
      // whose phone was stored in an older format, being approved today.
      const legacy = await makeUser({ role: "vendor", vendorStatus: "pending" });
      await User.collection.updateOne({ _id: legacy._id }, { $set: { phone: "+91 98765 43210" } });

      const reloaded = await User.findById(legacy._id);
      reloaded.vendorStatus = "active";
      await reloaded.save(); // must not fail on the untouched legacy phone
      assert.equal((await User.findById(legacy._id)).vendorStatus, "active");

      // Changing the number, though, is held to the rule.
      reloaded.phone = "98765";
      await assert.rejects(() => reloaded.save(), /10-digit/);
    });

    await t.test("a wallet or reward balance cannot go negative", async () => {
      const user = await makeUser();
      user.wallet = -1;
      await assert.rejects(() => user.save(), /wallet/);
    });

    await t.test("a station starts with no invented rating and no invented price", async () => {
      const station = await makeStation();
      assert.equal(station.rating, null, "a station nobody has rated has no rating");
      assert.equal(station.prices.petrol, null, "no price until one is published");
      assert.equal(station.inventory.petrol, 0);
      assert.ok(station.createdAt instanceof Date);
    });

    await t.test("a station's opening times must be a real clock time", async () => {
      const station = await makeStation();
      station.operatingSchedule.monday.is24h = false;
      station.operatingSchedule.monday.open = "6am";
      await assert.rejects(() => station.save(), /HH:MM/);
      station.operatingSchedule.monday.open = "06:00";
      await station.save();
    });

    await t.test("a station's contact number is a 10-digit number or nothing", async () => {
      const station = await makeStation();
      station.contactPhone = "020-1234";
      await assert.rejects(() => station.save(), /10-digit/);
      station.contactPhone = ""; // "not recorded" is allowed; a wrong number is not
      await station.save();
    });

    await t.test("one staff phone number per vendor, and staff belong to a vendor", async () => {
      const vendor = await makeUser({ role: "vendor" });
      const other = await makeUser({ role: "vendor" });
      const phone = "9812345678";

      const first = await Employee.create({ vendor: vendor._id, name: `${TAG} Attendant`, phone });
      made.employees.push(first._id);

      await assert.rejects(
        () => Employee.create({ vendor: vendor._id, name: `${TAG} Twin`, phone }),
        (err) => err.code === 11000,
        "the same number twice on one vendor's staff",
      );

      // The same number under a different vendor is a different person's record.
      const elsewhere = await Employee.create({ vendor: other._id, name: `${TAG} Elsewhere`, phone });
      made.employees.push(elsewhere._id);
      assert.equal(String(elsewhere.vendor), String(other._id));

      await assert.rejects(
        () => Employee.create({ name: `${TAG} Ownerless`, phone: "9800000000" }),
        /vendor/,
        "a staff record with no vendor is not a record",
      );

      await assert.rejects(
        () => Employee.create({ vendor: vendor._id, name: `${TAG} Bad email`, phone: "9800000001", email: "nope@nope" }),
        /email/,
      );
    });

    await t.test("a booking's figures and its date key are checked", async () => {
      await makeBooking(); // the shape that is accepted

      await assert.rejects(() => makeBooking({ amount: -5 }), /amount/);
      await assert.rejects(() => makeBooking({ quantity: 0 }), /quantity/);
      await assert.rejects(
        () => makeBooking({ bookingDate: "2099-1-1" }),
        /bookingDate/,
        "a date key that would never match a day's query again",
      );
      await assert.rejects(() => makeBooking({ verificationCode: "12" }), /verificationCode/);
      await assert.rejects(() => makeBooking({ bookedForPhone: "12345" }), /mobile number/);
    });

    await t.test("two bookings never share an order reference", async () => {
      const orderId = `FM-2099-${uniq().toUpperCase()}`;
      await makeBooking({ orderId });
      await assert.rejects(() => makeBooking({ orderId }), (err) => err.code === 11000);
    });

    await t.test("only one live booking per customer, whatever races", async () => {
      const first = await makeBooking();
      const again = () =>
        Booking.create({
          user: first.user,
          station: first.station,
          fuelType: "CNG",
          quantity: 4,
          price: 80,
          amount: 320,
          bookingDate: "2099-03-03",
          orderId: `FM-2099-${uniq().toUpperCase()}`,
        });
      await assert.rejects(again, (err) => err.code === 11000);
    });

    await t.test("every reference in every schema is declared in RELATIONS", () => {
      const declared = new Set(RELATIONS.map((r) => `${r.model}.${r.path}`));
      const undeclared = [];
      for (const [name, model] of Object.entries(models)) {
        model.schema.eachPath((p, type) => {
          const ref = type.options?.ref || type.caster?.options?.ref;
          // Only top-level references: a subdocument's ref (a station review's
          // author) lives and dies with its parent, so it cannot be orphaned
          // the way a collection-to-collection reference can.
          if (ref && !p.includes(".") && !declared.has(`${name}.${p}`)) {
            undeclared.push(`${name}.${p} -> ${ref}`);
          }
        });
      }
      assert.deepEqual(
        undeclared,
        [],
        "add these to RELATIONS in src/models/index.js so the audit can check them for orphans",
      );
    });

    await t.test("every model records when a document was created and changed", () => {
      for (const [name, model] of Object.entries(models)) {
        if (name === "Counter") continue; // a named sequence, not a record
        assert.ok(model.schema.path("createdAt"), `${name} has no createdAt`);
        assert.ok(model.schema.path("updatedAt"), `${name} has no updatedAt`);
      }
    });
  } finally {
    await Promise.all([
      User.deleteMany({ _id: { $in: made.users } }),
      Station.deleteMany({ _id: { $in: made.stations } }),
      Employee.deleteMany({ _id: { $in: made.employees } }),
      Booking.deleteMany({ _id: { $in: made.bookings } }),
    ]);
    await mongoose.disconnect();
  }
});
