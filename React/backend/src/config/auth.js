/**
 * Authentication settings, validated once at startup.
 *
 * A server with no usable JWT_SECRET used to start normally and then crash on
 * the first login (jwt.sign threw inside a callback, outside any try). Now it
 * refuses to start and says why, before accepting a single request:
 *
 *   JWT_SECRET               required; at least 32 characters, 64 in production
 *   ACCESS_TOKEN_TTL         access token lifetime, e.g. "15m" (default), "1h"
 *   REFRESH_TOKEN_TTL_DAYS   refresh token lifetime in days, 1-90 (default 7)
 *   COOKIE_SECURE            "true" / "false"; defaults to true in production.
 *                            Production refuses "false": browsers would then
 *                            send the session cookies over plain HTTP.
 *
 * Session cookies (services/security/session.js):
 *   fm_access   the access JWT, sent with every request (path /)
 *   fm_refresh  the refresh token, sent only to /api/auth
 * Both httpOnly (no script can read them) and SameSite=Strict.
 */

const MIN_SECRET_LENGTH = 32;
const MIN_PRODUCTION_SECRET_LENGTH = 64;
const DEFAULT_ACCESS_TOKEN_TTL = "15m";
const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 7;
const MAX_REFRESH_TOKEN_TTL_DAYS = 90;

const ACCESS_COOKIE = "fm_access";
const REFRESH_COOKIE = "fm_refresh";
const REFRESH_COOKIE_PATH = "/api/auth";

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

const isProduction = (env) => env.NODE_ENV === "production";

/** "15m" -> 900000. null for anything else. */
function parseDuration(text) {
  const match = /^(\d+)\s*([smhd])$/i.exec(String(text || "").trim());
  if (!match) return null;
  const ms = Number(match[1]) * UNIT_MS[match[2].toLowerCase()];
  return ms > 0 ? ms : null;
}

function accessTokenTtl(env = process.env) {
  return env.ACCESS_TOKEN_TTL || DEFAULT_ACCESS_TOKEN_TTL;
}

function accessTokenTtlMs(env = process.env) {
  return parseDuration(accessTokenTtl(env));
}

function refreshTokenTtlDays(env = process.env) {
  const raw = env.REFRESH_TOKEN_TTL_DAYS;
  return raw === undefined || raw === "" ? DEFAULT_REFRESH_TOKEN_TTL_DAYS : Number(raw);
}

function refreshTokenTtlMs(env = process.env) {
  return refreshTokenTtlDays(env) * UNIT_MS.d;
}

function cookieSecure(env = process.env) {
  if (env.COOKIE_SECURE === "true") return true;
  if (env.COOKIE_SECURE === "false") return false;
  return isProduction(env);
}

/** Every reason the auth configuration is unusable; empty when it is fine. */
function authConfigProblems(env = process.env) {
  const problems = [];

  const secret = env.JWT_SECRET || "";
  const minLength = isProduction(env) ? MIN_PRODUCTION_SECRET_LENGTH : MIN_SECRET_LENGTH;
  if (!secret) {
    problems.push("JWT_SECRET is not set");
  } else if (secret.length < minLength) {
    problems.push(
      `JWT_SECRET must be at least ${minLength} characters${isProduction(env) ? " in production" : ""} (it has ${secret.length})`,
    );
  }

  if (accessTokenTtlMs(env) === null) {
    problems.push(`ACCESS_TOKEN_TTL must look like "15m", "1h" or "900s" (got "${env.ACCESS_TOKEN_TTL}")`);
  }

  const days = refreshTokenTtlDays(env);
  if (!Number.isInteger(days) || days < 1 || days > MAX_REFRESH_TOKEN_TTL_DAYS) {
    problems.push(`REFRESH_TOKEN_TTL_DAYS must be a whole number from 1 to ${MAX_REFRESH_TOKEN_TTL_DAYS} (got "${env.REFRESH_TOKEN_TTL_DAYS}")`);
  }

  if (isProduction(env) && env.COOKIE_SECURE === "false") {
    problems.push("COOKIE_SECURE=false is not allowed in production (session cookies would travel over plain HTTP)");
  }

  return problems;
}

/** Throw (code AUTH_CONFIG_INVALID) when the server must not start. */
function assertAuthConfig(env = process.env) {
  const problems = authConfigProblems(env);
  if (problems.length) {
    const err = new Error(`Refusing to start: ${problems.join("; ")}.`);
    err.code = "AUTH_CONFIG_INVALID";
    throw err;
  }
}

function accessCookieOptions(env = process.env) {
  return { httpOnly: true, secure: cookieSecure(env), sameSite: "strict", path: "/", maxAge: accessTokenTtlMs(env) };
}

function refreshCookieOptions(env = process.env) {
  return {
    httpOnly: true,
    secure: cookieSecure(env),
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
    maxAge: refreshTokenTtlMs(env),
  };
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  MIN_SECRET_LENGTH,
  MIN_PRODUCTION_SECRET_LENGTH,
  parseDuration,
  accessTokenTtl,
  accessTokenTtlMs,
  refreshTokenTtlMs,
  cookieSecure,
  authConfigProblems,
  assertAuthConfig,
  accessCookieOptions,
  refreshCookieOptions,
};
