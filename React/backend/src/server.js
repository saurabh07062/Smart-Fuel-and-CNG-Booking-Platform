/**
 * Process entry point: connect MongoDB, open the HTTP server with Socket.IO on
 * the Express app (src/app.js), then recover in-progress fills and start the
 * background jobs.
 *
 *   npm start      (from backend/)
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

// Refuse to start without a usable JWT secret and session settings
// (config/auth.js), rather than crash on the first login.
try {
  require("./config/auth").assertAuthConfig();
} catch (err) {
  console.error(`[auth] ${err.message}`);
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

// Connect DB
mongoose
  .connect(process.env.MONGO_URI || "mongodb://localhost:27017/fuelmart")
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.log("MongoDB Connection Error:", err));

// The booking double-booking guard is a database index; make sure it exists
// and say so loudly if existing data prevents building it.
require("./models/Booking")
  .init()
  .then(() => console.log("[indexes] Booking indexes ready (incl. uniq_active_nozzle_start_per_fuel)"))
  .catch((err) => console.error("[indexes] Booking index build FAILED:", err.message));

const DEFAULT_PORT = process.env.PORT || 5000;
const MAX_RETRIES = 5;

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
    if (err && err.code === "EADDRINUSE" && retriesLeft > 0) {
      console.warn(`Port ${port} is in use, trying port ${Number(port) + 1}...`);
      // try next port
      startServer(Number(port) + 1, retriesLeft - 1);
    } else {
      console.error("Server error:", err);
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
    console.log(`Real backend server running on port ${port}`);

    await lock.init();

    // Fills in progress when the server stopped: re-arm each completion from
    // its stored start time (an overdue one completes now), and hand a free
    // nozzle to any car left waiting at the pump (services/queue/serviceTimer.js).
    try {
      const r = await require("./services/queue/serviceTimer").recoverServiceTimers();
      if (r.serving || r.started) {
        console.log(`[serviceTimer] recovered ${r.scheduled} fill(s) in progress (${r.overdue} overdue), started ${r.started} waiting car(s)`);
      }
    } catch (err) {
      console.error("[serviceTimer] recovery failed:", err.message);
    }

    // In-memory waitlists do not survive a restart; rebuild them from the
    // Booking rows that are the actual source of truth.
    try {
      const restored = await bookingService.restoreWaitlists();
      if (restored) console.log(`Restored ${restored} waitlisted booking(s)`);
    } catch (err) {
      console.error("Failed to restore waitlists:", err.message);
    }

    // Background jobs: recalibrate the Erlang-C inputs from real bookings,
    // and close out slots time has already passed. Both are idempotent and
    // safe to run on an interval for the life of the process.
    startStationMetricsJob({ intervalMs: 15 * 60_000 });
    startBookingSweepJob({ intervalMs: 10 * 60_000, getIo: () => io });
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
    const runSecretCodeSweep = async () => {
      try {
        const cleared = await vendorSecretCode.sweepExpired(User);
        if (cleared) console.log(`[secretCode] cleared ${cleared} expired code(s)`);
      } catch (err) {
        console.error("[secretCode] sweep failed:", err.message);
      }
    };
    runSecretCodeSweep();
    const secretCodeTimer = setInterval(runSecretCodeSweep, 60 * 60_000);
    if (typeof secretCodeTimer.unref === "function") secretCodeTimer.unref();
  });
}

startServer(DEFAULT_PORT, MAX_RETRIES);
