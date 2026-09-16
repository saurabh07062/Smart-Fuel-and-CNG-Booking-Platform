/**
 * services/security/rateLimiter.js against a real Redis: atomic counting under
 * concurrency, key TTLs, one count shared by several server instances,
 * recovery from a flushed script cache, and the in-process fallback when
 * Redis is unreachable.
 *
 * Needs TEST_REDIS_URL -- a throwaway Redis, never the application's -- and
 * is skipped without it. Keys it writes are tagged and removed at the end.
 *
 *   TEST_REDIS_URL=redis://127.0.0.1:6380 node --test test/rateLimiterRedis.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const TEST_REDIS_URL = process.env.TEST_REDIS_URL || "";
const MODULE = require.resolve("../src/services/security/rateLimiter");
const HOUR = 3_600_000;

/** A separate limiter instance -- what a second server process would have. */
async function limiterWith(url) {
  process.env.REDIS_URL = url;
  delete require.cache[MODULE];
  const instance = require(MODULE);
  await instance.init();
  return instance;
}

test("a Redis that accepts connections but never answers cannot stall requests", async () => {
  // No real Redis needed: a TCP server that accepts and then says nothing,
  // like a frozen host or a black-holed port.
  const net = require("net");
  const open = new Set();
  const blackHole = net.createServer((s) => {
    open.add(s);
    s.on("close", () => open.delete(s));
  });
  await new Promise((r) => blackHole.listen(0, "127.0.0.1", r));
  let limiter;
  try {
    const started = Date.now();
    limiter = await limiterWith(`redis://127.0.0.1:${blackHole.address().port}`);
    const key = `rltest-blackhole-${Date.now()}`;
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await limiter.check(key, 2, HOUR));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 6000, `requests waited ${elapsed} ms on a Redis that never answers`);
    assert.deepEqual(results.map((r) => r.allowed), [true, true, false], "still limiting, in-process");
    assert.ok(results.every((r) => r.store === "memory"));
    assert.equal(limiter.getMode(), "memory");
  } finally {
    if (limiter) await limiter.close();
    for (const s of open) s.destroy();
    blackHole.close();
    process.env.REDIS_URL = "";
  }
});

test("rate limiting against a real Redis", async (t) => {
  if (!TEST_REDIS_URL) {
    t.skip("TEST_REDIS_URL is not set");
    return;
  }

  const { createClient } = require("redis");
  const raw = createClient({ url: TEST_REDIS_URL, socket: { connectTimeout: 2000, reconnectStrategy: false } });
  raw.on("error", () => {});
  try {
    await raw.connect();
  } catch {
    t.skip(`no Redis reachable at ${TEST_REDIS_URL}`);
    return;
  }

  const tag = `rltest-redis-${Date.now()}`;
  const instances = [];
  try {
    const a = await limiterWith(TEST_REDIS_URL);
    const b = await limiterWith(TEST_REDIS_URL);
    instances.push(a, b);

    await t.test("both instances count in Redis", () => {
      assert.equal(a.getMode(), "redis");
      assert.equal(b.getMode(), "redis");
    });

    await t.test("50 concurrent requests against a limit of 10: exactly 10 get through", async () => {
      const key = `${tag}:burst`;
      const results = await Promise.all(Array.from({ length: 50 }, () => a.check(key, 10, HOUR)));
      assert.equal(results.filter((r) => r.allowed).length, 10);
      assert.ok(results.every((r) => r.store === "redis"));
    });

    await t.test("counters expire: each key carries a TTL of at most two windows", async () => {
      const key = `${tag}:ttl`;
      await a.check(key, 5, HOUR);
      const windowId = Math.floor(Date.now() / HOUR);
      const ttl = Number(await raw.sendCommand(["PTTL", `ratelimit:{${key}}:${windowId}`]));
      assert.ok(ttl > 0 && ttl <= HOUR * 2, `PTTL was ${ttl}`);
    });

    await t.test("two server instances share one count", async () => {
      const key = `${tag}:shared`;
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(await a.check(key, 8, HOUR));
        results.push(await b.check(key, 8, HOUR));
      }
      assert.equal(results.filter((r) => r.allowed).length, 8, "each instance must count the other's requests");
    });

    await t.test("a flushed script cache (e.g. a Redis restart) is recovered without failing the request", async () => {
      await raw.sendCommand(["SCRIPT", "FLUSH"]);
      const r = await a.check(`${tag}:noscript`, 5, HOUR);
      assert.equal(r.allowed, true);
      assert.equal(r.store, "redis");
    });

    await t.test("middleware over Redis answers 429 with Retry-After", async () => {
      const mw = a.rateLimit({ limit: 1, windowMs: HOUR, keyPrefix: `${tag}-mw` });
      const call = async () => {
        const res = {
          statusCode: 200,
          headers: {},
          locals: {},
          set(k, v) {
            this.headers[k] = v;
            return this;
          },
          status(c) {
            this.statusCode = c;
            return this;
          },
          json(body) {
            this.body = body;
            return this;
          },
        };
        await mw({ ip: "203.0.113.50", method: "GET", originalUrl: "/api/x" }, res, () => {});
        return res;
      };
      assert.equal((await call()).statusCode, 200);
      const refused = await call();
      assert.equal(refused.statusCode, 429);
      assert.ok(Number(refused.headers["Retry-After"]) >= 1);
    });

    await t.test("a deliberate shutdown is not recorded as a Redis outage", async () => {
      const metrics = require("../src/services/core/metrics");
      const fallbacks = () => metrics.snapshot().counters.rate_limit_redis_fallback_count || 0;
      const closing = await limiterWith(TEST_REDIS_URL);
      assert.equal(closing.getMode(), "redis");
      const before = fallbacks();
      await closing.close();
      await new Promise((r) => setImmediate(r)); // let the client's 'end' event run
      assert.equal(fallbacks(), before, "close() counted a fallback");
      assert.equal(closing.getMode(), "uninitialised");
    });

    await t.test("an unreachable Redis falls back to in-process limits; requests never fail", async () => {
      const down = await limiterWith("redis://127.0.0.1:6399");
      instances.push(down);
      assert.equal(down.getMode(), "memory");
      const results = [];
      for (let i = 0; i < 3; i++) results.push(await down.check(`${tag}:down`, 2, HOUR));
      assert.deepEqual(results.map((r) => r.allowed), [true, true, false]);
      assert.ok(results.every((r) => r.store === "memory"));
    });
  } finally {
    for (const instance of instances) await instance.close();
    const keys = await raw.sendCommand(["KEYS", `ratelimit:{${tag}*`]);
    if (keys.length) await raw.sendCommand(["DEL", ...keys]);
    raw.destroy();
    process.env.REDIS_URL = "";
  }
});
