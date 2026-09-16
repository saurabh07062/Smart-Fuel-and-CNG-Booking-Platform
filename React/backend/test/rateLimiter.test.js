/**
 * services/security/rateLimiter.js with its in-process store, and config/proxy.js.
 * The Redis store is covered by rateLimiterRedis.test.js.
 *
 *   node --test test/rateLimiter.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
process.env.REDIS_URL = ""; // this file tests the in-process store

const rateLimiter = require("../src/services/security/rateLimiter");
const { retryAfterFor, rateLimit, check, clientIp } = rateLimiter;
const { trustProxySetting } = require("../src/config/proxy");

const HOUR = 3_600_000; // long windows, so a test never straddles a window boundary

test.after(() => rateLimiter.close());

/** The sliding-window estimate for one more request `d` ms from now, with nothing sent meanwhile. */
function estimateAfter({ windowMs, elapsedMs, current, previous }, d) {
  const t = elapsedMs + d;
  if (t < windowMs) return previous * ((windowMs - t) / windowMs) + current + 1;
  if (t < 2 * windowMs) return current * ((2 * windowMs - t) / windowMs) + 1;
  return 1;
}

test("retryAfterFor is exact: allowed at Retry-After, still refused 1 ms sooner", () => {
  const cases = [
    { limit: 10, windowMs: 60_000, elapsedMs: 30_000, current: 11, previous: 0 },
    { limit: 10, windowMs: 60_000, elapsedMs: 30_000, current: 5, previous: 10 },
    { limit: 3, windowMs: 1_000, elapsedMs: 900, current: 8, previous: 6 },
    { limit: 20, windowMs: 60_000, elapsedMs: 1, current: 20, previous: 40 },
    { limit: 1, windowMs: 5_000, elapsedMs: 2_500, current: 1, previous: 0 },
  ];
  for (const c of cases) {
    const d = retryAfterFor(c);
    assert.ok(estimateAfter(c, d) <= c.limit + 1e-9, `${JSON.stringify(c)}: still refused after ${d} ms`);
    if (d > 0) assert.ok(estimateAfter(c, d - 1) > c.limit, `${JSON.stringify(c)}: already allowed after ${d - 1} ms`);
  }
});

test("check refuses past the limit, and refused requests keep counting", async () => {
  const key = `rltest-${Date.now()}-count`;
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await check(key, 3, HOUR));
  assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false, false, false]);
  assert.equal(results[0].remaining, 2);
  assert.equal(results[0].store, "memory");
  assert.ok(results[5].retryAfterMs > results[3].retryAfterMs, "hammering while refused must lengthen the wait, not shorten it");
});

test("waiting Retry-After gets the next request through", async () => {
  const key = `rltest-${Date.now()}-wait`;
  const windowMs = 400;
  let last;
  for (let i = 0; i < 4; i++) last = await check(key, 2, windowMs);
  assert.equal(last.allowed, false);
  await new Promise((r) => setTimeout(r, last.retryAfterMs + 25));
  assert.equal((await check(key, 2, windowMs)).allowed, true);
});

// ---------------------------------------------------------------------------
// middleware
// ---------------------------------------------------------------------------

