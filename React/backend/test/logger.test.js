/**
 * utils/logger.js: levels, both formats, masking and redaction, the console
 * bridge's "[tag]" parsing, and the per-request access log with request id.
 * No database; output is captured, not printed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const logger = require("../src/utils/logger");

/** Run fn with the logger's output captured (not printed). */
function capture(fn) {
  const lines = [];
  logger.setOutput((line) => lines.push(line));
  try {
    fn();
  } finally {
    logger.setOutput();
  }
  return lines;
}

test.afterEach(() => logger.configure({ LOG_LEVEL: "info", LOG_FORMAT: "pretty" }));

test("json format: one object per line with time, level, component, message and fields", () => {
  logger.configure({ LOG_FORMAT: "json", LOG_LEVEL: "info" });
  const [line] = capture(() => logger.child("booking").info("Booking created", { bookingId: "b1", amount: 105 }));
  const o = JSON.parse(line);
  assert.equal(o.level, "info");
  assert.equal(o.component, "booking");
  assert.equal(o.msg, "Booking created");
  assert.equal(o.bookingId, "b1");
  assert.equal(o.amount, 105);
  assert.equal(o.service, "fuelmart-api");
  assert.ok(!Number.isNaN(Date.parse(o.time)) && o.time.endsWith("Z"), "ISO UTC timestamp");
});

test("production defaults to JSON, development to pretty", () => {
  assert.equal(logger.configure({ NODE_ENV: "production" }).format, "json");
  assert.equal(logger.configure({}).format, "pretty");
});

test("pretty format: timestamp, level, [component], message, key=value", () => {
  logger.configure({ LOG_FORMAT: "pretty" });
  const [line] = capture(() => logger.child("mongodb").info("Connected", { host: "localhost", port: 27017 }));
  assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO  \[mongodb\] Connected  host=localhost port=27017$/);
});

test("LOG_LEVEL hides lower levels; debug is off by default", () => {
  logger.configure({ LOG_FORMAT: "json" });
  const log = logger.child("realtime");
  assert.equal(capture(() => log.debug("connect")).length, 0);
  logger.configure({ LOG_FORMAT: "json", LOG_LEVEL: "debug" });
  assert.equal(capture(() => log.debug("connect")).length, 1);
  logger.configure({ LOG_FORMAT: "json", LOG_LEVEL: "warn" });
  assert.equal(capture(() => log.info("hidden")).length, 0);
  assert.equal(capture(() => log.error("shown")).length, 1);
});

test("emails are masked and secrets redacted, in messages and fields", () => {
  logger.configure({ LOG_FORMAT: "json" });
  const [line] = capture(() =>
    logger.child("email").info("Email sent to saurabh001@gmail.com", {
      to: "saurabh001@gmail.com",
      password: "hunter2",
      nested: { accessToken: "abc.def", code: "ABCD-EFGH" },
      authorization: "Bearer x",
    }),
  );
  assert.ok(!line.includes("saurabh001"), line);
  assert.ok(!/hunter2|abc\.def|ABCD-EFGH|Bearer x/.test(line), line);
  const o = JSON.parse(line);
  assert.equal(o.to, "sa***@gmail.com");
  assert.equal(o.msg, "Email sent to sa***@gmail.com");
  assert.equal(o.password, "[REDACTED]");
  assert.equal(o.nested.accessToken, "[REDACTED]");
});

test("errors keep name, message and stack", () => {
  logger.configure({ LOG_FORMAT: "json" });
  const [line] = capture(() => logger.child("x").error("Failed", { err: new TypeError("boom") }));
  const o = JSON.parse(line);
  assert.equal(o.level, "error");
  assert.equal(o.err.name, "TypeError");
  assert.equal(o.err.message, "boom");
  assert.match(o.err.stack, /TypeError: boom/);
});

test("console bridge: '[tag] message' becomes the component, emojis are dropped", () => {
  assert.deepEqual(logger.fromConsoleArgs(["[lock] Redis connected - distributed locking active"], "app"), {
    component: "lock",
    msg: "Redis connected - distributed locking active",
    fields: {},
  });
  const e = new Error("x");
  const parsed = logger.fromConsoleArgs(["[Email] ✅ Sent", e], "app");
  assert.equal(parsed.component, "email");
  assert.equal(parsed.msg, "Sent");
  assert.equal(parsed.fields.err, e);
  assert.equal(logger.fromConsoleArgs(["plain"], "app").component, "app");
});

test("access log: request id header, one line per request with method, path (no query), status and duration", async () => {
  logger.configure({ LOG_FORMAT: "json" });
  logger.enableHttpLogging(true);
  const express = require("express");
  const app = express();
  app.use(logger.requestLogger());
  app.get("/api/thing", (req, res) => res.status(201).json({ ok: true }));
  app.get("/api/broken", (req, res) => res.status(500).end());
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const lines = [];
  logger.setOutput((line) => lines.push(line));
  try {
    const ok = await fetch(`${base}/api/thing?token=secret123`);
    assert.match(ok.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
    const echoed = await fetch(`${base}/api/thing`, { headers: { "X-Request-Id": "trace-12345678" } });
    assert.equal(echoed.headers.get("x-request-id"), "trace-12345678");
    await fetch(`${base}/api/broken`);
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    logger.setOutput();
    logger.enableHttpLogging(false);
    await new Promise((r) => server.close(r));
  }

  const entries = lines.map((l) => JSON.parse(l));
  assert.equal(entries.length, 3);
  assert.equal(entries[0].component, "http");
  assert.equal(entries[0].path, "/api/thing");
  assert.equal(entries[0].status, 201);
  assert.equal(entries[0].method, "GET");
  assert.equal(typeof entries[0].durationMs, "number");
  assert.ok(!JSON.stringify(entries).includes("secret123"), "query strings are never logged");
  assert.equal(entries[1].requestId, "trace-12345678");
  assert.equal(entries[2].level, "error", "5xx logs as error");
});
