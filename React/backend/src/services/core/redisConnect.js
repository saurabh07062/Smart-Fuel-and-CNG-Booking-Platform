/**
 * One way to open a Redis connection, shared by every service that wants one.
 *
 * The bug this exists to prevent: both services/core/lock.js and
 * services/security/rateLimiter.js used to create their client with
 *
 *     reconnectStrategy: (retries) => Math.min(retries * 100, 3000)
 *
 * which returns a delay *forever* and never gives up. node-redis treats a
 * numeric return as "retry again in N ms", so when Redis was unreachable
 * `await client.connect()` never settled -- it just retried in a loop. The
 * try/catch fallback to in-memory mode around it was therefore unreachable
 * dead code, and because the rate limiter runs on every /api route and awaits
 * init(), a Redis outage hung every single API request instead of degrading
 * to the in-process fallback that was already written and tested.
 *
 * Returning an Error from the strategy is what makes node-redis stop retrying
 * and reject the pending connect(), so the caller's fallback can actually run.
 */

// Deliberately small: this runs on the first API request after a restart, and
// a user waiting on a page load should not pay for a long Redis timeout. If
// Redis is not up within a couple of seconds, the in-memory path is correct.
const CONNECT_TIMEOUT_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 2;

/**
 * @param {string} label  used only for log lines, e.g. "lock"
 * @returns {Promise<object|null>} a connected client, or null when Redis is
 *   not configured or not reachable. Never throws, never hangs.
 */
async function connectRedis(label) {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  let client = null;
  try {
    // Required lazily so the dependency stays optional until Redis is wired up.
    const { createClient } = require("redis");
    client = createClient({
      url,
      socket: {
        connectTimeout: CONNECT_TIMEOUT_MS,
        reconnectStrategy: (retries) =>
          retries > MAX_RECONNECT_ATTEMPTS
            ? new Error(`Redis unreachable after ${retries} attempts`)
            : Math.min(retries * 100, 400),
      },
    });

    // node-redis emits 'error' on every failed reconnect and throws if the
    // event is unhandled. One line per outage is useful; one per retry is
    // the log spam this replaces.
    let reported = false;
    client.on("error", (e) => {
      if (reported) return;
      reported = true;
      console.error(`[${label}] redis error: ${e.message}`);
    });

    // connectTimeout bounds only the TCP handshake. A server that accepts the
    // connection and then never answers (a frozen host, a black-holed port)
    // would leave connect() pending forever -- and the caller with it.
    await withTimeout(client.connect(), CONNECT_TIMEOUT_MS * 2, "Redis handshake timed out");
    return client;
  } catch (err) {
    // Tear the half-open client down, or its socket keeps the process alive
    // and it carries on retrying in the background after we've given up.
    await destroyQuietly(client);
    console.error(
      `[${label}] Redis unavailable (${err.message}) - falling back to in-process mode.`,
    );
    return null;
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  promise.catch(() => {}); // a late failure after the timeout is not an unhandled rejection
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Close a client without caring whether it was ever connected. */
async function destroyQuietly(client) {
  if (!client) return;
  try {
    // destroy() is immediate; quit() waits for a reply that a dead server
    // will never send, which would reintroduce the hang we just removed.
    if (typeof client.destroy === "function") client.destroy();
    else if (typeof client.disconnect === "function") await client.disconnect();
  } catch {
    /* already gone */
  }
}

module.exports = { connectRedis, destroyQuietly };
