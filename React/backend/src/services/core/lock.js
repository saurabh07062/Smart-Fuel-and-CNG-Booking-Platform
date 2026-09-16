/**
 * Distributed locking for booking writes.
 *
 * The race we are preventing: two customers tap the same slot at the same
 * station within milliseconds of each other. Both read "free", both write,
 * and the nozzle is double-booked. Check-then-write in application code is
 * not atomic, so the check and the write run while holding a lock.
 *
 *   acquire  SET key token NX PX ttl   (atomic "take it if nobody holds it")
 *   retry    poll with jitter until maxWaitMs
 *   release  Lua compare-and-delete on the token, so a caller whose lock
 *            already expired cannot delete a lock someone else now holds
 *
 * Failure policy -- the part that matters in production:
 *
 *   When distributed locking is REQUIRED (NODE_ENV=production, or
 *   LOCK_REQUIRE_DISTRIBUTED=true) and Redis is unreachable, acquiring throws
 *   LOCK_UNAVAILABLE and the booking is refused with a 503. Silently swapping
 *   to a per-process Map there would let two server instances hand out the
 *   same slot while every log line claimed the system was safe.
 *
 *   Otherwise (local development) an in-process Map is used, with a warning
 *   that it is only correct for a single server process. getMode() reports
 *   which one is active; /api/health surfaces it.
 *
 * Bookings also have a database-level guard (models/Booking.js), so even a
 * lock failure cannot persist two active bookings with the same start.
 */

const crypto = require("crypto");
const { connectRedis, destroyQuietly } = require("./redisConnect");
const metrics = require("./metrics");

const DEFAULT_TTL_MS = 10_000;
const DEFAULT_RETRY_MS = 60;
const DEFAULT_MAX_WAIT_MS = 1_500;
const RECONNECT_INTERVAL_MS = 30_000;
/** assertHeld() refuses to proceed with less than this left on the lock. */
const LOCK_SAFETY_MARGIN_MS = 500;

let client = null;
let mode = "uninitialised"; // 'redis' | 'memory' | 'unavailable'
let connectPromise = null;
let lastConnectAttempt = 0;

/** Is falling back to in-process locks forbidden in this environment? */
function requiresDistributed() {
  const flag = process.env.LOCK_REQUIRE_DISTRIBUTED;
  if (flag === "true") return true;
  if (flag === "false") return false;
  return process.env.NODE_ENV === "production";
}

// ---- in-memory fallback (development only) ------------------------------
// key -> { token, expiresAt }
const memory = new Map();

function memoryAcquire(key, token, ttlMs) {
  const now = Date.now();
  const held = memory.get(key);
  if (held && held.expiresAt > now) return false;
  memory.set(key, { token, expiresAt: now + ttlMs });
  return true;
}

function memoryRelease(key, token) {
  const held = memory.get(key);
  if (held && held.token === token) {
    memory.delete(key);
    return true;
  }
  return false;
}

// Keep the Map from growing without bound when locks are never released.
// unref() so this timer never holds the process open.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memory) if (v.expiresAt <= now) memory.delete(k);
}, 30_000);
if (typeof sweeper.unref === "function") sweeper.unref();

// ---- connection ---------------------------------------------------------

/**
 * Connect lazily. Safe to call repeatedly -- concurrent callers share one
 * in-flight connect. Never throws. While 'unavailable', a new connection is
 * attempted at most once every RECONNECT_INTERVAL_MS, so bookings recover on
 * their own when Redis comes back.
 */
async function init() {
  if (mode === "unavailable" && Date.now() - lastConnectAttempt >= RECONNECT_INTERVAL_MS) {
    mode = "uninitialised";
    connectPromise = null;
  }
  if (mode !== "uninitialised") return mode;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    lastConnectAttempt = Date.now();
    const strict = requiresDistributed();

    // connectRedis gives up and returns null rather than retrying forever --
    // see services/core/redisConnect.js for why that matters.
    client = process.env.REDIS_URL ? await connectRedis("lock") : null;

    if (client) {
      mode = "redis";
      console.log("[lock] Redis connected - distributed locking active");
    } else if (strict) {
      mode = "unavailable";
      console.error(
        "[lock] Distributed locking is required in this environment but Redis is unavailable. " +
          "Booking writes will be refused (503) until Redis is reachable.",
      );
    } else {
      mode = "memory";
      console.warn(
        "[lock] DEVELOPMENT FALLBACK: in-process locks. Correct for ONE server process only. " +
          "Set NODE_ENV=production or LOCK_REQUIRE_DISTRIBUTED=true to refuse this fallback.",
      );
    }
    return mode;
  })();

  return connectPromise;
}

function unavailableError() {
  const err = new Error("Booking lock service is unavailable");
  err.code = "LOCK_UNAVAILABLE";
  err.status = 503;
  return err;
}

// Compare-and-delete: only remove the key if we still own it.
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/**
 * Try once to take the lock. Returns a token on success, null if held.
 * Throws LOCK_UNAVAILABLE when distributed locking is required but down.
 */
async function tryAcquire(key, ttlMs = DEFAULT_TTL_MS) {
  await init();
  const token = crypto.randomBytes(16).toString("hex");

  if (mode === "unavailable") {
    metrics.inc("lock_unavailable_count");
    throw unavailableError();
  }

  if (mode === "redis" && client) {
    try {
      const ok = await client.set(key, token, { NX: true, PX: ttlMs });
      return ok === "OK" ? token : null;
    } catch (err) {
      console.error("[lock] Redis acquire failed:", err.message);
      if (requiresDistributed()) {
        metrics.inc("lock_unavailable_count");
        throw unavailableError();
      }
      console.warn("[lock] DEVELOPMENT FALLBACK: using an in-process lock for this request.");
      return memoryAcquire(key, token, ttlMs) ? token : null;
    }
  }

  return memoryAcquire(key, token, ttlMs) ? token : null;
}

