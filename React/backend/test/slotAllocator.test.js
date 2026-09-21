/**
 * Capacity and allocation core (services/queue/slotAllocator.js), pure.
 * A 30-minute window, a 30-second grid, Petrol/Diesel 40 s, CNG 300 s.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { allocate, windowCapacity, ceilToGrid } = require("../src/services/queue/slotAllocator");

const W0 = Date.UTC(2026, 8, 20, 4, 30); // 10:00 IST
const W1 = W0 + 30 * 60_000; // 10:30
const GRID = 30_000;
const PETROL = 40_000;
const CNG = 300_000;
const none = (n) => Array.from({ length: n }, () => []);
const cap = (durationMs, busyByResource, extra = {}) =>
  windowCapacity({ windowStart: W0, windowEnd: W1, durationMs, busyByResource, gridMs: GRID, ...extra });

test("30-minute Petrol window, 1 nozzle: floor(1800 / 40) = 45, back-to-back", () => {
  const c = cap(PETROL, none(1));
  assert.equal(c.total, 45);
  assert.equal(c.available, 45, "the 30-second grid does not waste nozzle time");
});

test("back-to-back: the next Petrol starts the moment the previous one ends", () => {
  const busy = [[{ start: W0, end: W0 + PETROL }]];
  const a = allocate({ windowStart: W0, windowEnd: W1, durationMs: PETROL, busyByResource: busy, gridMs: GRID });
  assert.equal(a.start, W0 + PETROL, "10:00:40, not rounded up to 10:01:00");
});

test("30-minute Diesel window: same as Petrol (40 s)", () => {
  assert.deepEqual(cap(40_000, none(1)).total, 45);
});

test("30-minute CNG window: floor(1800 / 300) = 6", () => {
  const c = cap(CNG, none(1));
  assert.equal(c.total, 6);
  assert.equal(c.available, 6);
});

test("multiple resources multiply capacity and are filled independently", () => {
  assert.equal(cap(CNG, none(2)).total, 12);
  assert.equal(cap(CNG, none(2)).available, 12);
  assert.equal(cap(PETROL, none(2)).available, 90, "45 x 2");
});

test("existing bookings reduce what is available", () => {
  // Two CNG bookings on the only CNG nozzle: 10:00-10:05 and 10:10-10:15.
  const busy = [[{ start: W0, end: W0 + CNG }, { start: W0 + 600_000, end: W0 + 900_000 }]];
  const c = cap(CNG, busy, { reservedStarts: [W0, W0 + 600_000] });
  assert.equal(c.total, 6);
  assert.equal(c.reserved, 2);
  assert.equal(c.available, 4);
});

test("the earliest free start is chosen, across resources", () => {
  // Resource 1 busy until 10:05, resource 2 busy until 10:02.
  const busy = [[{ start: W0, end: W0 + CNG }], [{ start: W0, end: W0 + 120_000 }]];
  const a = allocate({ windowStart: W0, windowEnd: W1, durationMs: CNG, busyByResource: busy, gridMs: GRID });
  assert.deepEqual(a, { resource: 2, start: W0 + 120_000, end: W0 + 120_000 + CNG });
});

test("a gap too small for the service is skipped", () => {
  // 10:00-10:04 busy, 10:05-10:30 busy: the 1-minute gap cannot take 5 minutes.
  const busy = [[{ start: W0, end: W0 + 240_000 }, { start: W0 + 300_000, end: W1 }]];
  assert.equal(allocate({ windowStart: W0, windowEnd: W1, durationMs: CNG, busyByResource: busy, gridMs: GRID }), null);
});

test("boundary: a service may end exactly at the window's end, not after it", () => {
  // Free only 10:25-10:30: exactly one CNG fits, ending at 10:30.
  const busy = [[{ start: W0, end: W1 - CNG }]];
  const a = allocate({ windowStart: W0, windowEnd: W1, durationMs: CNG, busyByResource: busy, gridMs: GRID });
  assert.deepEqual(a, { resource: 1, start: W1 - CNG, end: W1 });
  // One second less room: nothing fits.
  const tight = [[{ start: W0, end: W1 - CNG + 1000 }]];
  assert.equal(allocate({ windowStart: W0, windowEnd: W1, durationMs: CNG, busyByResource: tight, gridMs: GRID }), null);
});

test("nothing is placed before notBefore (now), and the start is on the grid", () => {
  const now = W0 + 125_000; // 10:02:05
  const a = allocate({ windowStart: W0, windowEnd: W1, notBefore: now, durationMs: PETROL, busyByResource: none(1), gridMs: GRID });
  assert.equal(a.start, W0 + 150_000, "next grid line, 10:02:30");
  assert.equal(ceilToGrid(W0 + 1, W0, GRID), W0 + GRID);
  // Late in the window, only the remaining time counts.
  assert.equal(cap(CNG, none(1), { notBefore: W1 - 600_000 }).available, 2);
});

test("a window with no resources has no capacity", () => {
  assert.deepEqual(cap(PETROL, []), { total: 0, available: 0, reserved: 0, resources: 0 });
});
