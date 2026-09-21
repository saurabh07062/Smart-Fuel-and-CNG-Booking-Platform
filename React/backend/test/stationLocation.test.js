/**
 * Station location, end to end through the real app (src/app.js):
 *
 *   vendor registration keeps the pin dropped on its map (it used to be sent
 *   and silently dropped) -> the vendor's profile carries it -> a station
 *   created with a pin is stored with GeoJSON location [lng, lat] and is found
 *   by a $near query on the 2dsphere index -> moving the pin moves the
 *   location -> a station created without a pin has no location, never (0, 0).
 *
 * DEVELOPMENT TEST DATA, test database only: tagged vendors and their
 * stations, removed at the end.
 *
 *   node --test test/stationLocation.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const testDb = require("./helpers/testDb");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("station location persistence against MongoDB", async (t) => {
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
  const InventoryMovement = require("../src/models/InventoryMovement");
  const vendorPanel = require("../src/controllers/vendorPanelController");
  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const tag = `stationloc-${Date.now()}`;
  const tokenFor = (id) =>
    jwt.sign({ user: { id: String(id) } }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "30m" });
  const call = async (method, route, { token, body } = {}) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { "x-auth-token": token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const register = (suffix, extra) =>
    call("POST", "/api/vendors/register", {
      body: {
        name: `${tag}-${suffix}`,
        email: `${tag}-${suffix}@example.com`,
        password: "Vendor@12345",
        businessName: `${tag} ${suffix} Fuels`,
        phone: "9000000000",
        vendorAddress: "Location Test Road, Pune",
        products: "petrol,diesel,cng",
        ...extra,
      },
    });

  try {
    await t.test("vendor registration keeps the pin dropped on the map", async () => {
      // Multipart registration sends the pin as strings.
      const r = await register("pinned", { latitude: "18.5913", longitude: "73.7389" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const vendor = await User.findOne({ email: `${tag}-pinned@example.com` }).lean();
      assert.deepEqual(vendor.registrationLocation, { lat: 18.5913, lng: 73.7389 });
    });

    await t.test("a (0, 0), out-of-range or junk pin is not stored", async () => {
      for (const [suffix, pin] of [
        ["zero", { latitude: "0", longitude: "0" }],
        ["range", { latitude: "123", longitude: "73.7" }],
        ["junk", { latitude: "abc", longitude: "" }],
      ]) {
        const r = await register(suffix, pin);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const vendor = await User.findOne({ email: `${tag}-${suffix}@example.com` }).lean();
        assert.equal(vendor.registrationLocation, undefined, suffix);
      }
    });

    await t.test("the approved vendor's profile carries the registration pin", async () => {
      const vendor = await User.findOneAndUpdate(
        { email: `${tag}-pinned@example.com` },
        { $set: { vendorStatus: "active", activated: true } },
        { returnDocument: "after" },
      );
      const r = await call("GET", "/api/vendor-panel/profile", { token: tokenFor(vendor._id) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.registrationLocation, { lat: 18.5913, lng: 73.7389 });
    });

    let stationId;
    await t.test("a station created with a pin is stored as GeoJSON and found by nearest search", async () => {
      const vendor = await User.findOne({ email: `${tag}-pinned@example.com` });
      const r = await call("POST", "/api/vendor-panel/stations", {
        token: tokenFor(vendor._id),
        body: { name: `${tag}-station`, address: "Location Test Road, Pune", coordinates: { lat: 18.6011, lng: 73.7412 } },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      stationId = r.body._id;

      const doc = await Station.findById(stationId).lean();
      assert.deepEqual(doc.coordinates, { lat: 18.6011, lng: 73.7412 });
      assert.equal(doc.location.type, "Point");
      assert.deepEqual(doc.location.coordinates, [73.7412, 18.6011], "GeoJSON order is [lng, lat]");

      await Station.init(); // the schema's indexes, including 2dsphere on location
      const indexes = await Station.collection.indexes();
      assert.ok(indexes.some((i) => i.key?.location === "2dsphere"), "2dsphere index on location");

      const near = await Station.find({
        _id: stationId,
        location: { $near: { $geometry: { type: "Point", coordinates: [73.741, 18.601] }, $maxDistance: 1000 } },
      }).lean();
      assert.equal(near.length, 1, "found within 1 km of a nearby point");
    });

    await t.test("moving the pin moves the GeoJSON location", async () => {
      const vendor = await User.findOne({ email: `${tag}-pinned@example.com` });
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await vendorPanel.updateStation(
        {
          params: { id: stationId },
          user: { id: String(vendor._id), role: "vendor" },
          body: { coordinates: { lat: 18.5204, lng: 73.8567 } },
          app: { get: () => null },
        },
        res,
      );
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      const doc = await Station.findById(stationId).lean();
      assert.deepEqual(doc.location.coordinates, [73.8567, 18.5204]);
    });

    await t.test("a station created without a pin has no location at all, never (0, 0)", async () => {
      const vendor = await User.findOne({ email: `${tag}-pinned@example.com` });
      const r = await call("POST", "/api/vendor-panel/stations", {
        token: tokenFor(vendor._id),
        body: { name: `${tag}-nopin`, address: "Somewhere, Pune", coordinates: { lat: 0, lng: 0 } },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const doc = await Station.findById(r.body._id).lean();
      assert.equal(doc.location, undefined);
      assert.equal(doc.coordinates, undefined);
    });

    await t.test("typed coordinates out of range are refused with a reason, and nothing is created", async () => {
      const vendor = await User.findOne({ email: `${tag}-pinned@example.com` });
      const cases = [
        [{ lat: 95, lng: 73.8 }, /Latitude/],
        [{ lat: -90.5, lng: 73.8 }, /Latitude/],
        [{ lat: 18.5, lng: 181 }, /Longitude/],
        [{ lat: "abc", lng: 73.8 }, /Latitude/],
        [{ lat: 18.5 }, /both latitude and longitude/],
      ];
      for (const [coordinates, reason] of cases) {
        const r = await call("POST", "/api/vendor-panel/stations", {
          token: tokenFor(vendor._id),
          body: { name: `${tag}-badpin`, address: "Somewhere, Pune", coordinates },
        });
        assert.equal(r.status, 400, `${JSON.stringify(coordinates)} -> ${JSON.stringify(r.body)}`);
        assert.match(r.body.msg, reason);
      }
      assert.equal(await Station.countDocuments({ name: `${tag}-badpin` }), 0);
    });

    await t.test("the vendor edits the station: details and location saved, GeoJSON follows, search finds the new spot", async () => {
      const vendor = await User.findOne({ email: `${tag}-pinned@example.com` });
      const r = await call("PUT", `/api/vendor-panel/stations/${stationId}`, {
        token: tokenFor(vendor._id),
        body: {
          name: `${tag}-edited`,
          address: "Nagar Road, Wagholi",
          openingHours: "06:00-22:00",
          fuelTypes: ["Petrol", "Diesel"],
          coordinates: { lat: 18.580563, lng: 73.975342 },
        },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const doc = await Station.findById(stationId).lean();
      assert.equal(doc.name, `${tag}-edited`);
      assert.equal(doc.address, "Nagar Road, Wagholi");
      assert.equal(doc.openingHours, "06:00-22:00");
      assert.deepEqual(doc.fuelTypes, ["Petrol", "Diesel"]);
      assert.deepEqual(doc.coordinates, { lat: 18.580563, lng: 73.975342 });
      assert.deepEqual(doc.location.coordinates, [73.975342, 18.580563], "GeoJSON location moved with the pin");
      const near = await Station.find({
        _id: stationId,
        location: { $near: { $geometry: { type: "Point", coordinates: [73.975342, 18.580563] }, $maxDistance: 50 } },
      }).lean();
      assert.equal(near.length, 1, "found at the corrected spot");
    });

    await t.test("a form opened before the station changed cannot overwrite it (409), a current one can", async () => {
      const vendor = await User.findOne({ email: `${tag}-pinned@example.com` });
      const opened = (await Station.findById(stationId).lean()).updatedAt;

      // Someone saves the correct location meanwhile.
      await new Promise((r) => setTimeout(r, 5));
      const fix = await call("PUT", `/api/vendor-panel/stations/${stationId}`, {
        token: tokenFor(vendor._id),
        body: { coordinates: { lat: 18.5805621, lng: 73.9753407 }, expectedUpdatedAt: opened },
      });
      assert.equal(fix.status, 200, JSON.stringify(fix.body));

      // The stale form tries to save its old pin.
      const stale = await call("PUT", `/api/vendor-panel/stations/${stationId}`, {
        token: tokenFor(vendor._id),
        body: { coordinates: { lat: 18.582535, lng: 73.975371 }, expectedUpdatedAt: opened },
      });
      assert.equal(stale.status, 409, JSON.stringify(stale.body));
      assert.equal(stale.body.reason, "STALE_EDIT");
      assert.deepEqual((await Station.findById(stationId).lean()).coordinates, { lat: 18.5805621, lng: 73.9753407 }, "the correct location survives");

      await Station.updateOne({ _id: stationId }, { $set: { coordinates: { lat: 18.580563, lng: 73.975342 }, location: { type: "Point", coordinates: [73.975342, 18.580563] } } });
    });

    await t.test("an edit is refused like a new station would be, and nothing changes", async () => {
      const vendor = await User.findOne({ email: `${tag}-pinned@example.com` });
      const before = await Station.findById(stationId).lean();
      const cases = [
        [{ coordinates: { lat: 95, lng: 73.9 } }, /Latitude/],
        [{ coordinates: { lat: 18.58 } }, /both latitude and longitude/],
        [{ coordinates: { lat: 0, lng: 0 } }, /real location/],
        [{ name: "   " }, /name cannot be empty/],
        [{ fuelTypes: [] }, /Select at least one fuel/],
      ];
      for (const [body, reason] of cases) {
        const r = await call("PUT", `/api/vendor-panel/stations/${stationId}`, { token: tokenFor(vendor._id), body });
        assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${JSON.stringify(r.body)}`);
        assert.match(r.body.msg, reason);
      }
      const after = await Station.findById(stationId).lean();
      assert.deepEqual(after.coordinates, before.coordinates);
      assert.equal(after.name, before.name);
    });

    await t.test("a vendor registered for Petrol only cannot add CNG by editing", async () => {
      const vendor = await User.findOneAndUpdate(
        { email: `${tag}-pinned@example.com` },
        { $set: { vendorFuelTypes: ["petrol"] } },
        { returnDocument: "after" },
      );
      const r = await call("PUT", `/api/vendor-panel/stations/${stationId}`, {
        token: tokenFor(vendor._id),
        body: { fuelTypes: ["Petrol", "CNG"] },
      });
      assert.equal(r.status, 400);
      assert.match(r.body.msg, /CNG cannot be added/);
      await User.updateOne({ _id: vendor._id }, { $unset: { vendorFuelTypes: "" } });
    });

    await t.test("another vendor cannot edit the station", async () => {
      const r0 = await register("intruder", { latitude: "18.5", longitude: "73.8" });
      assert.equal(r0.status, 200, JSON.stringify(r0.body));
      const intruder = await User.findOneAndUpdate(
        { email: `${tag}-intruder@example.com` },
        { $set: { vendorStatus: "active", activated: true } },
        { returnDocument: "after" },
      );
      const r = await call("PUT", `/api/vendor-panel/stations/${stationId}`, {
        token: tokenFor(intruder._id),
        body: { coordinates: { lat: 19, lng: 72.8 } },
      });
      assert.equal(r.status, 404);
      assert.deepEqual((await Station.findById(stationId).lean()).coordinates, { lat: 18.580563, lng: 73.975342 });
    });

    await t.test("the range limits themselves are accepted and stored exactly", async () => {
      const vendor = await User.findOne({ email: `${tag}-pinned@example.com` });
      const r = await call("POST", "/api/vendor-panel/stations", {
        token: tokenFor(vendor._id),
        body: { name: `${tag}-edge`, address: "Somewhere", coordinates: { lat: -89.9999999, lng: 179.9999999 } },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const doc = await Station.findById(r.body._id).lean();
      assert.deepEqual(doc.location.coordinates, [179.9999999, -89.9999999]);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const vendors = await User.find({ email: { $regex: `^${tag}-` } }).select("_id").lean();
    const owners = vendors.map((v) => v._id);
    const stations = await Station.find({ owner: { $in: owners } }).select("_id").lean();
    await InventoryMovement.deleteMany({ station: { $in: stations.map((s) => s._id) } });
    await Station.deleteMany({ owner: { $in: owners } });
    await User.deleteMany({ _id: { $in: owners } });
    await mongoose.disconnect();
  }
});
