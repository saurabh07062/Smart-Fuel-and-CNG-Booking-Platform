/**
 * Forgot password over HTTP (routes/authRoutes.js ->
 * services/security/passwordReset.js): the same answer for any email, only a
 * hash stored, a 1-hour single-use link, and a reset that signs the account out
 * everywhere. In-process app, test database only; the email sender is replaced
 * by a recorder, so no mail is sent.
 *
 * DEVELOPMENT TEST DATA: one tagged user with a throwaway password, removed at the end.
 *
 *   node --test test/passwordReset.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

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

function cookiesOf(res) {
  const out = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    out[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1));
  }
  return out;
}

test("forgot password against MongoDB", async (t) => {
  const MONGO = testDb.uri(); // also blanks SMTP
  // In-process rate limits only. With the shared test Redis, the forgot-password
  // limit (5 per 15 minutes per IP) carries counts over from the previous run on
  // the same machine and refuses this one with 429.
  process.env.REDIS_URL = "";
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const User = require("../src/models/User");
  const RefreshToken = require("../src/models/RefreshToken");
  const emailService = require("../src/services/notification/emailService");
  const passwordReset = require("../src/services/security/passwordReset");

  const mails = [];
  const realSendMail = emailService.sendMail;
  emailService.sendMail = async (opts) => {
    mails.push(opts);
    return true;
  };
  const prevClientUrl = process.env.CLIENT_URL;
  process.env.CLIENT_URL = "http://app.fuelmart.test";

  const tag = `pwreset-${Date.now()}`;
  const oldPassword = crypto.randomBytes(12).toString("hex"); // throwaway, this test only
  const newPassword = crypto.randomBytes(12).toString("hex");
  const user = await User.create({
    name: `${tag}-<b>c</b>`,
    email: `${tag}-c@example.com`,
    password: await bcrypt.hash(oldPassword, 4),
    role: "customer",
    isVerified: true,
  });

  const app = express().use(express.json()).use(cookieParser()).use("/api/auth", require("../src/routes/authRoutes"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, cookie) =>
    fetch(`${base}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: base, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const tokenFromMail = (mail) => new URL(mail.text.match(/http:\/\/app\.fuelmart\.test\/reset-password\?token=\S+/)[0]).searchParams.get("token");
  const stored = () => User.findById(user._id).select("+passwordResetTokenHash").lean();

  let firstToken;
  let token;

  try {
    await t.test("unknown and known emails get the same answer; only the known one is emailed", async () => {
      const unknown = await post("/api/auth/forgot-password", { email: `${tag}-nobody@example.com` });
      const unknownBody = await unknown.json();
      assert.equal(unknown.status, 200);
      assert.equal(mails.length, 0);

      const known = await post("/api/auth/forgot-password", { email: user.email });
      const knownBody = await known.json();
      assert.equal(known.status, 200);
      assert.deepEqual(knownBody, unknownBody, "identical response bodies");
      assert.equal(knownBody.msg, passwordReset.GENERIC_REQUEST_MSG);
      assert.equal(mails.length, 1);
      assert.equal(mails[0].to, user.email);
      assert.ok(!mails[0].html.includes("<b>c</b>"), "the name is escaped in the HTML");
    });

    await t.test("only a hash of the token is stored, expiring in 1 hour", async () => {
      firstToken = tokenFromMail(mails[0]);
      assert.ok(firstToken.length >= 40);
      const doc = await stored();
      assert.equal(doc.passwordResetTokenHash, passwordReset.hashResetToken(firstToken));
      assert.ok(!JSON.stringify(doc).includes(firstToken), "the raw token is nowhere in the user document");
      const ms = new Date(doc.passwordResetExpiresAt) - Date.now();
      assert.ok(ms > 59 * 60_000 && ms <= 60 * 60_000, `expires in ${ms} ms`);
      assert.equal((await User.findById(user._id).lean()).passwordResetTokenHash, undefined, "hidden from normal reads");
    });

    await t.test("a repeat request within a minute sends nothing new and keeps the link", async () => {
      const again = await post("/api/auth/forgot-password", { email: user.email });
      assert.equal(again.status, 200);
      assert.equal((await again.json()).msg, passwordReset.GENERIC_REQUEST_MSG);
      assert.equal(mails.length, 1);
      assert.equal((await stored()).passwordResetTokenHash, passwordReset.hashResetToken(firstToken));
    });

    await t.test("a later request replaces the link: the earlier one stops working", async () => {
      await User.updateOne({ _id: user._id }, { $set: { passwordResetRequestedAt: new Date(Date.now() - 2 * 60_000) } });
      const again = await post("/api/auth/forgot-password", { email: user.email });
      assert.equal(again.status, 200);
      assert.equal(mails.length, 2);
      token = tokenFromMail(mails[1]);
      assert.notEqual(token, firstToken);

      const old = await post("/api/auth/reset-password", { token: firstToken, password: newPassword });
      assert.equal(old.status, 400);
      assert.equal((await old.json()).reason, "INVALID_RESET_TOKEN");
    });

    await t.test("a wrong token or a weak password is refused and uses nothing up", async () => {
      const wrong = await post("/api/auth/reset-password", { token: crypto.randomBytes(32).toString("base64url"), password: newPassword });
      assert.equal(wrong.status, 400);
      assert.equal((await wrong.json()).msg, passwordReset.INVALID_TOKEN_MSG);

      const weak = await post("/api/auth/reset-password", { token, password: "short" });
      assert.equal(weak.status, 400);
      assert.equal((await weak.json()).reason, "WEAK_PASSWORD");
      assert.equal((await stored()).passwordResetTokenHash, passwordReset.hashResetToken(token), "the link still works");
    });

    await t.test("an expired link is refused", async () => {
      const { passwordResetExpiresAt } = await stored();
      await User.updateOne({ _id: user._id }, { $set: { passwordResetExpiresAt: new Date(Date.now() - 1000) } });
      const expired = await post("/api/auth/reset-password", { token, password: newPassword });
      assert.equal(expired.status, 400);
      assert.equal((await expired.json()).reason, "INVALID_RESET_TOKEN");
      assert.ok(await bcrypt.compare(oldPassword, (await User.findById(user._id).lean()).password), "password unchanged");
      await User.updateOne({ _id: user._id }, { $set: { passwordResetExpiresAt } });
    });

    await t.test("a valid reset sets the password, uses the link up, and signs out every device", async () => {
      const login = await post("/api/auth/login", { email: user.email, password: oldPassword });
      assert.equal(login.status, 200);
      const session = cookiesOf(login);
      const versionBefore = (await User.findById(user._id).lean()).tokenVersion;
      assert.ok((await RefreshToken.countDocuments({ user: user._id, revokedAt: null })) >= 1);

      const reset = await post("/api/auth/reset-password", { token, password: newPassword });
      assert.equal(reset.status, 200, JSON.stringify(await reset.clone().json()));
      const cleared = cookiesOf(reset);
      assert.equal(cleared.fm_access, "");
      assert.equal(cleared.fm_refresh, "");

      const doc = await stored();
      assert.ok(await bcrypt.compare(newPassword, doc.password));
      assert.equal(doc.passwordResetTokenHash, undefined);
      assert.equal(doc.passwordResetExpiresAt, undefined);
      assert.equal(doc.tokenVersion, versionBefore + 1);
      assert.equal(await RefreshToken.countDocuments({ user: user._id, revokedAt: null }), 0);

      const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: `fm_access=${session.fm_access}` } });
      assert.equal(me.status, 401, "the old access token is refused");
      const refresh = await post("/api/auth/refresh", {}, `fm_refresh=${session.fm_refresh}`);
      assert.equal(refresh.status, 401, "the old refresh token is refused");

      assert.equal((await post("/api/auth/login", { email: user.email, password: oldPassword })).status, 400);
      assert.equal((await post("/api/auth/login", { email: user.email, password: newPassword })).status, 200);

      assert.ok(mails.some((m) => /password was changed/i.test(m.subject) && m.to === user.email), "change notice sent");
    });

    await t.test("the same link cannot be used twice", async () => {
      const reuse = await post("/api/auth/reset-password", { token, password: crypto.randomBytes(12).toString("hex") });
      assert.equal(reuse.status, 400);
      assert.ok(await bcrypt.compare(newPassword, (await User.findById(user._id).lean()).password));
    });

    await t.test("a reset with no token is a 400; no email subject mentions the token", async () => {
      assert.equal((await post("/api/auth/reset-password", {})).status, 400);
      for (const m of mails) assert.ok(!/token/i.test(m.subject));
    });
  } finally {
    emailService.sendMail = realSendMail;
    if (prevClientUrl === undefined) delete process.env.CLIENT_URL;
    else process.env.CLIENT_URL = prevClientUrl;
    await new Promise((resolve) => server.close(resolve));
    await RefreshToken.deleteMany({ user: user._id });
    await User.deleteMany({ _id: user._id });
    await mongoose.disconnect();
  }
});
