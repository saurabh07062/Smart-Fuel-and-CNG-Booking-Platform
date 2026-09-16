/**
 * Socket.IO authentication (src/services/notification/realtime.js): the
 * httpOnly session cookie in the handshake, auth.token for scripts, the
 * tokenVersion check, the HS256 pin, and "log out everywhere" disconnecting
 * live sockets. In-process Socket.IO server.
 *
 * DEVELOPMENT TEST DATA, test database only: one tagged user, removed at the end.
 *
 *   node --test test/socketAuth.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const http = require("http");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("socket authentication against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }
  let ioClient;
  try {
    ioClient = require("socket.io-client");
  } catch {
    t.skip("socket.io-client is not installed");
    return;
  }

  const { Server } = require("socket.io");
  const realtime = require("../src/services/notification/realtime");
  const session = require("../src/services/security/session");
  const User = require("../src/models/User");

  const tag = `sockauth-${Date.now()}`;
  const customer = await User.create({
    name: `${tag}-c`,
    email: `${tag}-c@example.com`,
    password: "not-a-real-hash",
    role: "customer",
    isVerified: true,
  });

  const httpServer = http.createServer();
  const io = new Server(httpServer);
  realtime.init(io);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;

  const sockets = [];
  const connect = (opts = {}) =>
    new Promise((resolve, reject) => {
      const sock = ioClient(url, { reconnection: false, transports: ["websocket"], timeout: 4000, ...opts });
      sockets.push(sock);
      sock.once("connect", () => resolve(sock));
      sock.once("connect_error", reject);
    });
  // joinIdentityRooms is a database round trip after the handshake.
  const settle = () => sleep(400);
  const hearsOwnEvent = async (sock) => {
    await settle();
    const heard = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 800);
      sock.once("socketauth:ping", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    realtime.toUser(customer._id, "socketauth:ping", { at: Date.now() });
    return heard;
  };

  try {
    await t.test("the session cookie in the handshake signs the socket in", async () => {
      const token = session.signAccessToken(customer);
      const sock = await connect({ extraHeaders: { cookie: `theme=dark; fm_access=${token}` } });
      assert.equal(await hearsOwnEvent(sock), true);
      sock.close();
    });

    await t.test("auth.token still works for scripts and tests", async () => {
      const sock = await connect({ auth: { token: session.signAccessToken(customer) } });
      assert.equal(await hearsOwnEvent(sock), true);
      sock.close();
    });

    await t.test("no token, a revoked tokenVersion or another algorithm: anonymous, not refused", async () => {
      const anonymous = await connect();
      assert.equal(await hearsOwnEvent(anonymous), false, "connected, but no private room");
      anonymous.close();

      const stale = jwt.sign({ user: { id: String(customer._id) }, tv: 9 }, process.env.JWT_SECRET);
      const staleSock = await connect({ auth: { token: stale } });
      assert.equal(await hearsOwnEvent(staleSock), false);
      staleSock.close();

      const hs512 = jwt.sign({ user: { id: String(customer._id) } }, process.env.JWT_SECRET, { algorithm: "HS512" });
      const hs512Sock = await connect({ extraHeaders: { cookie: `fm_access=${hs512}` } });
      assert.equal(await hearsOwnEvent(hs512Sock), false);
      hs512Sock.close();
    });

    await t.test("log out everywhere disconnects live sockets, and the old token no longer signs in", async () => {
      const oldToken = session.signAccessToken(customer);
      const sock = await connect({ extraHeaders: { cookie: `fm_access=${oldToken}` } });
      assert.equal(await hearsOwnEvent(sock), true);

      const dropped = new Promise((resolve) => sock.once("disconnect", resolve));
      await session.revokeAllSessions(customer._id);
      assert.equal(await Promise.race([dropped, sleep(2000).then(() => "timeout")]), "io server disconnect");

      const again = await connect({ extraHeaders: { cookie: `fm_access=${oldToken}` } });
      assert.equal(await hearsOwnEvent(again), false, "reconnects as anonymous");
      again.close();
    });
  } finally {
    sockets.forEach((s) => s.close());
    await new Promise((resolve) => io.close(() => resolve()));
    await require("../src/models/RefreshToken").deleteMany({ user: customer._id });
    await User.deleteMany({ _id: customer._id });
    await mongoose.disconnect();
  }
});
