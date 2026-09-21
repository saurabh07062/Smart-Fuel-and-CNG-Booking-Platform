/**
 * Where tests read and write -- never the application database.
 *
 * Every test file takes its MongoDB URI from uri() and its API base URL from
 * apiUrl(). Neither looks at MONGO_URI from .env: that is the real database,
 * and tests create and remove their own records, which must never happen
 * there.
 *
 *   TEST_MONGO_URI  default mongodb://127.0.0.1:27017/fuelmart_test
 *                   (refused unless the database name contains "test")
 *   TEST_API_URL    default http://127.0.0.1:5055 -- the API started on the
 *                   test database by `npm run test:server`. HTTP tests skip
 *                   themselves when it is not running; they never fall back to
 *                   the application server on port 5000.
 *   TEST_REDIS_URL  default none (in-process limits and locks). Tests never
 *                   use REDIS_URL from .env: rate-limit counters and locks
 *                   written by a test must not land in the application's Redis.
 *
 * This file lives outside test/ so `node --test test/` does not run it.
 */

// No live road routing in tests (services/station/roadDistance.js): distances
// stay the deterministic straight line, and no test needs the internet.
process.env.ROUTING_URL = process.env.TEST_ROUTING_URL || "off";
// The demo's fixed station distances (data/fixedDistances.json) never apply in tests.
process.env.FIXED_DISTANCES = "off";
// Fixtures book far-off dates (2099) so they never meet real bookings; the
// advance-booking limit itself is tested with its real value (advanceBooking.test.js).
process.env.ADVANCE_BOOKING_DAYS = process.env.TEST_ADVANCE_BOOKING_DAYS || "40000";

const DEFAULT_URI = "mongodb://127.0.0.1:27017/fuelmart_test";
const DEFAULT_API = "http://127.0.0.1:5055";

function dbNameOf(uri) {
  try {
    return new URL(uri).pathname.replace(/^\//, "").split("?")[0];
  } catch {
    return "";
  }
}

/** The test database URI. Also points MONGO_URI at it and switches email off for this process. */
function uri() {
  const value = process.env.TEST_MONGO_URI || DEFAULT_URI;
  const name = dbNameOf(value);
  if (!/test/i.test(name)) {
    throw new Error(
      `Refusing to run tests against database "${name || value}": the test database name must contain "test". Set TEST_MONGO_URI.`,
    );
  }
  // Anything in this process that reads MONGO_URI later uses the test database too.
  process.env.MONGO_URI = value;
  // No real email from a test run.
  for (const key of ["SMTP_USER", "SMTP_PASS", "EMAIL_USER", "EMAIL_PASS"]) process.env[key] = "";
  isolateRedis();
  return value;
}

/** Point REDIS_URL at the test Redis (TEST_REDIS_URL) or at nothing -- never the application's. */
function isolateRedis() {
  process.env.REDIS_URL = process.env.TEST_REDIS_URL || "";
  return process.env.REDIS_URL;
}

/** Base URL of the API running on the test database. */
function apiUrl() {
  return process.env.TEST_API_URL || DEFAULT_API;
}

module.exports = { uri, apiUrl, isolateRedis, dbNameOf, DEFAULT_URI, DEFAULT_API };
