const { isOriginAllowed } = require("../config/cors");
const { ACCESS_COOKIE, REFRESH_COOKIE } = require("../config/auth");

/**
 * Cross-site request protection for cookie sessions.
 *
 * A browser attaches cookies on its own, so a state-changing request that is
 * authenticated by a session cookie must come from an allowed origin
 * (config/cors.js). SameSite=Strict already keeps the cookies off cross-site
 * requests; this is the second lock. Requests without session cookies --
 * header tokens, scripts, tests -- cannot be forged cross-site this way and
 * pass through.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function refererOrigin(referer) {
  try {
    return referer ? new URL(referer).origin : null;
  } catch {
    return null;
  }
}

/** Does this request come from an origin allowed to use the API? A missing Origin (and Referer) is not. */
function originAllowed(req) {
  const origin = req.get("origin") || refererOrigin(req.get("referer"));
  return Boolean(origin) && isOriginAllowed(origin, req.get("host"));
}

/** For routes that act on the session cookies themselves (refresh, logout). */
function requireAllowedOriginForCookies(req, res, next) {
  // The shared pair or any tab's own (fm_access_<tab> / fm_refresh_<tab>).
  const carriesSession = Object.keys(req.cookies || {}).some(
    (name) => name === ACCESS_COOKIE || name === REFRESH_COOKIE || name.startsWith(`${ACCESS_COOKIE}_`) || name.startsWith(`${REFRESH_COOKIE}_`),
  );
  if (!carriesSession || SAFE_METHODS.has(req.method) || originAllowed(req)) return next();
  return res.status(403).json({ msg: "Request origin not allowed", reason: "ORIGIN_NOT_ALLOWED" });
}

module.exports = { SAFE_METHODS, originAllowed, requireAllowedOriginForCookies };
