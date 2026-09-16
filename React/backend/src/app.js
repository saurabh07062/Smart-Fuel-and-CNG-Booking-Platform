/**
 * The Express application: middleware, static uploads, rate limit, routes,
 * health/metrics and error handling. No port is opened here -- src/server.js
 * connects the database, attaches Socket.IO, listens and starts the jobs.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");

// Import Routes
const authRoutes = require("./routes/authRoutes");
const stationRoutes = require("./routes/stationRoutes");
const bookingRoutes = require("./routes/bookingRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const vendorRoutes = require("./routes/vendorRoutes");
const vendorPanelRoutes = require("./routes/vendorPanelRoutes");
// These two existed but were never mounted, so every endpoint in them 404'd.
const customerRoutes = require("./routes/customerRoutes");
const activationRoutes = require("./routes/activationRoutes");
const vendorAccessRoutes = require("./routes/vendorAccessRoutes");
// v1: discovery + slot booking, backed by the geo/queue/lock services.
const discoveryRoutes = require("./routes/discoveryRoutes");
const slotRoutes = require("./routes/slotRoutes");
const adminRoutes = require("./routes/adminRoutes");
const queueRoutes = require("./routes/queueRoutes");

const lock = require("./services/core/lock");
const { rateLimit } = require("./services/security/rateLimiter");
const uploadMiddleware = require("./middleware/upload");

const app = express();

// Who req.ip is -- the identity every IP rate limit counts. Off unless
// TRUST_PROXY says how many proxies (or which) sit in front (config/proxy.js).
app.set("trust proxy", require("./config/proxy").trustProxySetting());

// Security headers on every response, before anything else runs: nosniff,
// frame protection, HSTS (ignored by browsers until the site is served over
// HTTPS), a default CSP and no X-Powered-By. /uploads sets its own
// Cross-Origin-Resource-Policy: cross-origin below -- it runs later, so it
// wins -- which keeps uploaded images loadable by the frontend's origin.
app.use(helmet());

// Browser origins allowed to read API responses (config/cors.js); was `cors()`,
// i.e. every website.
const { isOriginAllowed } = require("./config/cors");
// credentials: an allowed origin may send the session cookies (config/auth.js).
app.use(cors((req, cb) => cb(null, { origin: isOriginAllowed(req.headers.origin, req.headers.host), credentials: true })));
// Payment-provider webhooks verify a signature over the RAW body, so they are
// mounted before express.json() consumes it (routes/webhookRoutes.js).
app.use("/api/webhooks", require("./routes/webhookRoutes"));
app.use(express.json());
// Parse URL-encoded bodies sent by HTML forms
app.use(express.urlencoded({ extended: true }));
// req.cookies, for the httpOnly session cookies.
app.use(cookieParser());

// Ensure req.body is at least an object so destructuring in controllers
// won't throw when body parsers don't populate it for some requests.
app.use((req, res, next) => {
  if (req.body === undefined || req.body === null) req.body = {};
  next();
});

// ---- uploaded files ----------------------------------------------------
// Serve the uploads tree read-only. Nothing here existed before: files were
// being written by multer and were then unreachable, so every upload the app
// had ever accepted was write-only.
//
// The options matter as much as the route:
//   dotfiles: "deny"  a stray .env or .htaccess in the tree is not served
//   index: false      a directory URL does not list its contents
//   nosniff           the browser must not re-interpret a stored file as
//                     script because its bytes happen to look like one
//   Content-Disposition on PDFs: they open in a viewer, never as an inline
//                     document that could run in this origin
app.use(
  "/uploads",
  (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // Uploaded files are immutable -- the filename changes when the file
    // does -- so they can be cached hard.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (req.path.toLowerCase().endsWith(".pdf")) {
      res.setHeader("Content-Disposition", "inline");
    }
    next();
  },
  express.static(uploadMiddleware.UPLOAD_ROOT, {
    dotfiles: "deny",
    index: false,
    fallthrough: true,
    // Only the types this app actually stores. Anything else that somehow
    // reaches the directory is downloaded, not rendered.
    setHeaders: (res, filePath) => {
      if (!/\.(jpg|jpeg|png|webp|pdf)$/i.test(filePath)) {
        res.setHeader("Content-Type", "application/octet-stream");
      }
    },
  }),
);

// A miss under /uploads is a missing image, not an API route. Answer JSON so
// the frontend's onerror fallback has something predictable, and never let it
// fall through to the SPA or the API 404 handler.
app.use("/uploads", (req, res) => {
  res.status(404).json({ msg: "File not found" });
});

// Blanket API-wide floor: generous enough that no real user ever notices it,
// tight enough that a script hammering any endpoint gets a 429 instead of a
// free ride. Per-route limiters below (login, booking) are tighter on top of
// this, keyed on IP -- req.user isn't populated yet this early in the chain.
// API_RATE_LIMIT_PER_MINUTE overrides the 300 (the test server raises it, since
// the whole test suite shares one IP); production uses the default.
const API_RATE_LIMIT_PER_MINUTE = Math.max(1, Number(process.env.API_RATE_LIMIT_PER_MINUTE) || 300);
app.use("/api", rateLimit({ limit: API_RATE_LIMIT_PER_MINUTE, windowMs: 60_000, keyPrefix: "api-global", keyFn: (req) => req.ip }));

// Mount Routes
app.use("/api/auth", authRoutes);
app.use("/api/stations", stationRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/razorpay", paymentRoutes);
app.use("/api/vendors", vendorRoutes);
app.use("/api/vendor-panel", vendorPanelRoutes);
app.use("/api/customer", customerRoutes);
app.use("/api/activation", activationRoutes);
app.use("/api/vendor-access", vendorAccessRoutes);

// v1 API used by the customer/vendor/admin apps.
app.use("/api/v1/discovery", discoveryRoutes);
app.use("/api/v1/slots", slotRoutes);
// The frontend called /api/superadmin/dashboard, which was never mounted.
app.use("/api/superadmin", adminRoutes);
app.use("/api/v1/admin", adminRoutes);
app.use("/api/v1/queue", queueRoutes);

// Simple health check route
app.get("/", (req, res) => {
  res.send("FuelMart API is running MVC Architecture");
});

app.get("/api/health", async (req, res) => {
  await lock.init();
  const limiterMode = await require("./services/security/rateLimiter").init();
  res.json({
    ok: true,
    mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    lockMode: lock.getMode(),
    distributedLocking: lock.isDistributed(),
    distributedLockingRequired: lock.requiresDistributed(),
    // What is shared between server instances and what is not. Booking
    // correctness never depends on the per-process parts: the database
    // guards and conditional writes hold across instances regardless.
    rateLimiterMode: limiterMode, // "memory" = limits are per instance
    realtimeAdapter: "in-process", // Socket.IO events reach clients of this instance only
    metricsScope: "per-process",
    time: new Date().toISOString(),
  });
});

// Operational counters (booking conflicts, lock waits, risk blocks,
// verification failures). Admin-only; per process; no customer data.
const adminOnly = require("./middleware/admin");
const metrics = require("./services/core/metrics");
app.get("/api/v1/metrics", adminOnly, (req, res) => {
  res.json({ ...metrics.snapshot(), lockMode: lock.getMode() });
});

// 404 handler — an unmatched /api/* path should say so in JSON rather than
// returning Express's HTML error page to a fetch() caller.
app.use("/api", (req, res) => {
  res.status(404).json({ msg: `No such endpoint: ${req.method} ${req.originalUrl}` });
});

// Central error handler so a thrown error never leaks a stack trace to the client.
app.use((err, req, res, _next) => {
  console.error("[unhandled]", err);
  res.status(err.status || 500).json({ msg: err.message || "Internal server error" });
});

module.exports = app;
