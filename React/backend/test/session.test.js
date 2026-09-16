/**
 * Sessions (src/services/security/session.js): access tokens (HS256 only,
 * tokenVersion-checked, role from the database), refresh tokens (hash-only
 * storage, rotation, the concurrent-refresh grace window, reuse detection)
 * and sign-out (one device, everywhere).
 *
 * DEVELOPMENT TEST DATA, test database only: tagged users and their refresh
 * tokens, removed at the end.
 *
 *   node --test test/session.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const session = require("../src/services/security/session");
const authConfig = require("../src/config/auth");
const RefreshToken = require("../src/models/RefreshToken");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

/** The subset of an Express response the session service uses. */
function fakeRes() {
  const jar = {};
  return {
    jar,
    cookie(name, value, options) {
      jar[name] = { value, options };
      return this;
    },
    clearCookie(name, options) {
      jar[name] = { value: "", options, cleared: true };
      return this;
    },
  };
}

const fakeReq = ({ cookies = {}, headers = {} } = {}) => ({
  cookies,
  ip: "127.0.0.1",
  get: (h) => (h.toLowerCase() === "user-agent" ? "session-test" : undefined),
  header: (h) => headers[h.toLowerCase()],
});

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

test("access tokens carry only id and tokenVersion, and only HS256 is accepted", () => {
  const token = session.signAccessToken({ _id: "64b000000000000000000001", tokenVersion: 3, role: "admin" });
  const payload = session.verifyAccessToken(token);
  assert.equal(payload.user.id, "64b000000000000000000001");
  assert.equal(payload.tv, 3);
  assert.equal(payload.user.role, undefined, "no role claim, even when the user object has one");
  assert.equal(jwt.decode(token, { complete: true }).header.alg, "HS256");

  const hs512 = jwt.sign({ user: { id: "64b000000000000000000001" } }, process.env.JWT_SECRET, { algorithm: "HS512" });
  assert.throws(() => session.verifyAccessToken(hs512), /invalid algorithm/, "right secret, wrong algorithm: refused");
  const unsigned = jwt.sign({ user: { id: "64b000000000000000000001" } }, null, { algorithm: "none" });
  assert.throws(() => session.verifyAccessToken(unsigned));
});

test("accessTokenFrom: the session cookie first, then x-auth-token or Bearer", () => {
  assert.deepEqual(
    session.accessTokenFrom(fakeReq({ cookies: { fm_access: "c" }, headers: { "x-auth-token": "h" } })),
    { token: "c", source: "cookie" },
  );
  assert.deepEqual(session.accessTokenFrom(fakeReq({ headers: { "x-auth-token": "h" } })), { token: "h", source: "header" });
  assert.deepEqual(session.accessTokenFrom(fakeReq({ headers: { authorization: "Bearer b" } })), { token: "b", source: "header" });
  assert.equal(session.accessTokenFrom(fakeReq()), null);
});

test("readCookie picks one cookie out of a raw Cookie header", () => {
  const header = "theme=dark; fm_access=abc.def.ghi; other=x%20y";
  assert.equal(session.readCookie(header, "fm_access"), "abc.def.ghi");
  assert.equal(session.readCookie(header, "other"), "x y");
  assert.equal(session.readCookie(header, "fm_refresh"), null);
  assert.equal(session.readCookie(undefined, "fm_access"), null);
});

test("refresh tokens: unique hash, and MongoDB removes expired ones", () => {
  const indexes = RefreshToken.schema.indexes();
  assert.ok(
    indexes.some(([keys, opts]) => keys.expiresAt === 1 && opts.expireAfterSeconds === 0),
    "TTL index on expiresAt",
  );
  assert.equal(RefreshToken.schema.path("tokenHash").options.unique, true);
});

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

