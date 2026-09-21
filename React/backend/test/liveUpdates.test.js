/**
 * Live updates without a refresh, scenario by scenario, through the real API
 * and real sockets (the test server on TEST_API_URL, test database).
 *
 * Five screens are simulated by socket clients:
 *   list      a customer on the station list / dashboard (watches nothing)
 *   watcher   a customer on one station's page (watch_station)
 *   customer  the signed-in customer who owns the bookings
 *   vendor    the station's owner in the vendor panel
 *   admin     an admin in the admin panel
 * plus `otherVendor`, who must never receive this vendor's private events.
 *
 * Each scenario performs one real action and checks that every screen that
 * shows that data receives an event carrying the new state.
 *
 * DEVELOPMENT TEST DATA, test database only: tagged users, stations and
 * bookings, removed at the end.
 *
 *   node --test test/liveUpdates.test.js      (test server must be running)
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const API = require("./helpers/testDb").apiUrl();
const MONGO = require("./helpers/testDb").uri();

const WAIT_MS = 5000;

test("live updates reach every screen without a refresh", async (t) => {
  const reachable = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    t.skip(`API not reachable at ${API} -- start the test server to run this test`);
    return;
  }

  const ioClient = require("socket.io-client");
  const mongoose = require("mongoose");
  const bcrypt = require("bcryptjs");
  const jwt = require("jsonwebtoken");
  await mongoose.connect(MONGO);
  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const Booking = require("../src/models/Booking");

  const tag = `live-${Date.now()}`;
  const sockets = [];
  const results = [];

  const mkUser = async (suffix, role, extra = {}) =>
    User.create({
      name: `${tag}-${suffix}`,
      email: `${tag}-${suffix}@fuelmart.test`,
      password: await bcrypt.hash("livetest12345", 8),
      role,
      isVerified: true,
      ...extra,
    });
  const tokenFor = (u) => jwt.sign({ user: { id: String(u._id) } }, process.env.JWT_SECRET, { expiresIn: "30m" });

  const call = async (method, route, token, body) => {
    const res = await fetch(`${API}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { "x-auth-token": token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const connect = (token) =>
    new Promise((resolve, reject) => {
      const sock = ioClient(API, { auth: token ? { token } : {}, reconnection: false, transports: ["websocket"] });
      sockets.push(sock);
      sock.on("connect", () => resolve(sock));
      sock.on("connect_error", reject);
      setTimeout(() => reject(new Error("socket connect timed out")), 5000);
    });

  /** Every event a socket receives, so a scenario can look back at what arrived after it started. */
  const recorder = (sock) => {
    const got = [];
    sock.onAny((event, payload) => got.push({ event, payload, at: Date.now() }));
    return got;
  };

  /**
   * Run `action`, then wait until every screen in `expect` has received a
   * matching event (or WAIT_MS passes). `expect`: { screen: [event, predicate?] }.
   * `never`: { screen: [event, predicate?] } that must NOT arrive.
   */
  const scenario = (name, action, expect, never = {}) =>
    t.test(name, async () => {
      const started = Date.now();
      await action();
      const matches = (screen, [event, pred]) =>
        screens[screen].some((g) => g.at >= started && g.event === event && (!pred || pred(g.payload)));

      const deadline = started + WAIT_MS;
      while (Date.now() < deadline && !Object.entries(expect).every(([s, e]) => matches(s, e))) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 300)); // let any stray event land for the `never` checks

      const missing = Object.entries(expect)
        .filter(([s, e]) => !matches(s, e))
        .map(([s, [ev]]) => `${s} did not get ${ev}`);
      const leaked = Object.entries(never)
        .filter(([s, e]) => matches(s, e))
        .map(([s, [ev]]) => `${s} wrongly got ${ev}`);
      results.push({ name, ok: missing.length === 0 && leaked.length === 0, problems: [...missing, ...leaked] });
      assert.deepEqual([...missing, ...leaked], [], name);
    });

  const idIs = (id) => (p) => String(p?._id ?? p?.id ?? p?.stationId ?? "") === String(id);

  let station;
  let screens;
  try {
    const admin = await mkUser("admin", "admin");
    const vendor = await mkUser("vendor", "vendor", { vendorStatus: "active", activated: true, businessName: `${tag} Fuels` });
    const otherVendor = await mkUser("other", "vendor", { vendorStatus: "active", activated: true });
    const customer = await mkUser("cust", "customer");

    station = await Station.create({
      name: `${tag}-station`,
      address: "Live Road, Pune",
      owner: vendor._id,
      coordinates: { lat: 18.52, lng: 73.85 },
      fuelTypes: ["Petrol", "Diesel"],
      prices: { petrol: 100, diesel: 90, cng: null },
      inventory: { petrol: 50000, diesel: 50000, cng: 0 },
      status: "Active",
    });
    const S = String(station._id);

    const list = await connect(null);
    const watcher = await connect(null);
    watcher.emit("watch_station", S);
    const customerSock = await connect(tokenFor(customer));
    const vendorSock = await connect(tokenFor(vendor));
    const adminSock = await connect(tokenFor(admin));
    const otherSock = await connect(tokenFor(otherVendor));
    screens = {
      list: recorder(list),
      watcher: recorder(watcher),
      customer: recorder(customerSock),
      vendor: recorder(vendorSock),
      admin: recorder(adminSock),
      otherVendor: recorder(otherSock),
    };
    await new Promise((r) => setTimeout(r, 800)); // identity rooms joined

    const vt = tokenFor(vendor);
    const at = tokenFor(admin);
    const ct = tokenFor(customer);

    // ------------------------------------------------------------- stations
    let createdId;
    await scenario(
      "vendor adds a station -> customer lists, vendor panel, admin",
      async () => {
        const r = await call("POST", "/api/vendor-panel/stations", vt, { name: `${tag}-new`, address: "New Road", prices: { petrol: 101 } });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        createdId = r.body._id;
      },
      {
        list: ["station:created", (p) => String(p._id) === String(createdId)],
        vendor: ["station:created"],
        admin: ["station:created"],
      },
      { otherVendor: ["station:created", (p) => p.owner !== undefined] },
    );

    await scenario(
      "vendor edits station details -> everyone showing it",
      async () => {
        const r = await call("PUT", `/api/vendor-panel/stations/${S}`, vt, { name: `${tag}-renamed` });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      },
      {
        list: ["station:updated", (p) => p.name === `${tag}-renamed`],
        watcher: ["station:updated", (p) => p.name === `${tag}-renamed`],
        vendor: ["station:updated"],
        admin: ["station:updated"],
      },
    );

    await scenario(
      "vendor changes a price -> lists, station page, vendor, admin",
      async () => {
        const r = await call("PUT", `/api/vendor-panel/stations/${S}/price`, vt, { fuelType: "Petrol", newPrice: 104.5 });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      },
      {
        list: ["fuelPrice:updated", (p) => Number(p.newPrice) === 104.5],
        watcher: ["fuelPrice:updated"],
        vendor: ["fuelPrice:updated"],
        admin: ["fuelPrice:updated"],
      },
    );

    await scenario(
      "vendor records a stock delivery -> vendor panel, admin, customers (availability)",
      async () => {
        const r = await call("PUT", `/api/vendor-panel/stations/${S}/inventory`, vt, { fuelType: "Diesel", quantity: 500 });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      },
      { vendor: ["inventory:updated"], admin: ["inventory:updated"], list: ["station:updated", idIs(S)] },
      { list: ["inventory:updated", (p) => p.inventory !== undefined] },
    );

    await scenario(
      "vendor turns the station off -> customers see it closed",
      async () => {
        const r = await call("PATCH", `/api/vendor-panel/stations/${S}/toggle-status`, vt);
        assert.equal(r.status, 200, JSON.stringify(r.body));
      },
      { list: ["station:updated", (p) => p.status === "Inactive"], watcher: ["station:updated", (p) => p.status === "Inactive"], vendor: ["station:updated"] },
    );
    await call("PATCH", `/api/vendor-panel/stations/${S}/toggle-status`, vt); // back on

    await scenario(
      "admin edits a station -> customers and its vendor",
      async () => {
        const r = await call("PUT", `/api/stations/${S}`, at, { address: "Admin Road, Pune" });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      },
      { list: ["station:updated", (p) => p.address === "Admin Road, Pune"], vendor: ["station:updated"], admin: ["station:updated"] },
    );

    // ------------------------------------------------------------- bookings
    const book = async () => {
      const r = await call("POST", "/api/bookings", ct, {
        stationId: S,
        fuelType: "Petrol",
        quantity: 5,
        bookingDate: "2099-12-01",
        timeSlot: "10:00 AM",
        payMethod: "station",
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return String(r.body.booking._id);
    };

    let b1;
    await scenario(
      "customer books -> their dashboard, vendor, admin; queue to station watchers",
      async () => {
        b1 = await book();
      },
      {
        customer: ["booking:created", (p) => String(p._id) === b1],
        vendor: ["booking:created", (p) => String(p._id) === b1],
        admin: ["booking:created"],
        watcher: ["queue:updated"],
      },
      { list: ["booking:created"], otherVendor: ["booking:created"] },
    );

    await scenario(
      "admin cancels the order -> customer, vendor, admin",
      async () => {
        const r = await call("PATCH", `/api/v1/admin/orders/${b1}/status`, at, { status: "cancelled" });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      },
      {
        customer: ["booking:cancelled", (p) => String(p._id) === b1 && p.status === "cancelled"],
        vendor: ["booking:cancelled"],
        admin: ["booking:cancelled"],
      },
    );

    await scenario(
      "admin deletes the finished order -> customer, vendor, admin",
      async () => {
        const r = await call("DELETE", `/api/v1/admin/orders/${b1}`, at);
        assert.equal(r.status, 200, JSON.stringify(r.body));
      },
      { customer: ["booking:updated", (p) => String(p._id) === b1], vendor: ["booking:updated"], admin: ["booking:updated"] },
    );

    let b2;
    await scenario(
      "customer cancels their own booking -> vendor and admin",
      async () => {
        b2 = await book();
        const r = await call("PATCH", `/api/bookings/${b2}/cancel`, ct);
        assert.equal(r.status, 200, JSON.stringify(r.body));
      },
      { vendor: ["booking:cancelled", (p) => String(p._id) === b2], admin: ["booking:cancelled"], customer: ["booking:cancelled"] },
    );

    let b3;
    await scenario(
      "order marked completed -> customer, vendor (revenue), admin",
      async () => {
        b3 = await book();
        const r = await call("PATCH", `/api/v1/admin/orders/${b3}/status`, at, { status: "completed" });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      },
      {
        customer: ["booking:updated", (p) => String(p._id) === b3 && p.status === "completed"],
        vendor: ["booking:updated", (p) => String(p._id) === b3],
        admin: ["booking:updated"],
      },
    );

    await scenario(
      "vendor collects payment at the pump -> customer sees PAID, admin revenue",
      async () => {
        const r = await call("PATCH", `/api/vendor-panel/stations/${S}/bookings/${b3}/collect`, vt);
        assert.equal(r.status, 200, JSON.stringify(r.body));
      },
      {
        customer: ["booking:updated", (p) => String(p._id) === b3 && p.paymentStatus === "paid"],
        admin: ["booking:updated", (p) => p.paymentStatus === "paid"],
        vendor: ["booking:updated"],
      },
    );

    // ---------------------------------------------------- vendor accounts
    let applicantId;
    await scenario(
      "a vendor applies -> admins see the new application",
      async () => {
        const r = await call("POST", "/api/vendors/register", null, {
          name: `${tag}-applicant`,
          email: `${tag}-applicant@fuelmart.test`,
          password: "Vendor@12345",
          businessName: `${tag} Applicant`,
          phone: "9000000000",
          vendorAddress: "Apply Road",
          products: "petrol",
        });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        applicantId = r.body.user.id;
      },
      { admin: ["vendor:requestCreated", (p) => String(p.vendorId ?? p._id ?? p.id) === String(applicantId)] },
      { list: ["vendor:requestCreated"], customer: ["vendor:requestCreated"] },
    );

    await scenario(
      "admin rejects an application -> admins and the applicant's tracking page",
      async () => {
        const r = await call("PATCH", `/api/vendors/${applicantId}/reject`, at, { reason: "test" });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      },
      { admin: ["vendor:statusChanged", (p) => p.vendorStatus === "rejected"] },
      { list: ["vendor:statusChanged"], customer: ["vendor:statusChanged"], otherVendor: ["vendor:statusChanged"] },
    );

    await scenario(
      "admin suspends a vendor -> their stations close for customers, vendor and admins told",
      async () => {
        const r = await call("PATCH", `/api/vendors/${vendor._id}/suspend`, at, { reason: "test" });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      },
      {
        list: ["station:updated", (p) => idIs(S)(p) && p.status === "Inactive"],
        admin: ["vendor:statusChanged", (p) => p.vendorStatus === "suspended"],
        vendor: ["vendor:statusChanged", (p) => p.vendorStatus === "suspended"],
      },
    );

    await scenario(
      "admin reactivates the vendor -> stations reopen for customers",
      async () => {
        const r = await call("PATCH", `/api/vendors/${vendor._id}/reactivate`, at);
        assert.equal(r.status, 200, JSON.stringify(r.body));
      },
      {
        list: ["station:updated", (p) => idIs(S)(p) && p.status === "Active"],
        admin: ["vendor:statusChanged", (p) => p.vendorStatus === "active"],
      },
    );

    // --------------------------------------------------- station removal
    await scenario(
      "admin deletes a station -> removed from customer lists and the vendor panel",
      async () => {
        const r = await call("DELETE", `/api/stations/${createdId}`, at);
        assert.equal(r.status, 200, JSON.stringify(r.body));
      },
      {
        list: ["station:deleted", (p) => String(p.id) === String(createdId)],
        vendor: ["station:deleted", (p) => String(p.id) === String(createdId)],
        admin: ["station:deleted"],
      },
    );
  } finally {
    // The matrix, for the report.
    console.log("\nLIVE UPDATE MATRIX");
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n        ${r.problems.join("\n        ")}`}`);

    sockets.forEach((s) => s.close());
    const users = await User.find({ email: { $regex: `^${tag}-` } }).select("_id").lean();
    const ids = users.map((u) => u._id);
    const stations = await Station.find({ owner: { $in: ids } }).select("_id").lean();
    const stationIds = stations.map((s) => s._id);
    await Booking.deleteMany({ $or: [{ user: { $in: ids } }, { station: { $in: stationIds } }] });
    await require("../src/models/BookingAttempt").deleteMany({ user: { $in: ids } });
    await require("../src/models/Notification").deleteMany({ user: { $in: ids } });
    await require("../src/models/InventoryMovement").deleteMany({ station: { $in: stationIds } });
    await require("../src/models/PriceHistory").deleteMany({ station: { $in: stationIds } });
    await Station.deleteMany({ _id: { $in: stationIds } });
    await User.deleteMany({ _id: { $in: ids } });
    await mongoose.disconnect();
  }
});
