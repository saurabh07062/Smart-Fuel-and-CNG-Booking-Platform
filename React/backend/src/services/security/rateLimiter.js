/**
 * Rate limiting: a sliding-window counter shared through Redis.
 *
 * A fixed window ("100 requests per minute, resetting on the minute") lets a
 * client send double the limit by firing just before and just after a
 * boundary. The sliding window counter fixes that cheaply: it keeps the
 * current window's count and the previous window's count, and estimates the
 * rate over a true trailing window by weighting the previous window's count
 * by how much of it still overlaps "now".
 *
 *   estimate = previousCount * weightOfPreviousWindowStillInRange + currentCount
 *
 * REDIS (shared by every server instance)
 *   One Lua script per request, so the increment, its TTL and the read of the
 *   previous window happen atomically -- concurrent requests cannot both slip
 *   under the limit. Keys carry a hash tag ({...}) so both windows of one
 *   identity live on the same cluster slot. Refused requests are counted too:
 *   a client that keeps hammering stays refused.
 *
 * WHEN REDIS IS DOWN
 *   The limiter never fails a request because Redis is unavailable. It keeps
 *   limiting with per-process counters (correct for one instance, looser
 *   across several), logs one line when it switches and one when Redis is back,
 *   retries the connection in the background at most every 30 seconds without
 *   delaying requests, and reports its mode in /api/health.
 */

const crypto = require("crypto");
const { connectRedis, destroyQuietly } = require("../core/redisConnect");
const metrics = require("../core/metrics");

const DEFAULT_WINDOW_MS = 60_000;
const RECONNECT_INTERVAL_MS = 30_000;
// A live Redis answers in about a millisecond. One that has stopped answering
// without closing the connection (a frozen host, a network partition) must not
// hold every API request waiting behind it: past this, the request is counted
// in-process and the limiter switches to the fallback until Redis is back.
const REDIS_COMMAND_TIMEOUT_MS = Math.max(50, Number(process.env.RATE_LIMIT_REDIS_TIMEOUT_MS) || 250);

function withTimeout(promise, ms) {
  let timer;
  promise.catch(() => {}); // a late failure after the timeout is not an unhandled rejection
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error(`Redis did not answer within ${ms} ms`), { code: "RATE_LIMIT_REDIS_TIMEOUT" })),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * KEYS[1] current window counter, KEYS[2] previous window counter
 * ARGV[1] TTL for the current counter in ms (two windows: it is still read as
 *         "previous" throughout the next window)
 */
const SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local previous = tonumber(redis.call('GET', KEYS[2]) or '0') or 0
return { current, previous }
`;
const SCRIPT_SHA = crypto.createHash("sha1").update(SCRIPT).digest("hex");

let client = null;
let mode = "uninitialised"; // 'redis' | 'memory'
let connectPromise = null;
let lastConnectAttempt = 0;
let reconnecting = null;

// ---- in-process fallback -------------------------------------------------
// key -> { windowMs, windows: Map(windowId -> count), lastSeen }
const memory = new Map();
let sweeper = null;

function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memory) {
      if (now - entry.lastSeen > entry.windowMs * 2) memory.delete(key);
    }
  }, 60_000);
  if (typeof sweeper.unref === "function") sweeper.unref();
}

function memoryIncr(key, windowId, windowMs) {
  let entry = memory.get(key);
  if (!entry || entry.windowMs !== windowMs) {
    entry = { windowMs, windows: new Map(), lastSeen: 0 };
    memory.set(key, entry);
  }
  entry.windows.set(windowId, (entry.windows.get(windowId) || 0) + 1);
  for (const id of entry.windows.keys()) if (id < windowId - 1) entry.windows.delete(id);
  entry.lastSeen = Date.now();
  return { current: entry.windows.get(windowId), previous: entry.windows.get(windowId - 1) || 0, store: "memory" };
}

// ---- connection ------------------------------------------------------------

/** Connect once, lazily. Never throws, never hangs (services/core/redisConnect.js). */
async function init() {
  if (mode !== "uninitialised") return mode;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    startSweeper();
    lastConnectAttempt = Date.now();
    const c = process.env.REDIS_URL ? await connectRedis("rateLimiter") : null;
    if (c) {
      client = c;
      watchClient(c);
      mode = "redis";
    } else {
      mode = "memory";
    }
    return mode;
  })();

  return connectPromise;
}

/** node-redis gives up after its reconnect attempts and emits 'end': stop using that client. */
function watchClient(c) {
  c.on("end", () => {
    if (client === c) toMemory("connection closed");
  });
}

function toMemory(reason) {
  if (mode !== "redis") return;
  const old = client;
  client = null;
  mode = "memory";
  lastConnectAttempt = Date.now();
  destroyQuietly(old);
  metrics.inc("rate_limit_redis_fallback_count");
  console.error(
    `[rateLimiter] Redis unavailable (${reason}) - limiting per server instance until it is back; retrying every ${RECONNECT_INTERVAL_MS / 1000}s`,
  );
}

/** In the background, at most every RECONNECT_INTERVAL_MS: requests are never delayed by it. */
function maybeReconnect() {
  if (mode !== "memory" || !process.env.REDIS_URL || reconnecting) return;
  if (Date.now() - lastConnectAttempt < RECONNECT_INTERVAL_MS) return;
  lastConnectAttempt = Date.now();
  reconnecting = connectRedis("rateLimiter")
    .then((c) => {
      if (!c) return;
      if (mode !== "memory") {
        destroyQuietly(c); // closed or already reconnected meanwhile
        return;
      }
      client = c;
      watchClient(c);
      mode = "redis";
      metrics.inc("rate_limit_redis_recovered_count");
      console.log("[rateLimiter] Redis reachable again - shared rate limits restored");
    })
    .catch(() => {})
    .finally(() => {
      reconnecting = null;
    });
}

const redisKey = (key, windowId) => `ratelimit:{${String(key).replace(/[{}]/g, "_")}}:${windowId}`;

async function redisIncr(key, windowId, windowMs) {
  const options = {
    keys: [redisKey(key, windowId), redisKey(key, windowId - 1)],
    arguments: [String(windowMs * 2)],
  };
  let reply;
  try {
    reply = await withTimeout(client.evalSha(SCRIPT_SHA, options), REDIS_COMMAND_TIMEOUT_MS);
  } catch (err) {
    // Redis restarted or its script cache was flushed: send the script itself,
    // which also caches it again for the next EVALSHA.
    if (!/NOSCRIPT/i.test(err?.message || "")) throw err;
    reply = await withTimeout(client.eval(SCRIPT, options), REDIS_COMMAND_TIMEOUT_MS);
  }
  return { current: Number(reply[0]) || 1, previous: Number(reply[1]) || 0, store: "redis" };
}

// ---- the limit ---------------------------------------------------------------

/**
 * Pure: how long until ONE more request would be allowed, given the counts
 * after this one. Exact for the sliding-window estimate, so a client that
 * waits exactly Retry-After (and sends nothing meanwhile) gets through.
 */
function retryAfterFor({ limit, windowMs, elapsedMs, current, previous }) {
  const room = limit - current - 1; // what this window leaves for the previous window's weighted share
  if (room >= 0) {
    if (previous <= 0) return 0;
    // previous * (windowMs - elapsed - d) / windowMs <= room
    return Math.max(0, Math.ceil(windowMs - elapsedMs - (room * windowMs) / previous));
  }
  // This window alone is over the limit: wait until it has become the previous
  // window and enough of it has slid out of range.
  const fractionOfNextWindow = current > 0 ? Math.max(0, 1 - (limit - 1) / current) : 0;
  return Math.ceil(windowMs - elapsedMs + fractionOfNextWindow * windowMs);
}

/**
 * Check and record one request against `key`.
 *
 * @param {string} key       identity for what is being limited, e.g. `login-ip:1.2.3.4`
 * @param {number} limit     max requests per trailing window
 * @param {number} windowMs  window size in ms (default 60s)
 * @returns {Promise<{allowed:boolean, estimate:number, limit:number, remaining:number,
 *   retryAfterMs:number, resetMs:number, store:'redis'|'memory'}>}
 */
async function check(key, limit, windowMs = DEFAULT_WINDOW_MS) {
  await init();
  maybeReconnect();

  const now = Date.now();
  const windowId = Math.floor(now / windowMs);
  const elapsedMs = now - windowId * windowMs;

  let counts = null;
  if (mode === "redis" && client) {
    try {
      counts = await redisIncr(key, windowId, windowMs);
    } catch (err) {
      // A timeout means Redis has stopped answering: treat it as an outage, or
      // every following request would pay the timeout too.
      if (err?.code === "RATE_LIMIT_REDIS_TIMEOUT" || !client || !client.isReady) toMemory(err.message);
      else metrics.inc("rate_limit_redis_error_count"); // one failed command on a live connection
    }
  }
  if (!counts) counts = memoryIncr(key, windowId, windowMs);

  const { current, previous } = counts;
  const estimate = previous * ((windowMs - elapsedMs) / windowMs) + current;
  const allowed = estimate <= limit;

  return {
    allowed,
    estimate: Math.round(estimate * 100) / 100,
    limit,
    remaining: Math.max(0, Math.floor(limit - estimate)),
    retryAfterMs: allowed ? 0 : retryAfterFor({ limit, windowMs, elapsedMs, current, previous }),
    resetMs: windowMs - elapsedMs,
    store: counts.store,
  };
}

/**
 * The client's address as Express resolved it (TRUST_PROXY decides whether
 * X-Forwarded-For is believed -- config/proxy.js), with the IPv4-mapped IPv6
 * prefix removed so "::ffff:1.2.3.4" and "1.2.3.4" share one bucket.
 */
function clientIp(req) {
  const raw = req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || "unknown";
  return String(raw).replace(/^::ffff:/i, "");
}

/** For log lines: an email identity is hashed, never printed. */
function describeIdentity(identity) {
  const s = String(identity);
  return s.includes("@") ? `email#${crypto.createHash("sha256").update(s).digest("hex").slice(0, 10)}` : s;
}