function fakeReqRes(ip = "203.0.113.7") {
  const req = { ip, method: "POST", originalUrl: "/api/test?x=1" };
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    locals: {},
    set(k, v) {
      this.headers[k] = v;
      return this;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  return { req, res };
}

async function run(mw, ip) {
  const { req, res } = fakeReqRes(ip);
  let passed = false;
  await mw(req, res, () => {
    passed = true;
  });
  return { passed, res };
}

test("middleware: standard 429 body and RateLimit headers", async () => {
  const mw = rateLimit({ limit: 2, windowMs: HOUR, keyPrefix: `rltest-mw-${Date.now()}` });
  const first = await run(mw);
  assert.equal(first.passed, true);
  assert.equal(first.res.headers["RateLimit-Limit"], "2");
  assert.equal(first.res.headers["RateLimit-Remaining"], "1");
  assert.equal(first.res.headers["X-RateLimit-Limit"], "2");

  await run(mw);
  const third = await run(mw);
  assert.equal(third.passed, false);
  assert.equal(third.res.statusCode, 429);
  assert.equal(third.res.body.reason, "RATE_LIMITED");
  assert.equal(third.res.body.success, false);
  assert.ok(third.res.body.msg);
  assert.ok(Number(third.res.headers["Retry-After"]) >= 1);
  assert.equal(third.res.headers["Retry-After"], String(third.res.body.retryAfterSeconds));
  assert.equal(third.res.headers["RateLimit-Remaining"], "0");
});

test("middleware: each IP is its own bucket, and an empty identity never shares one", async () => {
  const mw = rateLimit({ limit: 1, windowMs: HOUR, keyPrefix: `rltest-ident-${Date.now()}`, keyFn: () => undefined });
  assert.equal((await run(mw, "198.51.100.1")).passed, true);
  assert.equal((await run(mw, "198.51.100.2")).passed, true, "another client's count must not refuse this one");
  assert.equal((await run(mw, "198.51.100.1")).passed, false);
});

test("middleware: stacked limiters report the tighter one; skip bypasses only its own limiter", async () => {
  const prefix = `rltest-stack-${Date.now()}`;
  const tight = rateLimit({ limit: 3, windowMs: HOUR, keyPrefix: `${prefix}-tight` });
  const loose = rateLimit({ limit: 100, windowMs: HOUR, keyPrefix: `${prefix}-loose` });
  const { req, res } = fakeReqRes("192.0.2.9");
  await tight(req, res, () => {});
  await loose(req, res, () => {});
  assert.equal(res.headers["RateLimit-Limit"], "3", "the looser limiter must not overwrite the tighter one's headers");

  const skipped = rateLimit({ limit: 1, windowMs: HOUR, keyPrefix: `${prefix}-skip`, skip: () => true });
  for (let i = 0; i < 3; i++) assert.equal((await run(skipped)).passed, true);
});

test("middleware: onLimited hears each refusal, and its failure cannot break the response", async () => {
  const seen = [];
  const mw = rateLimit({
    limit: 1,
    windowMs: HOUR,
    keyPrefix: `rltest-on-${Date.now()}`,
    onLimited: (_req, result) => {
      seen.push(result.limit);
      throw new Error("logger down");
    },
  });
  await run(mw, "192.0.2.10");
  const refused = await run(mw, "192.0.2.10");
  assert.equal(refused.res.statusCode, 429);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [1]);
});

// ---------------------------------------------------------------------------
// client identity
// ---------------------------------------------------------------------------

test("clientIp: an IPv4-mapped IPv6 address and plain IPv4 are the same client", () => {
  assert.equal(clientIp({ ip: "::ffff:203.0.113.5" }), "203.0.113.5");
  assert.equal(clientIp({ ip: "203.0.113.5" }), "203.0.113.5");
  assert.equal(clientIp({ socket: { remoteAddress: "2001:db8::1" } }), "2001:db8::1");
});

test("TRUST_PROXY: off by default, hop counts or proxy addresses, and never 'true'", () => {
  assert.equal(trustProxySetting({}), false);
  assert.equal(trustProxySetting({ TRUST_PROXY: "false" }), false);
  assert.equal(trustProxySetting({ TRUST_PROXY: "1" }), 1);
  assert.deepEqual(trustProxySetting({ TRUST_PROXY: "loopback, 10.0.0.0/8" }), ["loopback", "10.0.0.0/8"]);
  assert.throws(() => trustProxySetting({ TRUST_PROXY: "true" }), /TRUST_PROXY=true/);
});

test("a spoofed X-Forwarded-For cannot buy a fresh bucket unless a proxy is configured", async () => {
  const express = require("express");
  const make = (trust) => {
    const app = express();
    app.set("trust proxy", trust);
    app.get(
      "/x",
      rateLimit({ limit: 1, windowMs: HOUR, keyPrefix: `rltest-xff-${String(trust)}-${Date.now()}` }),
      (_req, res) => res.json({ ok: true }),
    );
    return app.listen(0);
  };
  const hit = (server, xff) =>
    fetch(`http://127.0.0.1:${server.address().port}/x`, { headers: { "X-Forwarded-For": xff } }).then((r) => r.status);
  const stop = (server) => {
    server.closeAllConnections?.();
    server.close();
  };

  const direct = make(trustProxySetting({}));
  try {
    assert.equal(await hit(direct, "1.1.1.1"), 200);
    assert.equal(await hit(direct, "2.2.2.2"), 429, "a made-up forwarded address must not reset the count");
  } finally {
    stop(direct);
  }

  const proxied = make(trustProxySetting({ TRUST_PROXY: "1" }));
  try {
    assert.equal(await hit(proxied, "1.1.1.1"), 200);
    assert.equal(await hit(proxied, "2.2.2.2"), 200, "behind one real proxy, the forwarded client is the identity");
    assert.equal(await hit(proxied, "1.1.1.1"), 429);
  } finally {
    stop(proxied);
  }
});
