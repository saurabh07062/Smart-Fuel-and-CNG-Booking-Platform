/**
 * Sessions: short-lived access tokens and rotating refresh tokens, carried in
 * httpOnly cookies (settings: config/auth.js). The one place tokens are made
 * and checked.
 *
 *   issueSession        login / registration / vendor code redemption: sets
 *                       fm_access (JWT, 15 min) and fm_refresh (random, 7 days)
 *   resolveAccessToken  who a request is: signature + expiry (algorithm pinned
 *                       to HS256), a user that still exists, and a tokenVersion
 *                       that has not been bumped since the token was issued
 *   rotateRefreshToken  POST /api/auth/refresh: the presented refresh token is
 *                       revoked and replaced in the same family; a revoked one
 *                       presented again revokes the whole family (theft)
 *   revokeCurrentSession / revokeAllSessions  logout / logout everywhere
 *
 * Refresh tokens are stored only as SHA-256 hashes (models/RefreshToken.js).
 * Every jwt.sign here is synchronous, so a failure is an exception inside the
 * caller's try -- never a throw from a callback that takes the process down.
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../../models/User");
const RefreshToken = require("../../models/RefreshToken");
const metrics = require("../core/metrics");
const authConfig = require("../../config/auth");

const ALGORITHM = "HS256";

/**
 * Two tabs refreshing with the same token at the same moment: one wins, the
 * other finds it just rotated. Within this window that is a race, not theft --
 * the losing tab already has the winner's cookies and can simply retry.
 */
const REFRESH_RACE_GRACE_MS = 30_000;

class SessionError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.name = "SessionError";
    this.status = status;
    this.reason = reason;
  }
}

const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");
const tokenVersionOf = (user) => Number(user?.tokenVersion) || 0;
const idOf = (user) => String(user?._id || user?.id || "");

// ------------------------------------------------------------ access tokens

/** Synchronous. Carries only the user id and tokenVersion -- never a role. */
function signAccessToken(user) {
  return jwt.sign({ user: { id: idOf(user) }, tv: tokenVersionOf(user) }, process.env.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: authConfig.accessTokenTtl(),
  });
}

/** The payload of a valid token; throws otherwise. Only HS256 is accepted. */
function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: [ALGORITHM] });
}

/**
 * The access token a request carries: the session cookie, else an
 * x-auth-token / Authorization: Bearer header (scripts, tests, non-browser
 * clients -- headers cannot be sent cross-site by a browser on their own).
 * @returns {{token:string, source:"cookie"|"header"}|null}
 */
function accessTokenFrom(req) {
  const cookie = req.cookies?.[authConfig.ACCESS_COOKIE];
  if (typeof cookie === "string" && cookie) return { token: cookie, source: "cookie" };
  const header = req.header?.("x-auth-token") || req.header?.("authorization")?.replace(/^Bearer\s+/i, "");
  return header ? { token: header, source: "header" } : null;
}

/**
 * The identity behind an access token, or null when it is not (or no longer)
 * valid. Role and status come from the database, never from the token.
 * @returns {Promise<{id:string, role:string, vendorStatus:string, activated:boolean, tokenVersion:number}|null>}
 */
async function resolveAccessToken(token) {
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return null;
  }
  const id = payload?.user?.id;
  if (!id || !mongoose.isValidObjectId(id)) return null;

  const user = await User.findById(id).select("role vendorStatus activated tokenVersion").lean();
  if (!user) return null;
  if ((Number(payload.tv) || 0) !== tokenVersionOf(user)) {
    metrics.inc("access_token_revoked_count");
    return null;
  }
  return {
    id: String(user._id),
    role: user.role,
    vendorStatus: user.vendorStatus,
    activated: user.activated,
    tokenVersion: tokenVersionOf(user),
  };
}

