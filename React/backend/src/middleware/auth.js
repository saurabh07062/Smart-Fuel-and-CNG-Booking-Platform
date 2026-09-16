const { accessTokenFrom, resolveAccessToken } = require("../services/security/session");
const { SAFE_METHODS, originAllowed } = require("./origin");

/**
 * Authenticates every request that needs a signed-in user.
 *
 * The access token comes from the httpOnly fm_access cookie, or -- for
 * scripts, tests and non-browser clients -- an x-auth-token / Authorization:
 * Bearer header (services/security/session.js). It must be a valid HS256
 * token whose user still exists and whose tokenVersion has not been bumped by
 * "log out everywhere". req.user is { id, role, vendorStatus, activated,
 * tokenVersion }, read from the database: nothing in the token payload
 * decides a role.
 *
 * (History: this once treated a missing or invalid token as an anonymous
 * "admin" session. Routes that are genuinely public simply don't mount it.)
 */
module.exports = async function auth(req, res, next) {
  const found = accessTokenFrom(req);
  if (!found) {
    return res.status(401).json({ msg: "Authentication required" });
  }

  // A state-changing request authenticated by a cookie must come from an
  // allowed origin (middleware/origin.js). Header tokens cannot be attached
  // cross-site without a CORS preflight, so they need no such check.
  if (found.source === "cookie" && !SAFE_METHODS.has(req.method) && !originAllowed(req)) {
    return res.status(403).json({ msg: "Request origin not allowed", reason: "ORIGIN_NOT_ALLOWED" });
  }

  let identity;
  try {
    identity = await resolveAccessToken(found.token);
  } catch (err) {
    // The database, not the token, failed: say so rather than log them out.
    console.error("[auth] could not verify the session:", err.message);
    return res.status(503).json({ msg: "Could not verify your session. Please try again." });
  }
  if (!identity) {
    return res.status(401).json({ msg: "Invalid or expired token", reason: "INVALID_TOKEN" });
  }

  req.user = identity;
  req.authSource = found.source;
  return next();
};
