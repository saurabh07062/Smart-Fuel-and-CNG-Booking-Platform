/**
 * Application logger.
 *
 * What a production service is expected to log, without adding a dependency:
 *
 *   - every line has a timestamp (ISO 8601, UTC), a level and a component
 *   - levels: error, warn, info, debug; LOG_LEVEL picks the minimum (default
 *     info). Per-socket and per-event chatter is debug, so it is off by default
 *   - two formats: LOG_FORMAT=json (one JSON object per line, what log
 *     platforms -- CloudWatch, Datadog, ELK, Loki -- ingest) or pretty (one
 *     readable line, for a developer's terminal). Default: json when
 *     NODE_ENV=production, pretty otherwise
 *   - no secrets or personal data: fields named like a password, token, code,
 *     cookie or authorization are redacted, and email addresses are masked
 *     (sa***@gmail.com) wherever they appear
 *   - errors keep their name, message and stack as fields
 *
 *   const log = require("./utils/logger").child("booking");
 *   log.info("Booking created", { bookingId, stationId });
 *   log.error("Booking failed", { err });
 *
 * installConsoleBridge() routes the codebase's existing console.* calls
 * through the same format, reading a leading "[tag]" as the component.
 */

const util = require("util");

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LABEL = { error: "ERROR", warn: "WARN ", info: "INFO ", debug: "DEBUG" };
const COLOR = { error: "\x1b[31m", warn: "\x1b[33m", info: "\x1b[36m", debug: "\x1b[90m" };
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const SERVICE = "fuelmart-api";
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|otp|pin$|^code$|secretcode|signature/i;
const EMAIL = /([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]*)(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const EMOJI = /[\p{Extended_Pictographic}☀-➿]️?\s*/gu;

// Kept on the real console before any bridge replaces it.
const REAL_OUT = { log: console.log.bind(console), error: console.error.bind(console) };
const out = { ...REAL_OUT };

/** Tests: send lines to fn(line, stream) instead of the console; call with no argument to restore. */
function setOutput(fn) {
  out.log = fn ? (line) => fn(line, "stdout") : REAL_OUT.log;
  out.error = fn ? (line) => fn(line, "stderr") : REAL_OUT.error;
}

const config = { level: "info", format: "pretty", color: false };

/** (Re)read LOG_LEVEL / LOG_FORMAT / NODE_ENV. Called on load and by tests. */
function configure(env = process.env) {
  const level = String(env.LOG_LEVEL || "info").toLowerCase();
  config.level = LEVELS[level] === undefined ? "info" : level;
  const format = String(env.LOG_FORMAT || (env.NODE_ENV === "production" ? "json" : "pretty")).toLowerCase();
  config.format = format === "json" ? "json" : "pretty";
  config.color = config.format === "pretty" && Boolean(process.stdout.isTTY) && env.NO_COLOR === undefined;
  return { ...config };
}
configure();

/** "saurabh001@gmail.com" -> "sa***@gmail.com". */
function maskEmails(text) {
  return String(text).replace(EMAIL, (_m, first, rest, domain) => `${first}${rest.slice(0, 1)}***${domain}`);
}

function serializeError(err) {
  if (!(err instanceof Error)) return err;
  const o = { name: err.name, message: maskEmails(err.message) };
  if (err.code !== undefined) o.code = err.code;
  if (err.stack) o.stack = maskEmails(err.stack);
  return o;
}

/** A log-safe copy: sensitive keys redacted, emails masked, errors expanded, depth-limited. */
function sanitize(value, depth = 0) {
  if (value instanceof Error) return serializeError(value);
  if (typeof value === "string") return maskEmails(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 4) return "[Object]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value.toHexString === "function") return value.toHexString(); // ObjectId
  if (value instanceof Date) return value.toISOString();
  const o = {};
  for (const [k, v] of Object.entries(value)) {
    o[k] = SENSITIVE_KEY.test(k) && v !== undefined && v !== null && v !== "" ? "[REDACTED]" : sanitize(v, depth + 1);
  }
  return o;
}

function prettyValue(v) {
  if (typeof v === "string") return /\s/.test(v) ? JSON.stringify(v) : v;
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function write(level, component, msg, fields) {
  if (LEVELS[level] > LEVELS[config.level]) return;
  const time = new Date().toISOString();
  const data = sanitize(fields || {});
  const message = maskEmails(String(msg).replace(EMOJI, "").trim());
  const stream = level === "error" || level === "warn" ? out.error : out.log;

  if (config.format === "json") {
    stream(JSON.stringify({ time, level, service: SERVICE, pid: process.pid, component, msg: message, ...data }));
    return;
  }

  const { err, ...rest } = data;
  const pairs = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${prettyValue(v)}`)
    .join(" ");
  const lvl = config.color ? `${COLOR[level]}${LABEL[level]}${RESET}` : LABEL[level];
  const ts = config.color ? `${DIM}${time}${RESET}` : time;
  let line = `${ts} ${lvl} [${component}] ${message}${pairs ? `  ${config.color ? DIM : ""}${pairs}${config.color ? RESET : ""}` : ""}`;
  if (err && typeof err === "object") {
    line += `  error=${prettyValue(err.message ?? err)}`;
    if (err.stack && (level === "error" || config.level === "debug")) line += `\n${err.stack}`;
  }
  stream(line);
}

function child(component = "app") {
  const at = (level) => (msg, fields) => write(level, component, msg, fields);
  return { error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug"), child: (sub) => child(`${component}:${sub}`) };
}

// ------------------------------------------------------------ console bridge

let bridged = false;

/** console.* args -> { component, msg, fields } -- "[lock] Redis connected" -> component "lock". */
function fromConsoleArgs(args, fallback) {
  const parts = [];
  const fields = {};
  for (const a of args) {
    if (a instanceof Error) fields.err = a;
    else if (typeof a === "string") parts.push(a);
    else if (a !== undefined) parts.push(util.inspect(a, { depth: 3, breakLength: Infinity }));
  }
  let msg = parts.join(" ").replace(EMOJI, "").trim();
  let component = fallback;
  const tag = /^\[([A-Za-z0-9 _:.\-/]+?)\]\s*/.exec(msg);
  if (tag) {
    component = tag[1].trim().toLowerCase().replace(/\s+/g, "-");
    msg = msg.slice(tag[0].length);
  }
  return { component, msg: msg.replace(/\s+/g, " ").trim(), fields };
}

/**
 * Send console.log/info/debug/warn/error through the logger, so the codebase's
 * existing calls get timestamps, levels, JSON in production and masking.
 * Installed once, by the process entry point (server.js) -- not by tests.
 */
function installConsoleBridge() {
  if (bridged) return;
  bridged = true;
  const route = (level) => (...args) => {
    const { component, msg, fields } = fromConsoleArgs(args, "app");
    write(level, component, msg || (fields.err ? fields.err.message : ""), fields);
  };
  console.log = route("info");
  console.info = route("info");
  console.debug = route("debug");
  console.warn = route("warn");
  console.error = route("error");
}

// ------------------------------------------------------------- HTTP access log

let httpLogging = false;

/** Turned on by server.js; tests that mount the app directly stay quiet. */
function enableHttpLogging(on = true) {
  httpLogging = on;
}

/**
 * Request id + one access-log line per request, written when the response
 * finishes: method, path (never the query string, which can carry tokens),
 * status, duration, client ip, user id when signed in. 5xx logs as error,
 * 4xx as warn. The id comes from X-Request-Id when a proxy set one and is
 * echoed back, so a user's report can be matched to the server's line.
 */
function requestLogger({ skip = ["/api/health"] } = {}) {
  const http = child("http");
  return (req, res, next) => {
    const incoming = req.headers["x-request-id"];
    req.id = typeof incoming === "string" && /^[A-Za-z0-9._-]{8,100}$/.test(incoming) ? incoming : require("crypto").randomUUID();
    res.setHeader("X-Request-Id", req.id);
    const started = process.hrtime.bigint();

    res.on("finish", () => {
      if (!httpLogging) return;
      const path = (req.originalUrl || req.url || "").split("?")[0];
      if (skip.includes(path)) return;
      const status = res.statusCode;
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      http[level](`${req.method} ${path} ${status}`, {
        requestId: req.id,
        method: req.method,
        path,
        status,
        durationMs: Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)),
        ip: req.ip,
        userId: req.user?.id,
        bytes: Number(res.getHeader("content-length")) || undefined,
      });
    });
    next();
  };
}

module.exports = {
  ...child("app"),
  child,
  configure,
  maskEmails,
  sanitize,
  installConsoleBridge,
  enableHttpLogging,
  requestLogger,
  fromConsoleArgs,
  setOutput,
};