/** One cookie from a raw Cookie header (the Socket.IO handshake has no cookie-parser). */
function readCookie(cookieHeader, name) {
  for (const part of String(cookieHeader || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

// ----------------------------------------------------------- refresh tokens

async function createRefreshToken(user, { family = crypto.randomUUID(), req = null, now = new Date() } = {}) {
  const raw = crypto.randomBytes(48).toString("base64url");
  const doc = await RefreshToken.create({
    user: idOf(user),
    tokenHash: hashToken(raw),
    family,
    expiresAt: new Date(now.getTime() + authConfig.refreshTokenTtlMs()),
    userAgent: req?.get?.("user-agent") ? String(req.get("user-agent")).slice(0, 300) : null,
    ip: req?.ip ? String(req.ip).slice(0, 64) : null,
  });
  return { raw, doc };
}

function setSessionCookies(res, accessToken, refreshRaw) {
  res.cookie(authConfig.ACCESS_COOKIE, accessToken, authConfig.accessCookieOptions());
  res.cookie(authConfig.REFRESH_COOKIE, refreshRaw, authConfig.refreshCookieOptions());
}

function clearSessionCookies(res) {
  // clearCookie must match path/flags but must not carry maxAge.
  const { maxAge: _accessMaxAge, ...access } = authConfig.accessCookieOptions();
  const { maxAge: _refreshMaxAge, ...refresh } = authConfig.refreshCookieOptions();
  res.clearCookie(authConfig.ACCESS_COOKIE, access);
  res.clearCookie(authConfig.REFRESH_COOKIE, refresh);
}

function revokeFamily(family, reason, now = new Date()) {
  return RefreshToken.updateMany({ family, revokedAt: null }, { $set: { revokedAt: now, revokedReason: reason } });
}

/**
 * Start a session for `user`: both cookies on `res`.
 * @returns {Promise<string>} the access token
 */
async function issueSession(req, res, user) {
  const accessToken = signAccessToken(user);
  const { raw } = await createRefreshToken(user, { req });
  setSessionCookies(res, accessToken, raw);
  metrics.inc("session_issued_count");
  return accessToken;
}

/**
 * Exchange the fm_refresh cookie for a fresh session.
 * @returns {Promise<{user:object, accessToken:string}>}
 * @throws {SessionError} 401: NO_REFRESH_TOKEN, INVALID_REFRESH_TOKEN,
 *   REFRESH_IN_PROGRESS (a concurrent refresh just won -- retry the request),
 *   REFRESH_TOKEN_REUSED (a revoked token came back: its family is revoked)
 */
async function rotateRefreshToken(req, res, { now = new Date() } = {}) {
  const raw = req.cookies?.[authConfig.REFRESH_COOKIE];
  if (typeof raw !== "string" || !raw) {
    throw new SessionError(401, "NO_REFRESH_TOKEN", "Please sign in again.");
  }
  const tokenHash = hashToken(raw);

  // Atomic claim: of two concurrent refreshes with one token, exactly one wins.
  const current = await RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { revokedAt: now, revokedReason: "rotated" } },
    { returnDocument: "before" },
  ).lean();

  if (!current) {
    const known = await RefreshToken.findOne({ tokenHash }).select("family revokedAt revokedReason").lean();
    if (known?.revokedReason === "rotated" && now - new Date(known.revokedAt) <= REFRESH_RACE_GRACE_MS) {
      throw new SessionError(401, "REFRESH_IN_PROGRESS", "Your session was just refreshed. Please retry.");
    }
    if (known?.revokedAt) {
      await revokeFamily(known.family, "reuse_detected", now);
      metrics.inc("refresh_token_reuse_detected_count");
      throw new SessionError(401, "REFRESH_TOKEN_REUSED", "Please sign in again.");
    }
    throw new SessionError(401, "INVALID_REFRESH_TOKEN", "Please sign in again.");
  }

  const user = await User.findById(current.user).select("-password").lean();
  if (!user) {
    await revokeFamily(current.family, "logout", now);
    throw new SessionError(401, "INVALID_REFRESH_TOKEN", "Please sign in again.");
  }

  const accessToken = signAccessToken(user);
  const { raw: nextRaw, doc } = await createRefreshToken(user, { family: current.family, req, now });
  await RefreshToken.updateOne({ _id: current._id }, { $set: { replacedBy: doc._id } });
  setSessionCookies(res, accessToken, nextRaw);
  metrics.inc("session_refreshed_count");
  return { user, accessToken };
}

/** Sign this device out: revoke its refresh-token family and clear the cookies. */
async function revokeCurrentSession(req, res, { now = new Date() } = {}) {
  const raw = req.cookies?.[authConfig.REFRESH_COOKIE];
  if (typeof raw === "string" && raw) {
    const token = await RefreshToken.findOne({ tokenHash: hashToken(raw) }).select("family").lean();
    if (token) await revokeFamily(token.family, "logout", now);
  }
  clearSessionCookies(res);
}

/**
 * Sign a user out everywhere: every access token fails at its next use
 * (tokenVersion), every refresh token is revoked, and their live sockets are
 * disconnected. Password reset calls this too.
 * @returns {Promise<{tokenVersion:number}|null>} null when there is no such user
 */
async function revokeAllSessions(userId, { now = new Date() } = {}) {
  if (!mongoose.isValidObjectId(userId)) return null;
  const updated = await User.findByIdAndUpdate(userId, { $inc: { tokenVersion: 1 } }, { returnDocument: "after" })
    .select("tokenVersion")
    .lean();
  if (!updated) return null;

  await RefreshToken.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: now, revokedReason: "logout_all" } },
  );
  try {
    const realtime = require("../notification/realtime");
    if (typeof realtime.disconnectUser === "function") realtime.disconnectUser(userId);
  } catch (err) {
    console.error("[session] could not disconnect sockets:", err.message);
  }
  metrics.inc("session_revoke_all_count");
  return { tokenVersion: tokenVersionOf(updated) };
}

module.exports = {
  ALGORITHM,
  REFRESH_RACE_GRACE_MS,
  SessionError,
  hashToken,
  signAccessToken,
  verifyAccessToken,
  accessTokenFrom,
  resolveAccessToken,
  readCookie,
  issueSession,
  rotateRefreshToken,
  revokeCurrentSession,
  revokeAllSessions,
  clearSessionCookies,
};
