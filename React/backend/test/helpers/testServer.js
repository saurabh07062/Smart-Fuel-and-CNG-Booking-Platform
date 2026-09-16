/**
 * The API on the TEST database, with email off, for the HTTP tests.
 *
 *   npm run test:server        (leave it running)
 *   npm test                   (in another terminal)
 *
 * It is the real server.js -- same routes, middleware, sockets and background
 * jobs -- with MONGO_URI replaced by the test database (test/helpers/testDb.js)
 * and the port taken from TEST_API_URL (default 5055). The application
 * database is never opened.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") }); // JWT_SECRET and the rest

const { uri, DEFAULT_API } = require("./testDb");

uri(); // sets MONGO_URI to the test database and blanks the SMTP credentials
process.env.PORT = new URL(process.env.TEST_API_URL || DEFAULT_API).port || "5055";

// Every test file runs in parallel from one IP, so the per-IP ceilings meant
// to stop a script hammering production would throttle the suite itself.
// Raised here only; the routes that test those limits use their own
// per-account keys, which are unchanged.
process.env.API_RATE_LIMIT_PER_MINUTE = process.env.API_RATE_LIMIT_PER_MINUTE || "10000";
process.env.VENDOR_ACCESS_ATTEMPTS_PER_IP = process.env.VENDOR_ACCESS_ATTEMPTS_PER_IP || "1000";

console.log(
  `[test-server] database ${process.env.MONGO_URI} · port ${process.env.PORT} · email off · ` +
    `redis ${process.env.REDIS_URL || "none (in-process)"} · ` +
    `api limit ${process.env.API_RATE_LIMIT_PER_MINUTE}/min · vendor-access ${process.env.VENDOR_ACCESS_ATTEMPTS_PER_IP}/IP`,
);

// server.js moves to the next port when its port is taken. For the test
// server that would be silent and wrong: the tests would keep talking to
// whatever already holds the port (an older test server, with old settings
// and used-up rate-limit counters). So refuse to start instead.
const net = require("net");
const probe = net.createServer();
probe.once("error", (err) => {
  console.error(
    `[test-server] port ${process.env.PORT} is already in use (${err.code}). ` +
      "Stop the process holding it (an older test server?) and start again.",
  );
  process.exit(1);
});
probe.once("listening", () => {
  probe.close(() => {
    // server.js loads .env again, but dotenv never overrides a variable that
    // is already set, so the values above stand.
    require("../../src/server.js");
  });
});
probe.listen(Number(process.env.PORT));
