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

/**
 * The header the FuelMart Android app sends on every request
 * (frontend services/api/apiClient.ts). It is not a secret and is not
 * treated as one -- see nativeClient() for what it is actually good for.
 */
const NATIVE_CLIENT_HEADER = "x-fm-client";
const NATIVE_CLIENTS = new Set(["android"]);

/**
 * Is this the Android app rather than a browser?
 *
 * The app's requests are made by Android itself (Capacitor's native HTTP,
 * outside the WebView), so they carry no Origin and no Referer -- there is
 * no page they came from. That is why they were being refused: the check
 * below treats "no origin" as "not allowed", which is right for a browser
 * and wrong for this.
 *
 * Trusting a header sounds like trusting the caller, so be precise about
 * what this buys. The attack this guard exists to stop is a MALICIOUS PAGE
 * in the customer's browser making a state-changing request that rides
 * their session cookie. Such a page cannot reach here: a cross-origin
 * request with a custom header triggers a CORS preflight, and this server
 * answers that preflight only for allowed origins (config/cors.js). A
 * non-browser client can set any header it likes -- but it also has no
 * session cookie to ride, because cookies are attached by browsers.
 */
function nativeClient(req) {
  const value = String(req.get(NATIVE_CLIENT_HEADER) || "").toLowerCase();
  return NATIVE_CLIENTS.has(value);
}

/** Does this request come from an origin allowed to use the API? A missing Origin (and Referer) is not, unless it is the app. */
function originAllowed(req) {
  const origin = req.get("origin") || refererOrigin(req.get("referer"));
  if (!origin) return nativeClient(req);
  return isOriginAllowed(origin, req.get("host"));
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

module.exports = { SAFE_METHODS, originAllowed, requireAllowedOriginForCookies, NATIVE_CLIENT_HEADER };
