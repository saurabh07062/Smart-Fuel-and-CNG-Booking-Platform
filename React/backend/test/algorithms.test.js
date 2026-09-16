/**
 * Algorithm correctness tests. Run with:  node --test test/
 *
 * These check the maths against values computed by hand or from published
 * worked examples, not just "does it return a number".
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const geo = require("../src/services/algorithms/geo");
const queue = require("../src/services/algorithms/queue");
const forecast = require("../src/services/algorithms/forecast");
const { PriorityQueue, WaitlistRegistry } = require("../src/services/queue/waitlist");
const lock = require("../src/services/core/lock");

const close = (a, b, tol, msg) =>
  assert.ok(
    Math.abs(a - b) <= tol,
    msg || `expected ${a} within ${tol} of ${b}`,
  );

// ---------------------------------------------------------------- geo

test("haversine: known city pair (Delhi -> Mumbai ~1150km)", () => {
  const delhi = { lat: 28.6139, lng: 77.209 };
  const mumbai = { lat: 19.076, lng: 72.8777 };
  close(geo.haversineKm(delhi, mumbai), 1150, 15);
});

test("haversine: equator degree of longitude matches mean-radius value", () => {
  // 2*pi*R/360 with R = 6371.0088 km (IUGG mean) = 111.195 km.
  // The familiar 111.32 figure uses the WGS84 equatorial radius instead.
  const expected = (2 * Math.PI * geo.EARTH_RADIUS_KM) / 360;
  close(geo.haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }), expected, 1e-6);
  close(expected, 111.195, 0.01);
});

test("haversine: identical points are exactly 0", () => {
  const p = { lat: 18.5314, lng: 73.8446 };
  assert.equal(geo.haversineKm(p, p), 0);
});

test("haversine: antipodal points are half the circumference", () => {
  const d = geo.haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
  close(d, Math.PI * geo.EARTH_RADIUS_KM, 1);
});

test("haversine: rejects malformed or out-of-range coordinates", () => {
  assert.equal(geo.haversineKm(null, { lat: 0, lng: 0 }), null);
  assert.equal(geo.haversineKm({ lat: 91, lng: 0 }, { lat: 0, lng: 0 }), null);
  assert.equal(geo.haversineKm({ lat: 0, lng: 181 }, { lat: 0, lng: 0 }), null);
});

test("kNearest returns k closest in ascending distance order", () => {
  const origin = { lat: 28.6, lng: 77.2 };
  const stations = [
    { name: "far", coordinates: { lat: 28.9, lng: 77.5 } },
    { name: "near", coordinates: { lat: 28.61, lng: 77.21 } },
    { name: "mid", coordinates: { lat: 28.7, lng: 77.3 } },
  ];
  const got = geo.kNearest(origin, stations, 2);
  assert.deepEqual(got.map((s) => s.name), ["near", "mid"]);
  assert.ok(got[0].distanceKm < got[1].distanceKm);
});

test("kNearest reads GeoJSON [lng,lat] order correctly", () => {
  const origin = { lat: 28.6, lng: 77.2 };
  const s = [{ name: "g", location: { type: "Point", coordinates: [77.21, 28.61] } }];
  const got = geo.kNearest(origin, s, 1);
  close(got[0].distanceKm, 1.47, 0.2);
});

test("withinRadius excludes stations beyond the cutoff", () => {
  const origin = { lat: 0, lng: 0 };
  const stations = [
    { name: "in", coordinates: { lat: 0, lng: 0.02 } }, // ~2.2km
    { name: "out", coordinates: { lat: 0, lng: 0.5 } }, // ~55km
  ];
  const got = geo.withinRadius(origin, stations, 5);
  assert.deepEqual(got.map((s) => s.name), ["in"]);
});

test("rankStations: cheapest+closest+fastest wins outright", () => {
  const ranked = geo.rankStations(
    [
      { name: "best", distanceKm: 1, waitMinutes: 2, prices: { petrol: 90 } },
      { name: "worst", distanceKm: 9, waitMinutes: 30, prices: { petrol: 110 } },
    ],
    undefined,
    { fuelType: "petrol" },
  );
  assert.equal(ranked[0].name, "best");
  assert.equal(ranked[0].score, 0);
});

test("rankStations: weights actually shift the winner", () => {
  const candidates = [
    { name: "close-slow", distanceKm: 1, waitMinutes: 40, prices: { petrol: 100 } },
    { name: "far-fast", distanceKm: 8, waitMinutes: 2, prices: { petrol: 100 } },
  ];
  const byDistance = geo.rankStations(candidates, { distance: 1, wait: 0, price: 0 });
  const byWait = geo.rankStations(candidates, { distance: 0, wait: 1, price: 0 });

  assert.equal(byDistance[0].name, "close-slow");
  assert.equal(byWait[0].name, "far-fast");
});

test("rankStations: a factor where all tie cannot affect ordering", () => {
  const ranked = geo.rankStations(
    [
      { name: "a", distanceKm: 5, waitMinutes: 10, prices: { petrol: 100 } },
      { name: "b", distanceKm: 5, waitMinutes: 10, prices: { petrol: 100 } },
    ],
    undefined,
    { fuelType: "petrol" },
  );
  assert.equal(ranked[0].score, 0);
  assert.equal(ranked[1].score, 0);
});

test("rankStations: empty input is empty output, not a crash", () => {
  assert.deepEqual(geo.rankStations([]), []);
  assert.deepEqual(geo.rankStations(null), []);
});

test("toGeoPoint emits [lng,lat] for 2dsphere", () => {
  assert.deepEqual(geo.toGeoPoint(28.61, 77.21), {
    type: "Point",
    coordinates: [77.21, 28.61],
  });
  assert.equal(geo.toGeoPoint(NaN, 1), undefined);
});

// -------------------------------------------------------------- queue

test("erlangC: single server reduces to rho", () => {
  // For M/M/1, P(wait) = rho exactly.
  close(queue.erlangC(0.5, 1, 1), 0.5, 1e-9);
  close(queue.erlangC(0.8, 1, 1), 0.8, 1e-9);
});

test("erlangC: textbook M/M/2 case", () => {
  // lambda=1, mu=1, c=2 -> rho=0.5, a=1
  // P_wait = (1/2!/(1-.5)) / (1 + 1 + 1/2!/(1-.5)) = 1 / 3
  close(queue.erlangC(1, 1, 2), 1 / 3, 1e-9);
});

test("erlangC: saturated system means everyone waits", () => {
  assert.equal(queue.erlangC(10, 1, 5), 1); // rho = 2
  assert.equal(queue.erlangC(5, 1, 5), 1); // rho = 1 exactly
});

test("erlangC: more servers strictly reduces wait probability", () => {
  const p2 = queue.erlangC(3, 2, 2);
  const p4 = queue.erlangC(3, 2, 4);
  assert.ok(p4 < p2, `expected ${p4} < ${p2}`);
});

test("erlangC: large c does not overflow via factorial", () => {
  const p = queue.erlangC(150, 1, 200);
  assert.ok(Number.isFinite(p) && p >= 0 && p <= 1, `got ${p}`);
});

test("mmcWait: M/M/1 matches closed form Wq = rho/(mu-lambda)", () => {
  // lambda=0.5/min? use per-hour: lambda=30, mu=60, c=1 -> Wq = .5/(60-30) h = 1 min
  close(
    queue.mmcWaitMinutes({ arrivalRatePerHour: 30, serviceRatePerHour: 60, nozzles: 1 }),
    1,
    0.05,
  );
});

test("mmcWait: adding nozzles cuts the wait", () => {
  const one = queue.mmcWaitMinutes({ arrivalRatePerHour: 30, serviceRatePerHour: 12, nozzles: 3 });
  const two = queue.mmcWaitMinutes({ arrivalRatePerHour: 30, serviceRatePerHour: 12, nozzles: 6 });
  assert.ok(two < one, `${two} should be < ${one}`);
});

test("mmcWait: overloaded station returns a finite sentinel", () => {
  const w = queue.mmcWaitMinutes({ arrivalRatePerHour: 100, serviceRatePerHour: 10, nozzles: 2 });
  assert.equal(w, queue.OVERLOAD_WAIT_MINUTES);
  assert.ok(Number.isFinite(w));
});

test("mmcWait: zero arrivals means zero wait", () => {
  assert.equal(
    queue.mmcWaitMinutes({ arrivalRatePerHour: 0, serviceRatePerHour: 12, nozzles: 2 }),
    0,
  );
});

test("etaForPosition: drains in batches of c", () => {
  // 4 nozzles, 5 min service. Positions 0-3 -> 0 rounds. Position 4 -> 1 round.
  const p = (position) =>
    queue.etaForPosition({ position, nozzles: 4, avgServiceMinutes: 5 });
  assert.equal(p(0), 0);
  assert.equal(p(3), 0);
  assert.equal(p(4), 5);
  assert.equal(p(8), 10);
});

test("etaForPosition: single nozzle is strictly linear", () => {
  const p = (position) =>
    queue.etaForPosition({ position, nozzles: 1, avgServiceMinutes: 6 });
  assert.equal(p(0), 0);
  assert.equal(p(1), 6);
  assert.equal(p(3), 18);
});

test("littlesLaw: agreement returns a factor of ~1", () => {
  // lambda=12/h, modelled W=5min -> L = lambda*W = 12*(5/60) = 1
  const k = queue.littlesLawCalibration({
    observedAvgQueueLength: 1,
    arrivalRatePerHour: 12,
    modelledWaitMinutes: 5,
  });
  close(k, 1, 1e-9);
});

test("littlesLaw: under-prediction scales the estimate up", () => {
  // observed L=2 at lambda=12 -> W_obs=10min vs modelled 5 -> factor 2
  const k = queue.littlesLawCalibration({
    observedAvgQueueLength: 2,
    arrivalRatePerHour: 12,
    modelledWaitMinutes: 5,
  });
  close(k, 2, 1e-9);
});

test("littlesLaw: factor is clamped against noisy data", () => {
  const hi = queue.littlesLawCalibration({
    observedAvgQueueLength: 100,
    arrivalRatePerHour: 12,
    modelledWaitMinutes: 5,
  });
  const lo = queue.littlesLawCalibration({
    observedAvgQueueLength: 0.001,
    arrivalRatePerHour: 12,
    modelledWaitMinutes: 5,
  });
  assert.equal(hi, 2.0);
  assert.equal(lo, 0.5);
});

test("littlesLaw: missing data is a no-op factor of 1", () => {
  assert.equal(queue.littlesLawCalibration({}), 1);
  assert.equal(
    queue.littlesLawCalibration({ observedAvgQueueLength: 5, arrivalRatePerHour: 0 }),
    1,
  );
});

test("predictWait: uses live queue when available", () => {
  const r = queue.predictWait({ queueLength: 8, nozzles: 4, avgServiceMinutes: 5 });
  assert.equal(r.basis, "live-queue");
  assert.equal(r.waitMinutes, 10);
  assert.equal(r.queueStatus, "Moderate");
});

test("predictWait: falls back to the model with no live data", () => {
  const r = queue.predictWait(
    { nozzles: 2, avgServiceMinutes: 5 },
    { arrivalRatePerHour: 12 },
  );
  assert.equal(r.basis, "mmc-model");
  assert.ok(Number.isFinite(r.waitMinutes));
});

test("predictWait: blends when both signals exist", () => {
  const r = queue.predictWait(
    { queueLength: 8, nozzles: 4, avgServiceMinutes: 5 },
    { arrivalRatePerHour: 12 },
  );
  assert.equal(r.basis, "blended");
});

test("predictWait: no data at all reports unknown rather than guessing", () => {
  const r = queue.predictWait({}, {});
  assert.equal(r.basis, "unknown");
  assert.equal(r.waitMinutes, null);
  assert.equal(r.queueStatus, "Unknown");
});

test("queueStatus buckets", () => {
  assert.equal(queue.toQueueStatus(3), "Low");
  assert.equal(queue.toQueueStatus(12), "Moderate");
  assert.equal(queue.toQueueStatus(45), "High");
  assert.equal(queue.toQueueStatus(NaN), "Unknown");
});

// ----------------------------------------------------------- forecast

test("SMA: averages the trailing window only", () => {
  assert.equal(forecast.simpleMovingAverage([10, 20, 30, 40], 2), 35);
  assert.equal(forecast.simpleMovingAverage([10, 20, 30, 40], 4), 25);
});

test("SMA: window larger than the series clamps", () => {
  assert.equal(forecast.simpleMovingAverage([10, 20], 99), 15);
});

test("SES: constant series smooths to that constant", () => {
  const r = forecast.exponentialSmoothing([50, 50, 50, 50], 0.3);
  close(r.forecast, 50, 1e-9);
});

test("SES: recursion matches hand calculation", () => {
  // S0=100; S1=.5*200+.5*100=150; S2=.5*300+.5*150=225
  const r = forecast.exponentialSmoothing([100, 200, 300], 0.5);
  assert.deepEqual(r.smoothed, [100, 150, 225]);
  assert.equal(r.forecast, 225);
});

test("SES: higher alpha reacts faster to a jump", () => {
  const slow = forecast.exponentialSmoothing([10, 10, 10, 100], 0.1).forecast;
  const fast = forecast.exponentialSmoothing([10, 10, 10, 100], 0.9).forecast;
  assert.ok(fast > slow);
});

test("Holt: projects a linear trend forward", () => {
  // Perfectly linear +100/period; forecast should continue upward.
  const r = forecast.holtLinearTrend([100, 200, 300, 400, 500], 0.5, 0.5, 1);
  assert.ok(r.trend > 0, `trend was ${r.trend}`);
  assert.ok(r.forecast > 500, `forecast ${r.forecast} should exceed last value`);
});

test("Holt: never forecasts negative demand", () => {
  const r = forecast.holtLinearTrend([500, 400, 300, 200, 100, 50], 0.5, 0.5, 10);
  assert.ok(r.forecast >= 0, `got ${r.forecast}`);
});

test("forecast: picks Holt for a trending series", () => {
  const r = forecast.forecast([100, 150, 200, 250, 300, 350]);
  assert.equal(r.method, "holt-linear-trend");
  assert.ok(r.value > 350);
});

test("forecast: picks SES for a flat noisy series", () => {
  const r = forecast.forecast([100, 98, 102, 99, 101, 100]);
  assert.equal(r.method, "exponential-smoothing");
  close(r.value, 100, 5);
});

test("forecast: degrades gracefully on thin history", () => {
  assert.equal(forecast.forecast([]).method, "none");
  assert.equal(forecast.forecast([100]).method, "moving-average");
  assert.equal(forecast.forecast([100, 120]).method, "moving-average");
});

test("mape: perfect fit is 0% error", () => {
  assert.equal(forecast.mape([10, 20, 30], [10, 20, 30]), 0);
});

test("mape: skips zero actuals instead of returning Infinity", () => {
  const m = forecast.mape([0, 100], [50, 110]);
  assert.ok(Number.isFinite(m), `got ${m}`);
  close(m, 10, 0.01);
});

// reorderPlan: safety stock from measured daily variation.
const days = (values) => ({ days: values.map((quantity, i) => ({ date: `d${i}`, quantity })) });
const alternating = (n, a, b) => Array.from({ length: n }, (_, i) => (i % 2 ? b : a));

test("reorderPlan: held back until 28 complete days, with the count so far", () => {
  const r = forecast.reorderPlan({ daily: days(alternating(27, 10, 20)), leadTimeDays: 2, available: 100 });
  assert.equal(r.ready, false);
  assert.equal(r.sampleDays, 27);
  assert.equal(r.requiredDays, 28);
  assert.match(r.reason, /needs 28 complete days .* there are 27 so far/);
  assert.equal(r.safetyStock, undefined, "no numbers from too little history");

  assert.match(forecast.reorderPlan({ daily: days([]) }).reason, /No customer sales history yet/);
  assert.match(forecast.reorderPlan({ daily: days(new Array(30).fill(0)) }).reason, /No customer sales in the last 30 days/);
});

test("reorderPlan: reorder point = d x L + z x sigma x sqrt(L)", () => {
  // 28 days alternating 10 / 20: mean 15, sample sd = sqrt(28 x 25 / 27).
  const sd = Math.sqrt((28 * 25) / 27);
  const r = forecast.reorderPlan({ daily: days(alternating(28, 10, 20)), leadTimeDays: 4, serviceLevel: 95, available: 50, periodDays: 30 });
  assert.equal(r.ready, true);
  assert.equal(r.dailyDemand, 15);
  close(r.dailyStdDev, sd, 0.01);
  assert.equal(r.leadTimeDemand, 60);
  close(r.safetyStock, 1.6449 * sd * 2, 0.01);
  close(r.reorderPoint, 60 + 1.6449 * sd * 2, 0.01);
  assert.equal(r.shouldReorder, true, "50 available is below the reorder point");
  assert.equal(r.cycleBasis, "daily-average");
  assert.equal(r.cycleDemand, 450);
  close(r.suggestedQty, 450 + 1.6449 * sd * 2 - 50, 0.02);
  close(r.daysOfCover, 50 / 15, 0.01);
  close(r.variability, sd / 15, 0.01);
});

test("reorderPlan: safety stock rises with service level and with sqrt of lead time; steady demand needs none", () => {
  const series = days(alternating(40, 5, 25));
  const at = (serviceLevel, leadTimeDays) => forecast.reorderPlan({ daily: series, serviceLevel, leadTimeDays, available: 1000 }).safetyStock;
  assert.ok(at(90, 4) < at(95, 4) && at(95, 4) < at(98, 4) && at(98, 4) < at(99, 4));
  close(at(95, 9) / at(95, 1), 3, 0.01, "nine days of lead time needs three times the safety stock of one");
  assert.equal(at(95, 0), 0, "stock that arrives immediately needs no buffer");

  const steady = forecast.reorderPlan({ daily: days(new Array(30).fill(12)), leadTimeDays: 3, available: 10 });
  assert.equal(steady.safetyStock, 0);
  assert.equal(steady.reorderPoint, 36);
  assert.equal(forecast.reorderPlan({ daily: series, available: 1000, leadTimeDays: 2 }).shouldReorder, false);

  assert.throws(() => forecast.reorderPlan({ daily: series, serviceLevel: 80 }), /serviceLevel must be one of/);
});

test("reorderPlan: an unreliable lead time adds safety stock; a fixed one reduces to z x sigma x sqrt(L)", () => {
  const series = days(alternating(28, 10, 20)); // mean 15
  const sd = Math.sqrt((28 * 25) / 27);
  const fixed = forecast.reorderPlan({ daily: series, leadTimeDays: 4, leadTimeSdDays: 0, available: 1000 });
  close(fixed.safetyStock, 1.6449 * sd * 2, 0.01);

  const variable = forecast.reorderPlan({ daily: series, leadTimeDays: 4, leadTimeSdDays: 1.5, leadTimeBasis: "measured", available: 1000 });
  close(variable.safetyStock, 1.6449 * Math.sqrt(4 * sd * sd + 15 * 15 * 1.5 * 1.5), 0.01);
  assert.ok(variable.safetyStock > fixed.safetyStock);
  assert.equal(variable.leadTimeBasis, "measured");
  assert.equal(variable.leadTimeSdDays, 1.5);

  const notReady = forecast.reorderPlan({ daily: days([5]), leadTimeDays: 3, leadTimeBasis: "assumed" });
  assert.equal(notReady.leadTimeBasis, "assumed", "the basis is reported even before a plan is ready");
});

test("reorderPlan: orders for next month's forecast when there is one", () => {
  const r = forecast.reorderPlan({
    daily: days(new Array(30).fill(10)),
    leadTimeDays: 2,
    available: 100,
    periodDays: 31,
    monthForecast: { ready: true, value: 500 },
  });
  assert.equal(r.cycleBasis, "forecast");
  assert.equal(r.cycleDemand, 500);
  assert.equal(r.suggestedQty, 400);
  const noForecast = forecast.reorderPlan({ daily: days(new Array(30).fill(10)), available: 100, periodDays: 31, monthForecast: { ready: false, value: null } });
  assert.equal(noForecast.cycleBasis, "daily-average");
  assert.equal(noForecast.cycleDemand, 310);
});

// ---------------------------------------------------------- waitlist

test("PriorityQueue: pops in priority order", () => {
  const q = new PriorityQueue();
  q.push("c", 3);
  q.push("a", 1);
  q.push("b", 2);
  assert.deepEqual([q.pop(), q.pop(), q.pop()], ["a", "b", "c"]);
  assert.equal(q.pop(), undefined);
});

test("PriorityQueue: equal priorities keep insertion order (stable FIFO)", () => {
  const q = new PriorityQueue();
  ["first", "second", "third", "fourth"].forEach((v) => q.push(v, 5));
  assert.deepEqual(
    [q.pop(), q.pop(), q.pop(), q.pop()],
    ["first", "second", "third", "fourth"],
  );
});

test("PriorityQueue: heap property survives a randomised workload", () => {
  const q = new PriorityQueue();
  const vals = Array.from({ length: 500 }, () => Math.floor(Math.random() * 1000));
  vals.forEach((v) => q.push(v, v));

  const out = [];
  while (!q.isEmpty()) out.push(q.pop());

  assert.deepEqual(out, [...vals].sort((a, b) => a - b));
});

test("PriorityQueue: remove() repairs the heap", () => {
  const q = new PriorityQueue();
  [5, 1, 9, 3, 7].forEach((v) => q.push(v, v));
  assert.equal(q.remove((v) => v === 3), 3);
  assert.equal(q.size, 4);
  const out = [];
  while (!q.isEmpty()) out.push(q.pop());
  assert.deepEqual(out, [1, 5, 7, 9]);
});

test("PriorityQueue: removing a non-existent value is a no-op", () => {
  const q = new PriorityQueue();
  q.push("x", 1);
  assert.equal(q.remove((v) => v === "nope"), undefined);
  assert.equal(q.size, 1);
});

test("Waitlist: FIFO promotion and 1-based positions", () => {
  const wl = new WaitlistRegistry();
  wl.enqueue("st1", { bookingId: "b1" }, 1000);
  wl.enqueue("st1", { bookingId: "b2" }, 2000);
  wl.enqueue("st1", { bookingId: "b3" }, 3000);

  assert.equal(wl.size("st1"), 3);
  assert.equal(wl.positionOf("st1", (e) => e.bookingId === "b2"), 2);
  assert.equal(wl.promoteNext("st1").bookingId, "b1");
  assert.equal(wl.positionOf("st1", (e) => e.bookingId === "b2"), 1);
});

test("Waitlist: cancelling mid-queue promotes everyone behind", () => {
  const wl = new WaitlistRegistry();
  ["b1", "b2", "b3"].forEach((id, i) => wl.enqueue("st1", { bookingId: id }, 1000 + i));

  wl.cancel("st1", "b2");
  assert.equal(wl.size("st1"), 2);
  assert.equal(wl.positionOf("st1", (e) => e.bookingId === "b3"), 2);
  assert.equal(wl.promoteNext("st1").bookingId, "b1");
  assert.equal(wl.promoteNext("st1").bookingId, "b3");
});

test("Waitlist: stations have independent queues", () => {
  const wl = new WaitlistRegistry();
  wl.enqueue("A", { bookingId: "a1" }, 1);
  wl.enqueue("B", { bookingId: "b1" }, 2);
  assert.equal(wl.size("A"), 1);
  assert.equal(wl.size("B"), 1);
  assert.equal(wl.promoteNext("A").bookingId, "a1");
  assert.equal(wl.size("B"), 1);
});

test("Waitlist: empty station returns undefined, not a throw", () => {
  const wl = new WaitlistRegistry();
  assert.equal(wl.promoteNext("nope"), undefined);
  assert.equal(wl.positionOf("nope", () => true), -1);
  assert.deepEqual(wl.list("nope"), []);
});

test("Waitlist: rebuildFrom restores order after a restart", () => {
  const wl = new WaitlistRegistry().rebuildFrom([
    { _id: "b2", station: "s1", createdAt: new Date(2000) },
    { _id: "b1", station: "s1", createdAt: new Date(1000) },
  ]);
  assert.equal(wl.promoteNext("s1").bookingId, "b1");
});

// -------------------------------------------------------------- lock

test("lock: second acquire on the same key fails while held", async () => {
  const key = "test:lock:basic";
  const t1 = await lock.tryAcquire(key, 5000);
  const t2 = await lock.tryAcquire(key, 5000);
  assert.ok(t1, "first acquire should succeed");
  assert.equal(t2, null, "second acquire must fail");
  await lock.release(key, t1);
});

test("lock: released key can be re-acquired", async () => {
  const key = "test:lock:release";
  const t1 = await lock.tryAcquire(key, 5000);
  await lock.release(key, t1);
  const t2 = await lock.tryAcquire(key, 5000);
  assert.ok(t2);
  await lock.release(key, t2);
});

test("lock: release with a foreign token does not steal the lock", async () => {
  const key = "test:lock:token";
  const mine = await lock.tryAcquire(key, 5000);
  assert.equal(await lock.release(key, "not-my-token"), false);
  // still held
  assert.equal(await lock.tryAcquire(key, 5000), null);
  await lock.release(key, mine);
});

test("lock: expired lock becomes available again", async () => {
  const key = "test:lock:ttl";
  const t1 = await lock.tryAcquire(key, 50);
  assert.ok(t1);
  await new Promise((r) => setTimeout(r, 80));
  const t2 = await lock.tryAcquire(key, 500);
  assert.ok(t2, "lock should have expired");
  await lock.release(key, t2);
});

test("lock: withLock releases even when the body throws", async () => {
  const key = "test:lock:throw";
  await assert.rejects(
    lock.withLock(key, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  const t = await lock.tryAcquire(key, 500);
  assert.ok(t, "lock must not leak after a throw");
  await lock.release(key, t);
});

test("lock: concurrent bookings on one slot serialise (no double-book)", async () => {
  const key = lock.slotKey("station-1", "2026-01-01", "10:00");
  let seats = 1;
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      lock
        .withLock(key, async () => {
          // read-modify-write that would race without the lock
          const available = seats;
          await new Promise((r) => setTimeout(r, 1));
          if (available > 0) {
            seats = available - 1;
            return "booked";
          }
          return "full";
        }, { maxWaitMs: 4000 })
        .catch(() => "timeout"),
    ),
  );
  assert.equal(results.filter((r) => r === "booked").length, 1, "exactly one booking");
  assert.equal(seats, 0);
});

test("lock: slotKey is stable and collision-free across slots", () => {
  assert.equal(lock.slotKey("s1", "2026-01-01", "10:00"), "lock:slot:s1:2026-01-01:10:00");
  assert.notEqual(
    lock.slotKey("s1", "2026-01-01", "10:00"),
    lock.slotKey("s1", "2026-01-01", "10:30"),
  );
});

test.after(async () => {
  await lock.close();
});