/**
 * Block until the lock is free or `maxWaitMs` elapses. Returns the token, or
 * null on timeout. Booking contention is short-lived (one DB write), so a
 * brief wait beats telling the second customer "busy" 40ms too early.
 */
async function acquire(key, opts = {}) {
  const held = await acquireTimed(key, opts);
  return held ? held.token : null;
}

/**
 * acquire(), also returning `at`: a moment no later than when the lock's TTL
 * started (taken just before the successful SET), so `at + ttl` never
 * overstates how long the lock is still held.
 */
async function acquireTimed(key, opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;

  // Connect first, so the wait and the TTL start are measured from when a
  // lock can actually be taken -- not from before a slow first connection.
  await init();

  const started = Date.now();
  const deadline = started + maxWaitMs;
  for (;;) {
    const at = Date.now();
    const token = await tryAcquire(key, ttlMs);
    if (token) {
      metrics.observe("lock_wait_ms", Date.now() - started);
      return { token, at };
    }
    if (Date.now() + retryMs >= deadline) {
      metrics.inc("lock_timeout_count");
      return null;
    }
    // jitter avoids a thundering herd of retries landing in lockstep
    await sleep(retryMs + Math.random() * retryMs);
  }
}

async function release(key, token) {
  if (!token) return false;

  if (mode === "redis" && client) {
    try {
      const res = await client.eval(RELEASE_LUA, { keys: [key], arguments: [token] });
      return res === 1;
    } catch (err) {
      // The key still expires on its TTL; nothing safer to do here.
      console.error("[lock] Redis release failed:", err.message);
      return requiresDistributed() ? false : memoryRelease(key, token);
    }
  }

  return memoryRelease(key, token);
}

/**
 * Run `fn(guard)` while holding the lock, releasing it even if `fn` throws.
 *
 * A lock with a TTL can expire while `fn` is still running (a slow database,
 * a GC pause), after which another process may take it. `guard.assertHeld()`
 * throws LOCK_EXPIRED if less than a safety margin of the TTL is left, so the
 * caller can check immediately before the write the lock protects instead of
 * writing unprotected. `guard.remainingMs()` reports the time left.
 *
 * Throws LOCK_TIMEOUT if the lock could not be taken in time, and
 * LOCK_UNAVAILABLE if distributed locking is required but down.
 */
async function withLock(key, fn, opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const held = await acquireTimed(key, opts);
  if (!held) {
    const err = new Error(`Could not acquire lock: ${key}`);
    err.code = "LOCK_TIMEOUT";
    err.status = 409;
    throw err;
  }

  const guard = {
    key,
    remainingMs: () => held.at + ttlMs - Date.now(),
    assertHeld(marginMs = LOCK_SAFETY_MARGIN_MS) {
      if (this.remainingMs() <= marginMs) {
        metrics.inc("lock_expired_count");
        const err = new Error(`Lock ${key} expired before the protected write`);
        err.code = "LOCK_EXPIRED";
        err.status = 409;
        throw err;
      }
    },
  };

  try {
    return await fn(guard);
  } finally {
    const released = await release(key, held.token);
    // false: the TTL ran out and the key was gone or taken by someone else.
    if (!released) metrics.inc("lock_lost_count");
  }
}

/**
 * Run a periodic job at most once per `ttlMs` across every server instance.
 *
 * The lock is deliberately not released after the run: holding it for the
 * rest of the interval is what stops a second instance's timer, firing a few
 * seconds later, from running the same job again in the same interval.
 *
 * If distributed locking is required but unavailable, the job still runs
 * (every job's writes are conditional and idempotent), counted so it is visible.
 *
 * @returns {Promise<{ran:boolean, exclusive?:boolean, result?:any}>}
 */
async function runExclusive(name, ttlMs, fn) {
  let token;
  try {
    token = await tryAcquire(`lock:job:${name}`, ttlMs);
  } catch (err) {
    if (err.code !== "LOCK_UNAVAILABLE") throw err;
    metrics.inc("job_lock_unavailable_count");
    return { ran: true, exclusive: false, result: await fn() };
  }
  if (!token) {
    metrics.inc("job_skipped_count");
    return { ran: false };
  }
  return { ran: true, exclusive: true, result: await fn() };
}

/** Canonical key so every call site locks the same string. */
function slotKey(stationId, dateISO, slot) {
  return `lock:slot:${stationId}:${dateISO}:${slot}`;
}

function isDistributed() {
  return mode === "redis";
}

function getMode() {
  return mode;
}

async function close() {
  if (client) {
    // quit() waits for a server reply, which a dead or unreachable Redis
    // never sends -- destroyQuietly closes the socket either way, so a test
    // or script that calls close() always terminates.
    await destroyQuietly(client);
    client = null;
  }
  clearInterval(sweeper);
  memory.clear();
  mode = "uninitialised";
  connectPromise = null;
  lastConnectAttempt = 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  init,
  acquire,
  tryAcquire,
  release,
  withLock,
  runExclusive,
  LOCK_SAFETY_MARGIN_MS,
  slotKey,
  isDistributed,
  getMode,
  requiresDistributed,
  close,
  // exported for tests
  _memory: memory,
};
