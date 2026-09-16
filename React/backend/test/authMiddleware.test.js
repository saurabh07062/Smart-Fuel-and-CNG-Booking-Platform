/**
 * The auth middleware (src/middleware/auth.js) on an in-process app: cookie
 * and header tokens, the tokenVersion check, roles from the database, and the
 * origin check on state-changing cookie requests.
 *
 * DEVELOPMENT TEST DATA, test database only: tagged users, removed at the end.
 *
 *   node --test test/authMiddleware.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("auth middleware against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const User = require("../src/models/User");
  const auth = require("../src/middleware/auth");
  const requireRole = require("../src/middleware/requireRole");
  const session = require("../src/services/security/session");

  const tag = `authmw-${Date.now()}`;
  const [customer, admin] = await User.insertMany([
    { name: `${tag}-c`, email: `${tag}-c@example.com`, password: "not-a-real-hash", role: "customer", isVerified: true },
    { name: `${tag}-a`, email: `${tag}-a@example.com`, password: "not-a-real-hash", role: "admin", isVerified: true },
  ]);

  const app = express().use(express.json()).use(cookieParser());
  app.get("/me", auth, (req, res) => res.json({ user: req.user, source: req.authSource }));
  app.post("/change", auth, (req, res) => res.json({ ok: true, source: req.authSource }));
  app.get("/admin-only", auth, requireRole("admin"), (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = (method, route, { cookie, header, origin } = {}) =>
    fetch(`${base}${route}`, {
      method,
      headers: {
        ...(cookie ? { cookie: `fm_access=${cookie}` } : {}),
        ...(header ? { "x-auth-token": header } : {}),
        ...(origin ? { origin } : {}),
      },
    });

  try {
    await t.test("no token, or a bad one, is 401", async () => {
      assert.equal((await call("GET", "/me")).status, 401);
      assert.equal((await call("GET", "/me", { cookie: "garbage" })).status, 401);
      assert.equal((await call("GET", "/me", { header: "garbage" })).status, 401);
    });

    await t.test("a session cookie authenticates; a header still works for non-browser clients", async () => {
      const token = session.signAccessToken(customer);
      const viaCookie = await call("GET", "/me", { cookie: token });
      assert.equal(viaCookie.status, 200);
      const body = await viaCookie.json();
      assert.equal(body.source, "cookie");
      assert.deepEqual([body.user.id, body.user.role], [String(customer._id), "customer"]);

      const viaHeader = await (await call("GET", "/me", { header: token })).json();
      assert.equal(viaHeader.source, "header");
    });

    await t.test("the role comes from the database, never the token payload", async () => {
      const claimsAdmin = jwt.sign({ user: { id: String(customer._id), role: "admin" } }, process.env.JWT_SECRET);
      assert.equal((await call("GET", "/admin-only", { header: claimsAdmin })).status, 403);
      assert.equal((await call("GET", "/admin-only", { header: session.signAccessToken(admin) })).status, 200);
    });

    await t.test("a token signed with another algorithm is refused", async () => {
      const hs512 = jwt.sign({ user: { id: String(customer._id) } }, process.env.JWT_SECRET, { algorithm: "HS512" });
      assert.equal((await call("GET", "/me", { header: hs512 })).status, 401);
    });

    await t.test("a state-changing request by cookie must come from an allowed origin", async () => {
      const token = session.signAccessToken(customer);
      const noOrigin = await call("POST", "/change", { cookie: token });
      assert.equal(noOrigin.status, 403);
      assert.equal((await noOrigin.json()).reason, "ORIGIN_NOT_ALLOWED");
      assert.equal((await call("POST", "/change", { cookie: token, origin: "https://evil.example" })).status, 403);

      assert.equal((await call("POST", "/change", { cookie: token, origin: base })).status, 200, "same origin");
      assert.equal(
        (await call("POST", "/change", { cookie: token, origin: "http://localhost:3001" })).status,
        200,
        "the Vite dev server, outside production",
      );
      assert.equal((await call("POST", "/change", { header: token })).status, 200, "headers need no origin check");
      assert.equal((await call("GET", "/me", { cookie: token, origin: "https://evil.example" })).status, 200, "reads are not state changes");
    });

    await t.test("after log out everywhere, earlier tokens are refused by cookie and header", async () => {
      const before = session.signAccessToken(customer);
      assert.equal((await call("GET", "/me", { cookie: before })).status, 200);

      await session.revokeAllSessions(customer._id);
      assert.equal((await call("GET", "/me", { cookie: before })).status, 401);
      assert.equal((await call("GET", "/me", { header: before })).status, 401);

      const after = session.signAccessToken(await User.findById(customer._id).lean());
      assert.equal((await call("GET", "/me", { cookie: after })).status, 200);
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await require("../src/models/RefreshToken").deleteMany({ user: { $in: [customer._id, admin._id] } });
    await User.deleteMany({ _id: { $in: [customer._id, admin._id] } });
    await mongoose.disconnect();
  }
});
