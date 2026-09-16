const auth = require("./auth");
const requireRole = require("./requireRole");

/**
 * Full admin gate: verify the JWT, then require the admin role.
 *
 * This used to be a no-op that fabricated an admin identity and always
 * called next() -- every route mounting it was reachable by anyone, no
 * token required. It's exported as an array so route files that already do
 * `router.get(path, adminAuth, handler)` keep working unchanged; Express
 * flattens a middleware array passed as a single argument.
 */
module.exports = [auth, requireRole("admin")];
