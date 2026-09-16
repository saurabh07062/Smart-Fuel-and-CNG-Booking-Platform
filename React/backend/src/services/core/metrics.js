/**
 * In-process operational counters and timings.
 *
 * Deliberately small: counters (booking_conflict_count, risk_block_count, ...)
 * and timings (count / average / max milliseconds). Exposed to admins at
 * GET /api/v1/metrics. Values are per server process and reset on restart --
 * enough to see what the booking path is doing, not a replacement for a
 * metrics backend.
 *
 * Never record customer data here: names are metric names, values are numbers.
 */

const startedAt = new Date();
const counters = new Map();
const timings = new Map();

function inc(name, by = 1) {
  counters.set(name, (counters.get(name) || 0) + by);
}

function observe(name, ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  const t = timings.get(name) || { count: 0, sumMs: 0, maxMs: 0 };
  t.count += 1;
  t.sumMs += ms;
  t.maxMs = Math.max(t.maxMs, ms);
  timings.set(name, t);
}

function snapshot() {
  return {
    since: startedAt.toISOString(),
    counters: Object.fromEntries(counters),
    timings: Object.fromEntries(
      [...timings].map(([name, t]) => [
        name,
        { count: t.count, avgMs: Math.round(t.sumMs / t.count), maxMs: Math.round(t.maxMs) },
      ]),
    ),
  };
}

function reset() {
  counters.clear();
  timings.clear();
}

module.exports = { inc, observe, snapshot, reset };
