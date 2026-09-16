/**
 * An email address signs in however it is capitalised or padded: login,
 * registration (stored lowercase, duplicates caught regardless of case) and
 * forgot-password. In-process app, test database only; email sending replaced
 * by a recorder.
 *
 * DEVELOPMENT TEST DATA: tagged users with throwaway passwords, removed at the end.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const testDb = require("./helpers/testDb");
const { normaliseEmail, emailLookup } = require("../src/utils/email");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("normaliseEmail / emailLookup", () => {
  assert.equal(normaliseEmail("  Saurabh07062@Gmail.COM "), "saurabh07062@gmail.com");
  assert.equal(normaliseEmail(undefined), "");
  assert.deepEqual(emailLookup(""), { _id: null }, "an empty email matches no account");
  const q = emailLookup("A.B+x@Example.com");
  assert.ok(q.email.test("a.b+x@example.com"));
  assert.ok(!q.email.test("aXb+x@example.com"), "dots are literal, not wildcards");
  assert.ok(!q.email.test("a.b+x@example.com.evil"), "anchored: no suffix match");
});

test("email case against MongoDB", async (t) => {
  const MONGO = testDb.uri(); // also blanks SMTP
  process.env.REDIS_URL = ""; // in-process rate limits: no counts carried over between runs
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const User = require("../src/models/User");
  const RefreshToken = require("../src/models/RefreshToken");
  const emailService = require("../src/services/notification/emailService");
  const mails = [];
  const realSendMail = emailService.sendMail;
  emailService.sendMail = async (m) => {
    mails.push(m);
    return true;
  };

  const tag = `emailcase-${Date.now()}`;
  const password = crypto.randomBytes(12).toString("hex"); // throwaway
  const stored = `${tag}-admin@example.com`;
  await User.create({ name: `${tag}-admin`, email: stored, password: await bcrypt.hash(password, 4), role: "admin", isVerified: true });

  const app = express().use(express.json()).use(cookieParser()).use("/api/auth", require("../src/routes/authRoutes"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) =>
    fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json", origin: base }, body: JSON.stringify(body) });

  try {
    await t.test("login works with a capitalised, padded email", async () => {
      const res = await post("/api/auth/login", { email: `  ${stored.toUpperCase()} `, password });
      assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
      assert.equal((await res.json()).user.role, "admin");
    });

    await t.test("a wrong password is still refused, whatever the case", async () => {
      const res = await post("/api/auth/login", { email: stored.toUpperCase(), password: "wrong-password-1" });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).msg, "Invalid Credentials");
    });

    await t.test("a login without a password is refused, not a server error", async () => {
      const res = await post("/api/auth/login", { email: stored });
      assert.equal(res.status, 400);
    });

    await t.test("registration stores the email lowercase and refuses the same address in another case", async () => {
      const mixed = `${tag}-New@Example.COM`;
      const first = await post("/api/auth/register", { name: "New", email: ` ${mixed} `, password: "long-enough-1" });
      assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
      const saved = await User.findOne({ email: mixed.toLowerCase() }).lean();
      assert.ok(saved, "stored lowercase and trimmed");

      const dup = await post("/api/auth/register", { name: "Dup", email: mixed.toLowerCase(), password: "long-enough-1" });
      assert.equal(dup.status, 400, "the same address in another case is a duplicate");
      assert.equal(await User.countDocuments({ email: new RegExp(`^${tag}-new@example\\.com$`, "i") }), 1);
    });

    await t.test("forgot-password finds the account whatever the case", async () => {
      mails.length = 0;
      const res = await post("/api/auth/forgot-password", { email: stored.toUpperCase() });
      assert.equal(res.status, 200);
      assert.equal(mails.length, 1, "the reset email was sent to the real account");
      assert.equal(mails[0].to, stored);
    });
  } finally {
    emailService.sendMail = realSendMail;
    await new Promise((r) => server.close(r));
    const users = await User.find({ email: new RegExp(`^${tag}-`, "i") }).select("_id").lean();
    await RefreshToken.deleteMany({ user: { $in: users.map((u) => u._id) } });
    await User.deleteMany({ _id: { $in: users.map((u) => u._id) } });
    await mongoose.disconnect();
  }
});
