/**
 * Real-time layer: authentication, room isolation, and delivery.
 *
 * Runs against the live server with real Socket.IO clients.
 *
 * IMPORTANT -- WHY EVERY EMIT HERE GOES THROUGH THE HTTP API
 *
 * An earlier version of this file called realtime.toAdmins(...) directly and
 * then asserted on what arrived. That proved nothing: services/notification/realtime.js
 * holds its `io` reference in module state, set by init() in the SERVER
 * process. Required from the test process it is a separate module instance
 * with ioRef === null, so every call was a silent no-op -- and the negative
 * tests ("an anonymous socket must NOT receive this") passed simply because
 * nothing was ever sent to anyone.
 *
 * Emitting through real endpoints is both correct and a better test: it
 * exercises the actual controller -> database -> emit path a user triggers.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const API = require("./helpers/testDb").apiUrl();
const MONGO = require("./helpers/testDb").uri();

function connect(io, token) {
  return new Promise((resolve, reject) => {
    const sock = io(API, {
      auth: token ? { token } : {},
      reconnection: false,
      transports: ["websocket"],
      timeout: 4000,
    });
    sock.on("connect", () => resolve(sock));
    sock.on("connect_error", (e) => reject(e));
    setTimeout(() => reject(new Error("socket connect timed out")), 5000);
  });
}

/**
 * Collect any of `events` that arrive within `ms`.
 *
 * `until` lets a caller stop early once it has what it needs, instead of
 * always paying the full timeout. That matters for the approval test: the
 * approve endpoint awaits a real SMTP send, so the event can land several
 * seconds after the request is issued -- a short fixed window closed before
 * the emit and made the test fail against working code.
 */
function collect(sock, events, ms = 2500, until = null) {
  const got = [];
  let done;
  const finished = new Promise((r) => (done = r));

  const handlers = events.map((ev) => {
    const h = (payload) => {
      got.push({ event: ev, payload });
      if (until && until(got)) done();
    };
    sock.on(ev, h);
    return [ev, h];
  });

  const timer = setTimeout(done, ms);
  return finished.then(() => {
    clearTimeout(timer);
    handlers.forEach(([ev, h]) => sock.off(ev, h));
    return got;
  });
}