// One log line per identity per window, so a flood cannot flood the logs too.
const logged = new Map();

function logRefusal(req, keyPrefix, identity, windowMs, result) {
  metrics.inc("rate_limited_count");
  metrics.inc(`rate_limited:${keyPrefix}`);
  const bucket = `${keyPrefix}:${identity}`;
  const windowId = Math.floor(Date.now() / windowMs);
  if (logged.get(bucket) === windowId) return;
  if (logged.size > 5000) logged.clear();
  logged.set(bucket, windowId);
  const path = String(req?.originalUrl || req?.url || "").split("?")[0];
  console.warn(
    `[rateLimiter] 429 ${keyPrefix} ${describeIdentity(identity)} ${req?.method || ""} ${path} ` +
      `(${result.estimate}/${result.limit} per ${Math.round(windowMs / 1000)}s, ${result.store})`,
  );
}

/** Headers for the most restrictive limiter a request passed through. */
function setHeaders(res, result) {
  res.locals = res.locals || {};
  const previous = res.locals.rateLimit;
  if (previous && previous.remaining < result.remaining) return;
  res.locals.rateLimit = { remaining: result.remaining };
  const resetSeconds = String(Math.max(0, Math.ceil((result.allowed ? result.resetMs : result.retryAfterMs) / 1000)));
  res.set("X-RateLimit-Limit", String(result.limit));
  res.set("X-RateLimit-Remaining", String(result.remaining));
  res.set("RateLimit-Limit", String(result.limit));
  res.set("RateLimit-Remaining", String(result.remaining));
  res.set("RateLimit-Reset", resetSeconds);
}

/**
 * Express middleware factory.
 *
 * @param {object} opts
 * @param {number} opts.limit
 * @param {number} [opts.windowMs]
 * @param {string} [opts.keyPrefix]  names the limit in keys, metrics and logs
 * @param {(req) => string} [opts.keyFn]  what is being limited; defaults to the
 *   signed-in user, else the client IP. An empty identity falls back to the IP
 *   rather than sharing one "undefined" bucket.
 * @param {(req) => boolean} [opts.skip]  true: this limiter does not apply
 * @param {(req, result) => any} [opts.onLimited]  called, not awaited, on each
 *   refusal (e.g. to write a security event); its failure never affects the response
 * @param {string} [opts.message]  the 429 message
 */
function rateLimit({ limit, windowMs = DEFAULT_WINDOW_MS, keyPrefix = "api", keyFn, skip, onLimited, message } = {}) {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("rateLimit requires a positive `limit`");
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("rateLimit requires a positive `windowMs`");
  }

  return async function rateLimitMiddleware(req, res, next) {
    let identity;
    let result;
    try {
      if (typeof skip === "function" && skip(req)) return next();
      identity = keyFn ? keyFn(req) : req?.user?.id;
      if (identity === undefined || identity === null || String(identity).trim() === "") identity = clientIp(req);
      result = await check(`${keyPrefix}:${identity}`, limit, windowMs);
    } catch (err) {
      // A limiter bug must not take the API down: let the request through, visibly.
      metrics.inc("rate_limit_error_count");
      console.error("[rateLimiter] middleware error, allowing request:", err.message);
      return next();
    }

    setHeaders(res, result);
    if (result.allowed) return next();

    const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    res.set("Retry-After", String(retryAfterSeconds));
    logRefusal(req, keyPrefix, identity, windowMs, result);
    if (typeof onLimited === "function") {
      Promise.resolve()
        .then(() => onLimited(req, result))
        .catch((e) => console.error("[rateLimiter] onLimited failed:", e.message));
    }
    return res.status(429).json({
      success: false,
      reason: "RATE_LIMITED",
      msg: message || "Too many requests. Please slow down and try again shortly.",
      retryAfterSeconds,
      retryAfterMs: Math.round(result.retryAfterMs),
    });
  };
}

function getMode() {
  return mode;
}

async function close() {
  // Clear the state first: destroying the client emits 'end', and a deliberate
  // shutdown must not be logged or counted as a Redis outage.
  const closing = client;
  client = null;
  mode = "uninitialised";
  if (closing) {
    // Not quit(): that waits on a reply an unreachable Redis never sends.
    await destroyQuietly(closing);
  }
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  memory.clear();
  logged.clear();
  mode = "uninitialised";
  connectPromise = null;
  lastConnectAttempt = 0;
}

module.exports = {
  init,
  check,
  rateLimit,
  clientIp,
  retryAfterFor,
  getMode,
  close,
  DEFAULT_WINDOW_MS,
  RECONNECT_INTERVAL_MS,
  _memory: memory,
};
