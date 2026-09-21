/**
 * Process entry point: connect MongoDB, open the HTTP server with Socket.IO on
 * the Express app (src/app.js), then recover in-progress fills and start the
 * background jobs. Stops cleanly on SIGINT/SIGTERM.
 *
 *   npm start      (from backend/)
 *
 * Logging (utils/logger.js): LOG_LEVEL=error|warn|info|debug (default info),
 * LOG_FORMAT=json|pretty (default json when NODE_ENV=production).
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const logger = require("./utils/logger");
// Every existing console.* call now gets a timestamp, level and component.
logger.installConsoleBridge();
logger.enableHttpLogging();
const log = logger.child("server");

// A crash is logged with its stack before the process exits; a rejected
// promise nobody handled is logged, not silently dropped.
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception; shutting down", { err });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection", { err: reason instanceof Error ? reason : new Error(String(reason)) });
});

// Refuse to start without a usable JWT secret and session settings
// (config/auth.js), rather than crash on the first login.
try {
  require("./config/auth").assertAuthConfig();
} catch (err) {
  logger.child("auth").error("Invalid auth configuration; refusing to start", { err });
  process.exit(1);
}

const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");

const app = require("./app");
const { isOriginAllowed } = require("./config/cors");
const lock = require("./services/core/lock");
const bookingService = require("./services/booking/booking");
const realtime = require("./services/notification/realtime");
const { startStationMetricsJob } = require("./services/station/stationMetrics");
const vendorSecretCode = require("./services/vendor/vendorSecretCode");
const User = require("./models/User");
const { startBookingSweepJob, startInProgressSweepJob } = require("./services/booking/bookingSweep");
const { startQueueClockJob } = require("./services/queue/stationQueue");

log.info("Starting", {
  env: process.env.NODE_ENV || "development",
  node: process.version,
  pid: process.pid,
  logLevel: process.env.LOG_LEVEL || "info",
});

// Connect DB
const dbLog = logger.child("mongodb");
mongoose
  .connect(process.env.MONGO_URI || "mongodb://localhost:27017/fuelmart")
  // Where it connected: host, port and database only -- never the user or
  // password that MONGO_URI may carry.
  .then(() => {
    const { host, port, name } = mongoose.connection;
    dbLog.info("Connected", { host, port, database: name });
  })
  .catch((err) => dbLog.error("Connection failed", { err }));
mongoose.connection.on("disconnected", () => dbLog.warn("Disconnected"));
mongoose.connection.on("reconnected", () => dbLog.info("Reconnected"));

// The booking double-booking guard is a database index; make sure it exists
// and say so loudly if existing data prevents building it.
require("./models/Booking")
  .init()
  .then(() => dbLog.info("Booking indexes ready"))
  .catch((err) => dbLog.error("Booking index build failed", { err }));

const DEFAULT_PORT = process.env.PORT || 5000;
const MAX_RETRIES = 5;

let running = null; // { server, io } once listening

// The HTTP server (and socket.io) is created inside startServer so we can
// retry with a different port if the desired port is already in use.
function startServer(port, retriesLeft) {
  const server = http.createServer(app);
  const io = new Server(server, {
    // CORS headers for the allowed origins, and -- the part that actually
    // refuses -- allowRequest rejects a handshake from any other browser
    // origin before a socket exists (config/cors.js). Was origin "*".
    // credentials: the session cookie travels with the handshake.
    cors: { origin: (origin, cb) => cb(null, isOriginAllowed(origin)), credentials: true },
    allowRequest: (req, cb) => cb(null, isOriginAllowed(req.headers.origin, req.headers.host)),
  });
  app.set("io", io);

  server.on("error", (err) => {
    // Development only: in production a busy port means another copy is
    // already running, and quietly moving to the next port would leave the
    // proxy/clients talking to the old process.
    if (err && err.code === "EADDRINUSE" && retriesLeft > 0 && process.env.NODE_ENV !== "production") {
      log.warn(`Port ${port} is in use (another backend still running?). Starting on ${Number(port) + 1} -- the frontend proxy still points at the old port.`, { port, next: Number(port) + 1 });
      startServer(Number(port) + 1, retriesLeft - 1);
    } else {
      log.error("HTTP server error", { port, err });
      process.exit(1);
    }
  });

  // Identity, rooms and every targeted emit live in services/notification/realtime.js.
  //
  // What used to be here joined whatever room the client asked for:
  // `socket.on("identify", ({ userId, role }) => { if (role === "admin")
  // socket.join("admin") })`. Any browser could claim to be an admin and
  // start receiving administrative events. The replacement derives identity
  // from the JWT in the handshake and the role from the database.
  realtime.init(io);

  server.listen(port, async () => {
    running = { server, io };
    log.info("HTTP server listening", { port: Number(port), url: `http://localhost:${port}` });

    await lock.init();

    // Per-nozzle booking guards replace the one-booking-per-slot ones before
    // anything is scheduled (services/core/schedulingIndexes.js).
    try {
      await require("./services/core/schedulingIndexes").ensureSchedulingIndexes();
    } catch (err) {
      logger.child("mongodb").error("Could not update the booking indexes", { err });
    }

    // Fills in progress when the server stopped: re-arm each completion from
    // its stored start time (an overdue one completes now), and hand a free
    // nozzle to any car left waiting at the pump (services/queue/serviceTimer.js).
    try {
      const r = await require("./services/queue/serviceTimer").recoverServiceTimers();
      if (r.serving || r.started) {
        logger.child("serviceTimer").info("Recovered fills in progress", { scheduled: r.scheduled, overdue: r.overdue, started: r.started });
      }
    } catch (err) {
      logger.child("serviceTimer").error("Recovery failed", { err });
    }

    // In-memory waitlists do not survive a restart; rebuild them from the
    // Booking rows that are the actual source of truth.
    try {
      const restored = await bookingService.restoreWaitlists();
      if (restored) logger.child("booking").info("Restored waitlisted bookings", { count: restored });
    } catch (err) {
      logger.child("booking").error("Failed to restore waitlists", { err });
    }

    // Background jobs: recalibrate the Erlang-C inputs from real bookings,
    // and close out slots time has already passed. Both are idempotent and
    // safe to run on an interval for the life of the process.
    startStationMetricsJob({ intervalMs: 15 * 60_000 });
    // Every minute: a customer who has not arrived by the end of their slot is
    // cancelled promptly (services/booking/bookingSweep.js).
    startBookingSweepJob({ intervalMs: 60_000, getIo: () => io });
    // Fast-cadence: auto-completes a "serving" booking once its fuel-specific
    // duration has elapsed (5 min CNG, 40s Petrol/Diesel) -- see
    // services/booking/bookingSweep.js's sweepInProgressBookings for why this needs
    // its own, much shorter interval than the sweep above.
    startInProgressSweepJob({ intervalMs: 5_000, getIo: () => io });
    // Live queue as time passes: wakes when a booked slot starts or lapses, a
    // fill ends, or a wait/ETA minute ticks, and pushes only what changed
    // (services/queue/stationQueue.js startQueueClockJob).
    startQueueClockJob();

    // Clear expired vendor secret codes. Verification already refuses an
    // expired code the instant it lapses, so this is storage hygiene, not
    // enforcement -- which is why an hour is a perfectly good cadence. It
    // cannot be a Mongo TTL index: TTL deletes documents, and the document
    // here is the vendor's whole user account (see models/User.js).
    const codeLog = logger.child("secretCode");
    const runSecretCodeSweep = async () => {
      try {
        const cleared = await vendorSecretCode.sweepExpired(User);
        if (cleared) codeLog.info("Cleared expired codes", { count: cleared });
      } catch (err) {
        codeLog.error("Sweep failed", { err });
      }
    };
    runSecretCodeSweep();
    const secretCodeTimer = setInterval(runSecretCodeSweep, 60 * 60_000);
    if (typeof secretCodeTimer.unref === "function") secretCodeTimer.unref();

    log.info("Ready");
  });
}

/**
 * Graceful shutdown on Ctrl+C / SIGTERM (a deploy or container stop): stop
 * accepting connections, close sockets, Redis and MongoDB, then exit. A
 * second signal, or 10 seconds without finishing, forces the exit.
 */
let stopping = false;
async function shutdown(signal) {
  if (stopping) {
    log.warn("Second signal; forcing exit", { signal });
    process.exit(1);
  }
  stopping = true;
  log.info("Shutting down", { signal });
  const force = setTimeout(() => {
    log.error("Shutdown timed out; forcing exit");
    process.exit(1);
  }, 10_000);
  force.unref();

  try {
    if (running) {
      running.io.close();
      await new Promise((resolve) => running.server.close(() => resolve()));
    }
    await Promise.allSettled([lock.close(), require("./services/security/rateLimiter").close()]);
    await mongoose.disconnect();
    log.info("Shutdown complete");
    process.exit(0);
  } catch (err) {
    log.error("Shutdown failed", { err });
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

startServer(DEFAULT_PORT, MAX_RETRIES);