test("real-time: authentication, isolation and live delivery", async (t) => {
  const reachable = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    t.skip(`API not reachable at ${API} — start the stack to run this test`);
    return;
  }

  let ioClient;
  try {
    ioClient = require("socket.io-client");
  } catch {
    t.skip("socket.io-client is not installed");
    return;
  }

  const mongoose = require("mongoose");
  const bcrypt = require("bcryptjs");
  const jwt = require("jsonwebtoken");
  await mongoose.connect(MONGO);

  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const tag = `rttest-${Date.now()}`;
  const sockets = [];
  let failure = null;

  const mkUser = async (suffix, role, extra = {}) =>
    User.create({
      name: `${tag}-${suffix}`,
      email: `${tag}-${suffix}@fuelmart.test`,
      password: await bcrypt.hash("rttest12345", 8),
      role,
      isVerified: true,
      ...extra,
    });
  const tokenFor = (u) =>
    jwt.sign({ user: { id: u.id } }, process.env.JWT_SECRET, { expiresIn: "15m" });

  let station = null;

  try {
    // Always its own admin (tagged, removed with the other tagged users at the
    // end). Borrowing any existing admin raced other test files running in
    // parallel: forecasting.test.js deletes its temporary admin when done, and
    // this file's admin calls then failed the role check with 403.
    const admin = await mkUser("admin", "admin");
    const adminToken = tokenFor(admin);

    // A vendor who owns a station, so price updates have a real owner and a
    // real room to land in.
    const vendor = await mkUser("vendor", "vendor", {
      vendorStatus: "active",
      activated: true,
      businessName: `${tag} Fuels`,
    });
    station = await Station.create({
      name: `${tag}-station`,
      address: "Realtime Test Road, Pune",
      owner: vendor._id,
      coordinates: { lat: 18.52, lng: 73.85 },
      fuelTypes: ["Petrol", "Diesel"],
      prices: { petrol: 100, diesel: 90, cng: 0 },
      inventory: { petrol: 50000, diesel: 50000, cng: 0 },
      status: "Active",
    });

    const customer = await mkUser("cust", "customer");
    const other = await mkUser("other", "customer");

    /** Change the station's petrol price through the real vendor endpoint. */
    const changePrice = (price) =>
      fetch(`${API}/api/vendor-panel/stations/${station._id}/price`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-auth-token": tokenFor(vendor) },
        body: JSON.stringify({ fuelType: "Petrol", newPrice: price }),
      });

    // ---------------------------------------------- delivery works at all
    await t.test("a watching client receives a real vendor price change", async () => {
      const sock = await connect(ioClient, null); // anonymous: prices are public
      sockets.push(sock);
      sock.emit("watch_station", String(station._id));
      await new Promise((r) => setTimeout(r, 400));

      const heard = collect(sock, ["fuelPrice:updated"], 2500);
      const res = await changePrice(107.25);
      assert.equal(res.status, 200, "the price update endpoint failed");

      const got = await heard;
      assert.equal(got.length >= 1, true, "no price event reached a watching client");
      assert.equal(Number(got[0].payload.newPrice), 107.25);
      assert.ok(got[0].payload.pricesUpdatedAt, "no timestamp on the price event");
    });

    // A station list, the dashboard and the booking picker do not watch any
    // one station. They used to hear nothing, so new prices, stations and
    // photos appeared only after a manual refresh.
    await t.test("a client on a station list (watching nothing) receives the change live", async () => {
      const sock = await connect(ioClient, null);
      sockets.push(sock);
      await new Promise((r) => setTimeout(r, 300));

      const heard = collect(sock, ["fuelPrice:updated"], 2000);
      await changePrice(108.5);
      const got = await heard;
      assert.equal(got.length, 1, "a list page did not get the price change");
      assert.equal(Number(got[0].payload.newPrice), 108.5);
    });

    await t.test("a watcher gets each change exactly once, before and after unwatching", async () => {
      const sock = await connect(ioClient, null);
      sockets.push(sock);
      sock.emit("watch_station", String(station._id));
      await new Promise((r) => setTimeout(r, 300));

      let heard = collect(sock, ["fuelPrice:updated"], 1500);
      await changePrice(109.25);
      assert.equal((await heard).length, 1, "a watcher heard the change twice (station room + stations room)");

      sock.emit("unwatch_station", String(station._id));
      await new Promise((r) => setTimeout(r, 300));
      heard = collect(sock, ["fuelPrice:updated"], 1500);
      await changePrice(109.75);
      assert.equal((await heard).length, 1, "after unwatch the page still hears the change, once");
    });

    await t.test("a new station reaches clients that could not have been watching it", async () => {
      const sock = await connect(ioClient, null);
      sockets.push(sock);
      await new Promise((r) => setTimeout(r, 300));

      const heard = collect(sock, ["station:created"], 3000, (g) => g.length > 0);
      const res = await fetch(`${API}/api/vendor-panel/stations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-auth-token": tokenFor(vendor) },
        body: JSON.stringify({ name: `${tag}-new`, address: "Live Road, Pune", coordinates: { lat: 18.53, lng: 73.86 } }),
      });
      assert.equal(res.status, 201);
      const created = await res.json();
      const got = await heard;
      assert.equal(got.length, 1, "station:created did not reach a list page");
      assert.equal(String(got[0].payload._id), String(created._id));
      assert.ok(!/"owner"|upiId/.test(JSON.stringify(got[0].payload)), "public payload leaked private fields");

      // Deleting it tells the same page which station to remove.
      const gone = collect(sock, ["station:deleted"], 3000, (g) => g.length > 0);
      const del = await fetch(`${API}/api/vendor-panel/stations/${created._id}`, {
        method: "DELETE",
        headers: { "x-auth-token": tokenFor(vendor) },
      });
      assert.equal(del.status, 200);
      const deleted = await gone;
      assert.equal(deleted.length, 1, "station:deleted did not reach a list page");
      assert.equal(String(deleted[0].payload.id), String(created._id), "the deletion did not say which station");
    });

    // ---------------------------------------- the public payload is trimmed
    await t.test("a customer's price event does not carry owner or payout details", async () => {
      const sock = await connect(ioClient, null);
      sockets.push(sock);
      sock.emit("watch_station", String(station._id));
      await new Promise((r) => setTimeout(r, 300));

      const heard = collect(sock, ["fuelPrice:updated"], 2500);
      await changePrice(110.5);
      const got = await heard;
      assert.ok(got.length >= 1);

      const text = JSON.stringify(got[0].payload);
      assert.ok(!/"owner"/.test(text), "the public payload leaked the station owner");
      assert.ok(!/upiId/.test(text), "the public payload leaked the payout account");
    });

    // ------------------------------------- the vendor gets the full record
    await t.test("the owning vendor receives their own station's change", async () => {
      const sock = await connect(ioClient, tokenFor(vendor));
      sockets.push(sock);
      await new Promise((r) => setTimeout(r, 500));

      const heard = collect(sock, ["fuelPrice:updated"], 2500);
      await changePrice(111.25);
      const got = await heard;
      assert.equal(got.length, 1, "the owning vendor should get their station's change exactly once");
      assert.ok(got[0].payload.owner, "the owner gets the full record, not the public view");
    });

    await t.test("an admin gets a station change exactly once, in full", async () => {
      const sock = await connect(ioClient, adminToken);
      sockets.push(sock);
      await new Promise((r) => setTimeout(r, 500));

      const heard = collect(sock, ["fuelPrice:updated"], 2500);
      await changePrice(111.5);
      const got = await heard;
      assert.equal(got.length, 1, "an admin heard the change twice");
      assert.ok(got[0].payload.owner, "admins get the full record");
    });

    // ------------------------------------------------- admin isolation
    await t.test("an anonymous socket cannot join the admin room", async () => {
      const anon = await connect(ioClient, null);
      sockets.push(anon);
      // The exact shape the old client-trusted handler accepted.
      anon.emit("identify", { userId: String(admin._id), role: "admin" });
      await new Promise((r) => setTimeout(r, 400));

      const heard = collect(anon, ["vendor:statusChanged", "admin:activity"], 2500);
      // A real admin action that emits to the admin room.
      await fetch(`${API}/api/vendors/${vendor._id}/suspend`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-auth-token": adminToken },
        body: JSON.stringify({ reason: `${tag} probe` }),
      });
      assert.deepEqual(await heard, [], "an anonymous socket received an admin event");
    });

    await t.test("a customer cannot join the admin room", async () => {
      const sock = await connect(ioClient, tokenFor(customer));
      sockets.push(sock);
      sock.emit("identify", { userId: String(admin._id), role: "admin" });
      await new Promise((r) => setTimeout(r, 400));

      const heard = collect(sock, ["vendor:statusChanged", "admin:activity"], 2500);
      await fetch(`${API}/api/vendors/${vendor._id}/reactivate`, {
        method: "PATCH",
        headers: { "x-auth-token": adminToken },
      });
      assert.deepEqual(await heard, [], "a customer received an admin event");
    });

    // ---------------------------------------- vendor approval, end to end
    await t.test("approving a vendor notifies that vendor live, without the code", async () => {
      const applicant = await mkUser("applicant", "vendor", {
        vendorStatus: "pending",
        businessName: `${tag} Applicant`,
      });
      const sock = await connect(ioClient, tokenFor(applicant));
      sockets.push(sock);
      await new Promise((r) => setTimeout(r, 500));

      // 15s, because approveVendor awaits a real SMTP send before it emits.
      // Resolves the moment the event arrives, so the test is not slow when
      // mail is fast.
      const heard = collect(
        sock,
        ["vendor:approved", "notification:created"],
        15000,
        (got) => got.some((g) => g.event === "vendor:approved"),
      );
      const res = await fetch(`${API}/api/vendors/${applicant._id}/approve`, {
        method: "PATCH",
        headers: { "x-auth-token": adminToken },
      });
      assert.equal(res.status, 200, "approve failed");

      const got = await heard;
      const approved = got.find((g) => g.event === "vendor:approved");
      assert.ok(approved, "the vendor was not told about their own approval");
      assert.equal(approved.payload.vendorStatus, "active");
      assert.equal(approved.payload.activated, false, "approval alone must not activate");

      // The secret code must never travel over the socket.
      const text = JSON.stringify(got);
      assert.ok(!/secretCodeHash/.test(text), "the hash went out over the socket");
      assert.ok(
        !/[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}/.test(text),
        "something shaped exactly like a secret code went out over the socket",
      );

      // ...and a durable notification was written, so a vendor with the tab
      // closed still finds out.
      const Notification = require("../src/models/Notification");
      const note = await Notification.findOne({ user: applicant._id, type: "vendor_approved" });
      assert.ok(note, "no notification row was written for the approval");
    });

    // --------------------------------------------- legacy alias delivery
    await t.test("events also carry the legacy name, so cached clients keep working", async () => {
      const sock = await connect(ioClient, null);
      sockets.push(sock);
      sock.emit("watch_station", String(station._id));
      await new Promise((r) => setTimeout(r, 300));

      const heard = collect(sock, ["fuelPrice:updated", "fuel_price_updated"], 2500);
      await changePrice(112.0);
      const got = await heard;

      assert.ok(got.some((g) => g.event === "fuelPrice:updated"), "canonical name missing");
      assert.ok(
        got.some((g) => g.event === "fuel_price_updated"),
        "legacy alias missing — a browser with a cached bundle would go dead",
      );
    });

    // --------------------------------- a watch sent the instant we connect
    await t.test("a watch sent the moment the socket connects is honoured (no settle delay)", async () => {
      // Authenticated, so the server's identity lookup is in flight when the
      // watch arrives -- the case that used to be dropped.
      const sock = await connect(ioClient, tokenFor(customer));
      sockets.push(sock);
      sock.emit("watch_station", String(station._id));

      const heard = collect(sock, ["fuelPrice:updated"], 3000, (got) => got.length > 0);
      await new Promise((r) => setTimeout(r, 50)); // only the emit's own round trip, not a settle delay
      const res = await changePrice(114.25);
      assert.equal(res.status, 200);
      assert.ok((await heard).length >= 1, "a watch sent on connect was dropped");
    });

    // ------------------------ a booking in one session, seen live in others
    await t.test("a booking and its cancellation reach the vendor, station watchers and customer live -- and no one else", async () => {
      const Booking = require("../src/models/Booking");
      const vendorSock = await connect(ioClient, tokenFor(vendor));
      const customerSock = await connect(ioClient, tokenFor(customer));
      const otherSock = await connect(ioClient, tokenFor(other));
      const watcher = await connect(ioClient, null); // e.g. another customer on the booking page
      sockets.push(vendorSock, customerSock, otherSock, watcher);
      watcher.emit("watch_station", String(station._id));
      await new Promise((r) => setTimeout(r, 500));

      const has = (got, ev) => got.some((g) => g.event === ev);
      const otherHeard = collect(otherSock, ["booking:created", "booking:cancelled", "booking:updated"], 7000);
      const vendorHeard = collect(vendorSock, ["booking:created", "slot:updated", "queue:updated"], 4000, (g) =>
        has(g, "booking:created") && has(g, "slot:updated") && has(g, "queue:updated"),
      );
      const watcherHeard = collect(watcher, ["booking:created", "slot:updated", "queue:updated"], 4000, (g) =>
        has(g, "slot:updated") && has(g, "queue:updated"),
      );
      const customerHeard = collect(customerSock, ["booking:created"], 4000, (g) => g.length > 0);

      const created = await fetch(`${API}/api/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-auth-token": tokenFor(customer) },
        body: JSON.stringify({
          stationId: String(station._id),
          fuelType: "Petrol",
          quantity: 10,
          bookingDate: "2099-12-01",
          timeSlot: "10:00 AM",
          payMethod: "station",
        }),
      });
      const body = await created.json();
      assert.equal(created.status, 200, JSON.stringify(body));
      const bookingId = String(body.booking._id);

      const v = await vendorHeard;
      assert.ok(v.some((g) => g.event === "booking:created" && String(g.payload._id) === bookingId), "vendor did not get booking:created");
      assert.ok(v.some((g) => g.event === "slot:updated" && g.payload.stationId === String(station._id)), "vendor did not get slot:updated");
      const w = await watcherHeard;
      assert.ok(has(w, "slot:updated") && has(w, "queue:updated"), "a station watcher did not get the queue/slot change");
      assert.ok(!has(w, "booking:created"), "a public station watcher received a private booking payload");
      assert.ok((await customerHeard).length >= 1, "the booking customer's own session did not update");

      const vendorCancel = collect(vendorSock, ["booking:cancelled"], 4000, (g) => g.length > 0);
      const watcherSlot = collect(watcher, ["slot:updated"], 4000, (g) => g.length > 0);
      const cancelled = await fetch(`${API}/api/bookings/${bookingId}/cancel`, {
        method: "PATCH",
        headers: { "x-auth-token": tokenFor(customer) },
      });
      assert.equal(cancelled.status, 200);
      const vc = await vendorCancel;
      assert.ok(vc.length >= 1 && String(vc[0].payload._id) === bookingId, "vendor did not see the cancellation live");
      assert.equal(vc[0].payload.status, "cancelled");
      assert.ok((await watcherSlot).length >= 1, "the freed slot did not reach station watchers");

      assert.deepEqual(await otherHeard, [], "another customer received someone else's booking events");
      assert.equal((await Booking.findById(bookingId).lean()).status, "cancelled");
    });

    // ------------------------------------------------ origin allowlist
    await t.test("a socket from a disallowed browser origin is refused; the dev origin connects", async () => {
      const tryConnect = (origin) =>
        new Promise((resolve) => {
          const sock = ioClient(API, {
            transports: ["websocket"],
            reconnection: false,
            timeout: 4000,
            extraHeaders: { Origin: origin },
          });
          let settled = false;
          const done = (ok) => {
            if (settled) return;
            settled = true;
            sock.close();
            resolve(ok);
          };
          sock.on("connect", () => done(true));
          sock.on("connect_error", () => done(false));
          setTimeout(() => done(false), 5000);
        });
      assert.equal(await tryConnect("https://evil.example"), false, "a foreign website opened a socket");
      assert.equal(await tryConnect("http://localhost:3001"), true, "the dev frontend's origin was refused");
    });

    // ------------------------------------------------------- robustness
    await t.test("a malformed station id does not break the connection", async () => {
      const sock = await connect(ioClient, null);
      sockets.push(sock);
      sock.emit("watch_station", "../../etc/passwd");
      sock.emit("watch_station", { $ne: null });
      sock.emit("watch_station", null);
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(sock.connected, "a bad station id killed the connection");
    });

    await t.test("an invalid token connects as anonymous rather than failing", async () => {
      // A signed-out visitor must still get live prices; an expired token
      // should degrade, not lock the page out of real-time entirely.
      const sock = await connect(ioClient, "not.a.real.token");
      sockets.push(sock);
      assert.ok(sock.connected, "a bad token refused the connection outright");

      sock.emit("watch_station", String(station._id));
      await new Promise((r) => setTimeout(r, 300));
      const heard = collect(sock, ["fuelPrice:updated"], 2500);
      await changePrice(113.5);
      assert.ok((await heard).length >= 1, "an anonymous client got no public station data");
    });
  } catch (err) {
    failure = err;
  } finally {
    sockets.forEach((s) => {
      try {
        s.disconnect();
      } catch {
        /* already closed */
      }
    });
    const Notification = require("../src/models/Notification");
    const users = await User.find({ email: { $regex: `^${tag}-` } }).select("_id").lean();
    await Notification.deleteMany({ user: { $in: users.map((u) => u._id) } });
    await require("../src/models/BookingAttempt").deleteMany({ user: { $in: users.map((u) => u._id) } });
    if (station) {
      await require("../src/models/Booking").deleteMany({ station: station._id });
      // The price changes above are recorded as price history.
      await require("../src/models/PriceHistory").deleteMany({ station: station._id });
      await Station.deleteOne({ _id: station._id });
    }
    await User.deleteMany({ email: { $regex: `^${tag}-` } });
    await mongoose.disconnect();
    await require("../src/services/core/lock").close();
    await require("../src/services/security/rateLimiter").close();
  }

  if (failure) throw failure;
});
