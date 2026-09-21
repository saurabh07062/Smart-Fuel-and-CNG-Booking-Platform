/**
 * Regression checks from the algorithm audit, each against an independent
 * reference (closed form, hand calculation or a worked scenario).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const q = require("../src/services/algorithms/queue");
const fc = require("../src/services/algorithms/forecast");
const { simulateNozzleLine } = require("../src/services/queue/stationQueue");

test("queue ETA counts the fill already in progress", () => {
  // 1 nozzle, 5-min fills, 2 min left on the car at the pump.
  const eta = (position) => q.etaForPosition({ position, nozzles: 1, avgServiceMinutes: 5, inServiceMinutesRemaining: 2 });
  assert.equal(eta(0), 2);
  assert.equal(eta(1), 7);
  assert.equal(eta(2), 12);
  // 2 nozzles: positions 0-1 wait for the fills in progress, 2-3 one fill more.
  assert.equal(q.etaForPosition({ position: 3, nozzles: 2, avgServiceMinutes: 5, inServiceMinutesRemaining: 1 }), 6);
  // Without the time left, unchanged: floor(position / c) fills.
  assert.equal(q.etaForPosition({ position: 5, nozzles: 2, avgServiceMinutes: 4 }), 8);
});

test("M/M/1 wait matches the closed form ρ/(μ−λ)", () => {
  for (const [lambda, mu] of [[5, 6], [3, 10], [9, 10]]) {
    const want = Math.round((lambda / mu / (mu - lambda)) * 60 * 10) / 10;
    assert.equal(q.mmcWaitMinutes({ arrivalRatePerHour: lambda, serviceRatePerHour: mu, nozzles: 1 }), want);
  }
});

test("Holt's accuracy is measured on its real one-step forecasts (level + trend)", () => {
  const linear = [100, 110, 120, 130, 140, 150, 160, 170];
  const f = fc.forecast(linear);
  assert.equal(f.method, "holt-linear-trend");
  assert.equal(f.value, 180);
  assert.equal(f.errorPercent, 0, "a perfect straight line is forecast with no error");

  const holt = fc.holtLinearTrend([10, 20, 30], 0.5, 0.5);
  assert.deepEqual(holt.fitted, [20, 30], "forecast of each next period made before seeing it");
});

test("live queue: a worked scenario on one nozzle", () => {
  const now = new Date("2026-09-19T10:00:00Z");
  const at = (min) => new Date(now.getTime() + min * 60_000);
  const rows = [
    // At the pump since 09:58, 5-minute fill: nozzle free at 10:03.
    { _id: "serving", status: "serving", fuelType: "Petrol", fuelingStartTime: at(-2), serviceDurationSeconds: 300 },
    // Checked in at 09:59, waiting: gets the nozzle at 10:03, done 10:08.
    { _id: "arrived", status: "upcoming", fuelType: "Petrol", arrivalTime: at(-1), bookingStartTime: at(-5), serviceDurationSeconds: 300 },
    // Slot at 10:05, not arrived yet: nozzle is busy until 10:08, so 10:08.
    { _id: "later", status: "upcoming", fuelType: "Petrol", bookingStartTime: at(5), serviceDurationSeconds: 300 },
    // Slot at 10:30: the nozzle is free by then, so its own slot time.
    { _id: "evening", status: "upcoming", fuelType: "Petrol", bookingStartTime: at(30), serviceDurationSeconds: 300 },
  ];
  const line = simulateNozzleLine(rows, now);
  const eta = Object.fromEntries(line.etas.map((e) => [e.bookingId, e.etaMinutes]));
  assert.deepEqual(eta, { serving: 0, arrived: 3, later: 8, evening: 30 });
  assert.equal(line.queueLength, 2, "at the pump now: the car fuelling and the one checked in");
  assert.equal(line.waitMinutes, 8, "someone arriving now waits until 10:08");
});
