/**
 * The session endpoints over HTTP (src/routes/authRoutes.js): login sets the
 * httpOnly cookies, refresh rotates them, logout clears them, logout-all
 * refuses every earlier token. In-process app, test database only.
 *
 * DEVELOPMENT TEST DATA: one tagged user with a throwaway password hash,
 * removed at the end.
 *
 *   node --test test/authRoutes.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

const testDb = require("./helpers/testDb");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

/** name -> { value, attrs } from a response's Set-Cookie headers. */
function cookiesOf(res) {
  const out = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(";").map((s) => s.trim());
    const eq = pair.indexOf("=");
    out[pair.slice(0, eq)] = { value: decodeURIComponent(pair.slice(eq + 1)), attrs: attrs.map((a) => a.toLowerCase()) };
  }
  return out;
}

test("session endpoints against MongoDB", async (t) => {
  const MONGO = testDb.uri(); // also blanks SMTP: no mail is sent
  // In-process rate limits only. With the shared test Redis, the register limit
  // (5 per hour per IP) carries counts over from earlier runs on the same
  // machine and refuses this run's registration with 429.
  process.env.REDIS_URL = "";
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const User = require("../src/models/User");
  const RefreshToken = require("../src/models/RefreshToken");
  const tag = `authroutes-${Date.now()}`;
  const password = crypto.randomBytes(12).toString("hex"); // throwaway, this test only
  const user = await User.create({
    name: `${tag}-c`,
    email: `${tag}-c@example.com`,
    password: await bcrypt.hash(password, 4),
    role: "customer",
    isVerified: true,
  });

  const app = express().use(express.json()).use(cookieParser()).use("/api/auth", require("../src/routes/authRoutes"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, { cookie, origin = base, body } = {}) =>
    fetch(`${base}${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const get = (route, cookie) => fetch(`${base}${route}`, { headers: cookie ? { cookie } : {} });
  const jar = (c) => Object.entries(c).map(([k, v]) => `${k}=${encodeURIComponent(v.value)}`).join("; ");

  try {
    let session;

    await t.test("login sets httpOnly SameSite=Strict cookies; the refresh cookie is scoped to /api/auth", async () => {
      const res = await post("/api/auth/login", { body: { email: user.email, password } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.user.email, user.email);
      assert.equal(body.user.password, undefined);
      assert.equal(body.token, undefined, "the session is in httpOnly cookies, never the body");

      session = cookiesOf(res);
      const { fm_access: access, fm_refresh: refresh } = session;
      assert.ok(access && refresh, "both session cookies are set");
      for (const c of [access, refresh]) {
        assert.ok(c.attrs.includes("httponly"), "httpOnly");
        assert.ok(c.attrs.includes("samesite=strict"), "SameSite=Strict");
      }
      assert.ok(access.attrs.includes("path=/"));
      assert.ok(refresh.attrs.includes("path=/api/auth"));

      assert.equal((await get("/api/auth/me", `fm_access=${access.value}`)).status, 200, "the cookie authenticates");
    });

    await t.test("registration signs the new customer in with cookies, not a token in the body", async () => {
      const res = await post("/api/auth/register", {
        body: { name: `${tag}-new`, email: `${tag}-new@example.com`, password: crypto.randomBytes(12).toString("hex") },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.token, undefined);
      assert.equal(body.user.email, `${tag}-new@example.com`);
      const cookies = cookiesOf(res);
      assert.ok(cookies.fm_access && cookies.fm_refresh, "both session cookies are set");
      assert.equal((await get("/api/auth/me", `fm_access=${cookies.fm_access.value}`)).status, 200);
    });

    await t.test("wrong password: 400 and no cookies", async () => {
      const res = await post("/api/auth/login", { body: { email: user.email, password: "wrong-password" } });
      assert.equal(res.status, 400);
      assert.equal(res.headers.getSetCookie().length, 0);
    });

    await t.test("refresh rotates both cookies; the old refresh token is spent", async () => {
      const res = await post("/api/auth/refresh", { cookie: jar(session) });
      assert.equal(res.status, 200);
      const refreshed = await res.json();
      assert.equal(refreshed.user.email, user.email);
      assert.equal(refreshed.token, undefined);
      const next = cookiesOf(res);
      assert.notEqual(next.fm_refresh.value, session.fm_refresh.value);
      assert.equal((await get("/api/auth/me", `fm_access=${next.fm_access.value}`)).status, 200);

      const again = await post("/api/auth/refresh", { cookie: jar(session) });
      assert.equal(again.status, 401);
      assert.equal((await again.json()).reason, "REFRESH_IN_PROGRESS", "within the race window: retry, not theft");
      session = next;
    });

    await t.test("refresh and logout with session cookies need an allowed origin", async () => {
      assert.equal((await post("/api/auth/refresh", { cookie: jar(session), origin: null })).status, 403);
      assert.equal((await post("/api/auth/refresh", { cookie: jar(session), origin: "https://evil.example" })).status, 403);
      assert.equal((await post("/api/auth/logout", { cookie: jar(session), origin: "https://evil.example" })).status, 403);

      const noCookie = await post("/api/auth/refresh", { origin: null });
      assert.equal(noCookie.status, 401, "no session cookie: nothing to protect, just not signed in");
      assert.equal((await noCookie.json()).reason, "NO_REFRESH_TOKEN");
    });

    await t.test("logout clears both cookies and ends this session", async () => {
      const res = await post("/api/auth/logout", { cookie: jar(session) });
      assert.equal(res.status, 200);
      const cleared = cookiesOf(res);
      assert.equal(cleared.fm_access.value, "");
      assert.equal(cleared.fm_refresh.value, "");
      assert.ok(cleared.fm_refresh.attrs.includes("path=/api/auth"), "cleared on the path it was set on");

      const after = await post("/api/auth/refresh", { cookie: jar(session) });
      assert.equal(after.status, 401);
    });

    await t.test("logout-all: every earlier access and refresh token stops working", async () => {
      const deviceA = cookiesOf(await post("/api/auth/login", { body: { email: user.email, password } }));
      const deviceB = cookiesOf(await post("/api/auth/login", { body: { email: user.email, password } }));

      const res = await post("/api/auth/logout-all", { cookie: `fm_access=${deviceA.fm_access.value}` });
      assert.equal(res.status, 200);

      assert.equal((await get("/api/auth/me", `fm_access=${deviceA.fm_access.value}`)).status, 401);
      assert.equal((await get("/api/auth/me", `fm_access=${deviceB.fm_access.value}`)).status, 401, "the other device too");
      assert.equal((await post("/api/auth/refresh", { cookie: jar(deviceB) })).status, 401);
      assert.equal(await RefreshToken.countDocuments({ user: user._id, revokedAt: null }), 0);

      assert.equal((await post("/api/auth/logout-all", {})).status, 401, "requires a signed-in user");
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    // Every user this file created carries the tag (including the one registered over HTTP).
    const created = await User.find({ email: new RegExp(`^${tag}-`) }).select("_id").lean();
    const ids = created.map((u) => u._id);
    await RefreshToken.deleteMany({ user: { $in: ids } });
    await User.deleteMany({ _id: { $in: ids } });
    await mongoose.disconnect();
  }
});
