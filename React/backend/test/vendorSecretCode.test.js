/**
 * Vendor secret code: end-to-end.
 *
 * Exercises the real HTTP API against the real database, not stubs -- the
 * point of these tests is that the *deployed* path is safe, and a mock of the
 * verification route would prove nothing about it.
 *
 * The one thing that cannot go over HTTP is obtaining a code: by design the
 * plaintext exists only inside the approval email, and no API returns it.
 * So the tests call issueSecretCode directly -- the identical function the
 * approve endpoint calls -- and then drive everything else through HTTP.
 * That the approve endpoint really does issue and really does not leak is
 * itself covered, over HTTP, below.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const API = require("./helpers/testDb").apiUrl();
const MONGO = require("./helpers/testDb").uri();

const secretCode = require("../src/services/vendor/vendorSecretCode");

// ---------------------------------------------------------------- units

test("generateSecretCode: unpredictable, and never derived from the vendor", () => {
  const codes = new Set();
  for (let i = 0; i < 500; i += 1) codes.add(secretCode.generateSecretCode());
  assert.equal(codes.size, 500, "500 draws produced a collision -- not random enough");

  const one = secretCode.generateSecretCode();
  assert.match(one, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
  // The ambiguous glyphs must not appear: these are typed by hand off a screen.
  assert.ok(!/[IO01]/.test(one), `code ${one} contains an ambiguous character`);
});

test("normalise: accepts what a human actually types", () => {
  const n = secretCode.normalise;
  assert.equal(n("abcde-fghjk"), "ABCDEFGHJK");
  assert.equal(n("ABCDE FGHJK"), "ABCDEFGHJK");
  assert.equal(n("  abcdefghjk "), "ABCDEFGHJK");
});

// ------------------------------------------------------------- live flow

test("vendor secret code: full lifecycle over the real API", async (t) => {
  const reachable = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) })
    .then((r) => r.ok)
    .catch(() => false);

  if (!reachable) {
    t.skip(`API not reachable at ${API} — start the stack to run this test`);
    return;
  }

  const mongoose = require("mongoose");
  const bcrypt = require("bcryptjs");
  const jwt = require("jsonwebtoken");
  await mongoose.connect(MONGO);

  const User = require("../src/models/User");
  const tag = `sectest-${Date.now()}`;
  const password = "sectest12345";

  const mkVendor = async (suffix, status) =>
    User.create({
      name: `${tag}-${suffix}`,
      email: `${tag}-${suffix}@fuelmart.test`,
      password: await bcrypt.hash(password, 8),
      role: "vendor",
      vendorStatus: status,
      businessName: `${tag} Fuels`,
      isVerified: true,
    });

  // Clear this endpoint's rate-limit counters before starting.
  //
  // The limiter is Redis-backed when REDIS_URL is set, so counts survive a
  // server restart and a 10-minute window straddles consecutive test runs --
  // the suite makes ~20 verify calls and would otherwise 429 itself on the
  // second run of the day. This resets only the two vendor-access buckets;
  // it is a test precondition, not a backdoor, and there is no code path in
  // the application that does it.
  async function clearRateLimits() {
    if (!process.env.REDIS_URL) return; // in-memory limiter dies with the server
    let client = null;
    try {
      // Must fail fast. A bare createClient() retries a dead Redis forever
      // and connect() never settles, which hung the whole test run -- the
      // same defect services/core/redisConnect.js exists to prevent. Reuse it
      // rather than hand-rolling a second connector with the same bug.
      const { connectRedis, destroyQuietly } = require("../src/services/core/redisConnect");
      client = await connectRedis("test-ratelimit-reset");
      if (!client) return; // Redis unreachable: the in-memory limiter applies
      for (const prefix of ["vendor-access-ip", "vendor-access-email"]) {
        const keys = await client.keys(`ratelimit:${prefix}:*`);
        if (keys.length) await client.del(keys);
      }
    } catch {
      /* no Redis reachable: the in-memory limiter applies and resets itself */
    } finally {
      if (client) {
        const { destroyQuietly } = require("../src/services/core/redisConnect");
        await destroyQuietly(client);
      }
    }
  }
  await clearRateLimits();

  const post = (body) =>
    fetch(`${API}/api/vendor-access/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json(), cookies: r.headers.getSetCookie() }));
  // The session is httpOnly cookies, never a token in the body.
  const sessionCookie = (res) => res.cookies.find((c) => c.startsWith("fm_access="));

  let failure = null;
  try {
    // ---------------------------------------------- happy path
    await t.test("a correct code signs the vendor in with an httpOnly session cookie", async () => {
      const v = await mkVendor("ok", "active");
      const { code } = await secretCode.issueSecretCode(v);
      await v.save();

      const res = await post({ email: v.email, code });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.ok, true);
      assert.equal(res.body.token, undefined, "no token in the body: the session is in httpOnly cookies");

      const access = sessionCookie(res);
      assert.ok(access, "no session cookie set");
      assert.match(access, /HttpOnly/i);
      assert.match(access, /SameSite=Strict/i);

      // The cookie must be a real, verifiable session for THIS vendor.
      const token = decodeURIComponent(access.split(";")[0].slice("fm_access=".length));
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
      assert.equal(String(decoded.user.id), String(v._id));

      // ...and it must actually open the protected dashboard API.
      const session = await fetch(`${API}/api/vendor-access/session`, {
        headers: { cookie: `fm_access=${encodeURIComponent(token)}` },
      });
      assert.equal(session.status, 200, "the issued token does not open the panel");

      // Nothing about the code may come back in the response.
      const asText = JSON.stringify(res.body);
      assert.ok(!asText.includes(secretCode.normalise(code)), "response leaked the code");
      assert.ok(!/secretCodeHash/.test(asText), "response leaked the hash");
    });

    // ------------------------------------------- storage is hashed
    await t.test("only a hash is stored, and it is hidden by default", async () => {
      const v = await mkVendor("hash", "active");
      const { code } = await secretCode.issueSecretCode(v);
      await v.save();

      // An ordinary query must not return the verifier at all.
      const plain = await User.findById(v._id).lean();
      assert.equal(plain.secretCodeHash, undefined, "hash came back on a normal query");

      // Even asked for explicitly, it is a bcrypt digest, not the code.
      const withHash = await User.findById(v._id).select("+secretCodeHash").lean();
      assert.match(withHash.secretCodeHash, /^\$2[aby]\$/, "not a bcrypt hash");
      assert.ok(
        !withHash.secretCodeHash.includes(secretCode.normalise(code)),
        "the plaintext is recoverable from storage",
      );

      // And no other field anywhere on the document holds it.
      assert.ok(
        !JSON.stringify(withHash).includes(secretCode.normalise(code)),
        "the plaintext is stored somewhere on the user document",
      );
    });

    // --------------------------------------------------- reusable
    await t.test("the same code opens the vendor panel again and again", async () => {
      const v = await mkVendor("reuse", "active");
      const { code } = await secretCode.issueSecretCode(v);
      await v.save();
      const hashBefore = (await User.findById(v._id).select("+secretCodeHash").lean()).secretCodeHash;

      for (let visit = 1; visit <= 3; visit += 1) {
        const res = await post({ email: v.email, code });
        assert.equal(res.status, 200, `visit ${visit}: ${JSON.stringify(res.body)}`);
        const access = sessionCookie(res);
        assert.ok(access, `visit ${visit}: no session cookie`);
        const token = decodeURIComponent(access.split(";")[0].slice("fm_access=".length));
        const panel = await fetch(`${API}/api/vendor-access/session`, { headers: { cookie: `fm_access=${encodeURIComponent(token)}` } });
        assert.equal(panel.status, 200, `visit ${visit}: the session does not open the panel`);
      }

      const after = await User.findById(v._id).select("+secretCodeHash").lean();
      assert.equal(after.secretCodeUsed, false, "the code is never marked used");
      assert.equal(after.secretCodeHash, hashBefore, "the same code is kept, not regenerated");
      assert.equal(after.secretCodeExpiresAt, null, "a used code no longer has a deadline");
      assert.equal(after.secretCodeAttempts, 0);
      assert.equal(after.activated, true);
      assert.ok(after.secretCodeLastUsedAt instanceof Date, "last use is recorded");
    });

    await t.test("a wrong code is refused as Invalid Secret Code, and the real one still works after it", async () => {
      const v = await mkVendor("wrong-then-right", "active");
      const { code } = await secretCode.issueSecretCode(v);
      await v.save();
      assert.equal((await post({ email: v.email, code })).status, 200);

      const wrong = await post({ email: v.email, code: "ZZZZZ-ZZZZZ" });
      assert.equal(wrong.status, 400);
      assert.equal(wrong.body.reason, "INVALID");
      assert.equal(wrong.body.msg, "Invalid Secret Code.");
      assert.ok(!sessionCookie(wrong));

      const again = await post({ email: v.email, code });
      assert.equal(again.status, 200, "one wrong entry does not break the real code");
      assert.equal((await User.findById(v._id).lean()).secretCodeAttempts, 0, "a successful use resets the count");
    });

    await t.test("an admin reissuing a code revokes the old one", async () => {
      const v = await mkVendor("reissue", "active");
      const { code: oldCode } = await secretCode.issueSecretCode(v);
      await v.save();
      assert.equal((await post({ email: v.email, code: oldCode })).status, 200);

      const fresh = await User.findById(v._id).select("+secretCodeHash");
      const { code: newCode } = await secretCode.issueSecretCode(fresh);
      await fresh.save();

      const old = await post({ email: v.email, code: oldCode });
      assert.equal(old.status, 400);
      assert.equal(old.body.msg, "Invalid Secret Code.");
      assert.ok(!sessionCookie(old), "a revoked code still handed out a session");
      assert.equal((await post({ email: v.email, code: newCode })).status, 200);
      assert.equal((await post({ email: v.email, code: newCode })).status, 200, "the new code is reusable too");
    });

    await t.test("a code consumed under the old single-use policy reads as revoked", async () => {
      const v = await mkVendor("legacy", "active");
      await secretCode.issueSecretCode(v);
      v.secretCodeUsed = true; // what the old policy left behind after redemption
      v.secretCodeHash = null;
      v.secretCodeExpiresAt = null;
      await v.save();

      const res = await post({ email: v.email, code: "ABCDE-FGHJK" });
      assert.equal(res.status, 400);
      assert.equal(res.body.reason, "REVOKED");
      assert.match(res.body.msg, /^Invalid Secret Code\. This code is no longer active/);
      assert.ok(!sessionCookie(res));
    });

    // --------------------------------------------------- expiry
    await t.test("an expired code is refused", async () => {
      const v = await mkVendor("expired", "active");
      const { code } = await secretCode.issueSecretCode(v);
      v.secretCodeExpiresAt = new Date(Date.now() - 1000); // one second ago
      await v.save();

      const res = await post({ email: v.email, code });
      assert.equal(res.status, 400);
      assert.equal(res.body.reason, "EXPIRED");
      assert.match(res.body.msg, /^Invalid Secret Code\. This code has expired/);
      assert.ok(!sessionCookie(res));
    });

    // ------------------------------------------- attempt limiting
    await t.test("wrong guesses are counted and then lock the code", async () => {
      const v = await mkVendor("attempts", "active");
      const { code } = await secretCode.issueSecretCode(v);
      await v.save();

      for (let i = 1; i <= secretCode.MAX_ATTEMPTS; i += 1) {
        const res = await post({ email: v.email, code: "ZZZZZ-ZZZZZ" });
        assert.equal(res.status, 400);
        assert.equal(res.body.reason, "INVALID", `attempt ${i} gave ${res.body.reason}`);
      }

      const locked = await post({ email: v.email, code: "ZZZZZ-ZZZZZ" });
      assert.equal(locked.body.reason, "TOO_MANY_ATTEMPTS");

      // The real code must now be dead too -- otherwise the cap is decorative.
      const withReal = await post({ email: v.email, code });
      assert.equal(withReal.body.reason, "TOO_MANY_ATTEMPTS");
      assert.ok(!sessionCookie(withReal), "the attempt cap did not actually block access");
    });

    // ----------------------------------------- status-specific copy
    for (const [status, expected] of [
      ["pending", /waiting for admin approval/i],
      ["under_review", /waiting for admin approval/i],
      ["rejected", /has been rejected/i],
      ["suspended", /currently suspended/i],
    ]) {
      await t.test(`a ${status} vendor is told why, and gets no token`, async () => {
        const v = await mkVendor(`st-${status}`, status);
        // Give them a real code, so the only reason for refusal is the status.
        const { code } = await secretCode.issueSecretCode(v);
        await v.save();

        const res = await post({ email: v.email, code });
        assert.equal(res.status, 403);
        assert.match(res.body.msg, expected);
        assert.ok(!sessionCookie(res), `a ${status} vendor was given a session`);
      });
    }

    // ----------------------------------------- no account enumeration
    //
    // The status messages above ARE an intentional disclosure -- the access
    // policy requires a pending or suspended vendor to be told so. This test
    // pins down that nothing BEYOND that leaks: for a vendor in the normal
    // active state, a wrong code and an address that was never registered
    // must be byte-identical. An earlier version of this route appended
    // "N attempts remaining" to one of them and not the other, which turned
    // it into an account-existence oracle; this is what caught it.
    await t.test("an unknown email is indistinguishable from a bad code", async () => {
      const unknown = await post({
        email: `${tag}-nobody@fuelmart.test`,
        code: "ZZZZZ-ZZZZZ",
      });
      const v = await mkVendor("enum", "active");
      await secretCode.issueSecretCode(v);
      await v.save();
      const badCode = await post({ email: v.email, code: "YYYYY-YYYYY" });

      assert.equal(unknown.status, badCode.status);
      assert.equal(unknown.body.reason, badCode.body.reason);
      assert.equal(unknown.body.msg, badCode.body.msg);
    });

    // ------------------------------------- the dashboard is protected
    await t.test("the vendor dashboard API rejects everyone without a session", async () => {
      const noToken = await fetch(`${API}/api/vendor-access/session`);
      assert.equal(noToken.status, 401, "no token should not reach the panel");

      const junk = await fetch(`${API}/api/vendor-access/session`, {
        headers: { "x-auth-token": "not-a-real-token" },
      });
      assert.equal(junk.status, 401, "a made-up token should not reach the panel");

      // A syntactically valid token for a vendor who has NOT redeemed a code.
      const v = await mkVendor("unactivated", "active");
      await v.save();
      const forged = jwt.sign({ user: { id: v.id } }, process.env.JWT_SECRET, {
        expiresIn: "5h",
      });
      const res = await fetch(`${API}/api/vendor-access/session`, {
        headers: { "x-auth-token": forged },
      });
      assert.equal(res.status, 403, "an approved-but-unverified vendor got in");
      const body = await res.json();
      assert.equal(body.reason, "NOT_ACTIVATED");
    });

    // --------------------------------- approval never leaks the code
    await t.test("the approve endpoint issues a code without revealing it", async () => {
      const admin = await User.findOne({ role: "admin" }).select("_id");
      if (!admin) {
        t.diagnostic("no admin account in this database — skipping the approve check");
        return;
      }
      const adminToken = jwt.sign({ user: { id: admin._id } }, process.env.JWT_SECRET, {
        expiresIn: "10m",
      });

      const v = await mkVendor("approve", "pending");
      const res = await fetch(`${API}/api/vendors/${v._id}/approve`, {
        method: "PATCH",
        headers: { "x-auth-token": adminToken, "Content-Type": "application/json" },
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));

      const asText = JSON.stringify(body);
      assert.ok(!/secretCodeHash/.test(asText), "approve response leaked the hash");
      assert.ok(!/"secretCode"|activationCode/.test(asText), "approve response leaked a code");
      assert.ok(!/password/.test(asText), "approve response leaked the password hash");

      // It really did issue one, hashed, with an expiry.
      const after = await User.findById(v._id).select("+secretCodeHash").lean();
      assert.equal(after.vendorStatus, "active");
      assert.match(after.secretCodeHash, /^\$2[aby]\$/);
      assert.ok(after.secretCodeExpiresAt > new Date(), "issued code is already expired");
      assert.equal(after.secretCodeUsed, false);
      assert.equal(after.activated, false, "approval alone must not activate");
    });

    // ------------------------------------------------- the sweep
    await t.test("the expiry sweep clears dead codes but keeps the vendor", async () => {
      const v = await mkVendor("sweep", "active");
      await secretCode.issueSecretCode(v);
      v.secretCodeExpiresAt = new Date(Date.now() - 60_000);
      await v.save();

      const cleared = await secretCode.sweepExpired(User);
      assert.ok(cleared >= 1, "the sweep cleared nothing");

      const after = await User.findById(v._id).select("+secretCodeHash");
      assert.ok(after, "THE SWEEP DELETED THE VENDOR -- this is why TTL is not used here");
      assert.equal(after.secretCodeHash, null);
      assert.equal(after.email, `${tag}-sweep@fuelmart.test`);
    });

    // ------------------------------------------------ rate limiting
    // LAST on purpose: it deliberately exhausts the per-email bucket, and
    // the limiter lives in the server process where a test cannot reset it.
    await t.test("repeated attempts on one email are rate limited", async () => {
      await clearRateLimits(); // start this one from a known-empty bucket
      const v = await mkVendor("ratelimit", "active");
      await secretCode.issueSecretCode(v);
      await v.save();

      let sawLimit = false;
      for (let i = 0; i < 12; i += 1) {
        const res = await post({ email: v.email, code: "ZZZZZ-ZZZZZ" });
        if (res.status === 429) {
          sawLimit = true;
          assert.match(res.body.msg, /too many requests/i);
          break;
        }
      }
      assert.ok(sawLimit, "the per-email rate limit never engaged");
    });

  } catch (err) {
    failure = err;
  } finally {
    // Approval through the API leaves a "vendor approved" notification.
    const tagged = await User.find({ email: { $regex: `^${tag}-` } }).select("_id").lean();
    await require("../src/models/Notification").deleteMany({ user: { $in: tagged.map((u) => u._id) } });
    await User.deleteMany({ email: { $regex: `^${tag}-` } });
    await mongoose.disconnect();
    await require("../src/services/core/lock").close();
    await require("../src/services/security/rateLimiter").close();
  }

  if (failure) throw failure;
});