test("sessions against MongoDB", async (t) => {
  const MONGO = require("./helpers/testDb").uri();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const User = require("../src/models/User");
  await RefreshToken.init();
  const tag = `session-${Date.now()}`;
  const [customer, vendor] = await User.insertMany([
    { name: `${tag}-c`, email: `${tag}-c@example.com`, password: "not-a-real-hash", role: "customer", isVerified: true },
    { name: `${tag}-v`, email: `${tag}-v@example.com`, password: "not-a-real-hash", role: "vendor", isVerified: true },
  ]);
  const userIds = [customer._id, vendor._id];

  try {
    await t.test("issueSession sets httpOnly SameSite=Strict cookies and stores only a hash", async () => {
      const res = fakeRes();
      const accessToken = await session.issueSession(fakeReq(), res, customer);

      const access = res.jar[authConfig.ACCESS_COOKIE];
      const refresh = res.jar[authConfig.REFRESH_COOKIE];
      assert.equal(access.value, accessToken);
      assert.deepEqual(
        [access.options.httpOnly, access.options.sameSite, access.options.path],
        [true, "strict", "/"],
      );
      assert.deepEqual(
        [refresh.options.httpOnly, refresh.options.sameSite, refresh.options.path],
        [true, "strict", "/api/auth"],
      );

      const stored = await RefreshToken.findOne({ user: customer._id }).lean();
      assert.equal(stored.tokenHash, session.hashToken(refresh.value));
      assert.equal(JSON.stringify(stored).includes(refresh.value), false, "the raw refresh token is never stored");
      assert.equal(stored.userAgent, "session-test");
    });

    await t.test("resolveAccessToken: role from the database, tokenVersion enforced", async () => {
      const token = session.signAccessToken(customer);
      assert.deepEqual(
        (({ id, role, tokenVersion }) => ({ id, role, tokenVersion }))(await session.resolveAccessToken(token)),
        { id: String(customer._id), role: "customer", tokenVersion: 0 },
      );

      // A token whose payload claims admin is still the customer it belongs to.
      const claimed = jwt.sign({ user: { id: String(customer._id), role: "admin" } }, process.env.JWT_SECRET);
      assert.equal((await session.resolveAccessToken(claimed)).role, "customer");

      const stale = jwt.sign({ user: { id: String(customer._id) }, tv: 7 }, process.env.JWT_SECRET);
      assert.equal(await session.resolveAccessToken(stale), null, "an old tokenVersion is refused");
      const ghost = jwt.sign({ user: { id: String(new mongoose.Types.ObjectId()) } }, process.env.JWT_SECRET);
      assert.equal(await session.resolveAccessToken(ghost), null, "a deleted user is signed out");
      assert.equal(await session.resolveAccessToken("not-a-token"), null);
    });

    await t.test("refresh rotates the token within its family", async () => {
      const first = fakeRes();
      await session.issueSession(fakeReq(), first, vendor);
      const raw1 = first.jar.fm_refresh.value;

      const second = fakeRes();
      const { user, accessToken } = await session.rotateRefreshToken(fakeReq({ cookies: { fm_refresh: raw1 } }), second);
      assert.equal(String(user._id), String(vendor._id));
      assert.equal(user.password, undefined);
      assert.equal(second.jar.fm_access.value, accessToken);
      const raw2 = second.jar.fm_refresh.value;
      assert.notEqual(raw2, raw1);

      const old = await RefreshToken.findOne({ tokenHash: session.hashToken(raw1) }).lean();
      const next = await RefreshToken.findOne({ tokenHash: session.hashToken(raw2) }).lean();
      assert.equal(old.revokedReason, "rotated");
      assert.equal(String(old.replacedBy), String(next._id));
      assert.equal(next.family, old.family);
      assert.equal(next.revokedAt, null);

      // Two tabs refreshing at once: the loser is told to retry, nothing is revoked.
      await assert.rejects(
        session.rotateRefreshToken(fakeReq({ cookies: { fm_refresh: raw1 } }), fakeRes()),
        { reason: "REFRESH_IN_PROGRESS", status: 401 },
      );
      assert.equal((await RefreshToken.findById(next._id).lean()).revokedAt, null, "the winner's token still works");

      // The same old token presented after the grace window: stolen. The whole family goes.
      const later = new Date(old.revokedAt.getTime() + session.REFRESH_RACE_GRACE_MS + 1000);
      await assert.rejects(
        session.rotateRefreshToken(fakeReq({ cookies: { fm_refresh: raw1 } }), fakeRes(), { now: later }),
        { reason: "REFRESH_TOKEN_REUSED" },
      );
      assert.equal((await RefreshToken.findById(next._id).lean()).revokedReason, "reuse_detected");
      await assert.rejects(
        session.rotateRefreshToken(fakeReq({ cookies: { fm_refresh: raw2 } }), fakeRes(), { now: later }),
        { status: 401 },
        "the thief's copy no longer works either",
      );
    });

    await t.test("missing, unknown and expired refresh tokens are refused", async () => {
      await assert.rejects(session.rotateRefreshToken(fakeReq(), fakeRes()), { reason: "NO_REFRESH_TOKEN" });
      await assert.rejects(
        session.rotateRefreshToken(fakeReq({ cookies: { fm_refresh: "made-up" } }), fakeRes()),
        { reason: "INVALID_REFRESH_TOKEN" },
      );
      const res = fakeRes();
      await session.issueSession(fakeReq(), res, customer);
      const future = new Date(Date.now() + authConfig.refreshTokenTtlMs() + 60_000);
      await assert.rejects(
        session.rotateRefreshToken(fakeReq({ cookies: { fm_refresh: res.jar.fm_refresh.value } }), fakeRes(), { now: future }),
        { reason: "INVALID_REFRESH_TOKEN" },
      );
    });

    await t.test("revokeCurrentSession signs out this device only", async () => {
      const deviceA = fakeRes();
      const deviceB = fakeRes();
      await session.issueSession(fakeReq(), deviceA, vendor);
      await session.issueSession(fakeReq(), deviceB, vendor);

      const out = fakeRes();
      await session.revokeCurrentSession(fakeReq({ cookies: { fm_refresh: deviceA.jar.fm_refresh.value } }), out);
      assert.equal(out.jar.fm_access.cleared, true);
      assert.equal(out.jar.fm_refresh.cleared, true);
      assert.equal(out.jar.fm_refresh.options.path, "/api/auth", "cleared on the path it was set on");
      assert.equal(out.jar.fm_refresh.options.maxAge, undefined);

      await assert.rejects(
        session.rotateRefreshToken(fakeReq({ cookies: { fm_refresh: deviceA.jar.fm_refresh.value } }), fakeRes()),
        { status: 401 },
      );
      await session.rotateRefreshToken(fakeReq({ cookies: { fm_refresh: deviceB.jar.fm_refresh.value } }), fakeRes());
    });

    await t.test("revokeAllSessions: old access tokens and every refresh token stop working", async () => {
      const res = fakeRes();
      const oldAccess = await session.issueSession(fakeReq(), res, customer);
      assert.ok(await session.resolveAccessToken(oldAccess));

      const result = await session.revokeAllSessions(customer._id);
      assert.equal(result.tokenVersion, 1);
      assert.equal(await session.resolveAccessToken(oldAccess), null);
      assert.equal(await RefreshToken.countDocuments({ user: customer._id, revokedAt: null }), 0);
      await assert.rejects(
        session.rotateRefreshToken(fakeReq({ cookies: { fm_refresh: res.jar.fm_refresh.value } }), fakeRes()),
        { status: 401 },
      );

      // A session started afterwards carries the new version and works.
      const fresh = await session.issueSession(fakeReq(), fakeRes(), await User.findById(customer._id).lean());
      assert.equal((await session.resolveAccessToken(fresh)).tokenVersion, 1);

      assert.equal(await session.revokeAllSessions(new mongoose.Types.ObjectId()), null);
      assert.equal(await session.revokeAllSessions("not-an-id"), null);
    });
  } finally {
    await RefreshToken.deleteMany({ user: { $in: userIds } });
    await User.deleteMany({ _id: { $in: userIds } });
    await mongoose.disconnect();
  }
});
