/**
 * Startup validation of the auth configuration (src/config/auth.js): the
 * server refuses to start without a usable secret or session settings,
 * instead of crashing on the first login. Pure -- no database.
 *
 *   node --test test/authConfig.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const auth = require("../src/config/auth");

const SECRET_32 = "a".repeat(32);
const SECRET_64 = "b".repeat(64);

test("a missing or short JWT_SECRET is refused", () => {
  assert.throws(() => auth.assertAuthConfig({}), { code: "AUTH_CONFIG_INVALID", message: /JWT_SECRET is not set/ });
  assert.throws(() => auth.assertAuthConfig({ JWT_SECRET: "short" }), /at least 32 characters \(it has 5\)/);
  assert.doesNotThrow(() => auth.assertAuthConfig({ JWT_SECRET: SECRET_32 }));
});

test("production needs a 64-character secret and secure cookies", () => {
  assert.throws(() => auth.assertAuthConfig({ NODE_ENV: "production", JWT_SECRET: SECRET_32 }), /at least 64 characters in production/);
  assert.doesNotThrow(() => auth.assertAuthConfig({ NODE_ENV: "production", JWT_SECRET: SECRET_64 }));
  assert.throws(
    () => auth.assertAuthConfig({ NODE_ENV: "production", JWT_SECRET: SECRET_64, COOKIE_SECURE: "false" }),
    /COOKIE_SECURE=false is not allowed in production/,
  );
});

test("the error names every problem at once, never the secret itself", () => {
  const secret = "not-long-enough-secret";
  try {
    auth.assertAuthConfig({ JWT_SECRET: secret, ACCESS_TOKEN_TTL: "soon", REFRESH_TOKEN_TTL_DAYS: "365" });
    assert.fail("should have thrown");
  } catch (err) {
    assert.match(err.message, /JWT_SECRET/);
    assert.match(err.message, /ACCESS_TOKEN_TTL/);
    assert.match(err.message, /REFRESH_TOKEN_TTL_DAYS/);
    assert.equal(err.message.includes(secret), false, "the secret value is never echoed");
  }
});

test("token lifetimes: defaults and parsing", () => {
  assert.equal(auth.accessTokenTtl({}), "15m");
  assert.equal(auth.accessTokenTtlMs({}), 15 * 60_000);
  assert.equal(auth.accessTokenTtlMs({ ACCESS_TOKEN_TTL: "1h" }), 3_600_000);
  assert.equal(auth.parseDuration("900s"), 900_000);
  assert.equal(auth.parseDuration("15 minutes"), null);
  assert.equal(auth.parseDuration("0m"), null);
  assert.equal(auth.refreshTokenTtlMs({}), 7 * 86_400_000);
  assert.throws(() => auth.assertAuthConfig({ JWT_SECRET: SECRET_32, REFRESH_TOKEN_TTL_DAYS: "0" }), /1 to 90/);
});

test("session cookies are httpOnly, SameSite=Strict, and scoped", () => {
  const access = auth.accessCookieOptions({});
  const refresh = auth.refreshCookieOptions({});
  assert.deepEqual(
    { httpOnly: access.httpOnly, sameSite: access.sameSite, path: access.path, maxAge: access.maxAge },
    { httpOnly: true, sameSite: "strict", path: "/", maxAge: 15 * 60_000 },
  );
  assert.equal(refresh.path, "/api/auth", "the refresh token is only ever sent to the auth routes");
  assert.equal(refresh.httpOnly, true);
  assert.equal(auth.cookieSecure({}), false, "plain HTTP on localhost in development");
  assert.equal(auth.cookieSecure({ NODE_ENV: "production" }), true);
  assert.equal(auth.cookieSecure({ COOKIE_SECURE: "true" }), true);
});
