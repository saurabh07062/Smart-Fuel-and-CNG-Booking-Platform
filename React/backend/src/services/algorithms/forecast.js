/**
 * Demand forecasting from a station's sales history.
 *
 * Vendors use this to answer "how much fuel should I order for next month".
 * Three estimators, deliberately simple and explainable -- a vendor has to
 * trust the number enough to spend money on it:
 *
 *   simpleMovingAverage      equal weight over the last n periods
 *   exponentialSmoothing     geometrically decaying weight (recency-biased)
 *   holtLinearTrend          exponential smoothing + a trend term
 *
 * Plain SES cannot follow a trend -- it always lags a growing series, which
 * would systematically under-order for a station whose demand is climbing.
 * Holt's method adds a slope, so forecast() picks it when a trend is present.
 *
 * All functions are pure and take/return plain numbers.
 */

/**
 * Unweighted mean of the last `window` observations.
 * Robust and easy to explain, but throws away the ordering: a series that
 * doubled last month reads the same as one that halved.
 */
function simpleMovingAverage(series, window = 3) {
  const xs = clean(series);
  if (xs.length === 0) return null;

  const w = Math.max(1, Math.min(Math.floor(window), xs.length));
  const slice = xs.slice(-w);
  return round2(slice.reduce((a, b) => a + b, 0) / w);
}

/**
 * Single exponential smoothing (SES).
 *
 *   S_t = α·x_t + (1-α)·S_{t-1}
 *
 * α in (0,1] sets how fast old data decays. α=0.3 is a common default:
 * responsive to change without chasing noise. Returns the full smoothed
 * series so callers can chart the fit alongside the actuals.
 */
function exponentialSmoothing(series, alpha = 0.3) {
  const xs = clean(series);
  if (xs.length === 0) return { smoothed: [], forecast: null };

  const a = clamp01(alpha);
  const smoothed = [xs[0]];

  for (let t = 1; t < xs.length; t++) {
    smoothed.push(a * xs[t] + (1 - a) * smoothed[t - 1]);
  }

  return {
    smoothed: smoothed.map(round2),
    // SES is flat: every future period gets the last smoothed level.
    forecast: round2(smoothed[smoothed.length - 1]),
  };
}

/**
 * Holt's linear trend method -- SES with a second smoothed component for slope.
 *
 *   level_t = α·x_t + (1-α)(level_{t-1} + trend_{t-1})
 *   trend_t = β(level_t - level_{t-1}) + (1-β)·trend_{t-1}
 *   forecast(h) = level_t + h·trend_t
 *
 * Needs at least 2 observations to seed the trend.
 */
function holtLinearTrend(series, alpha = 0.3, beta = 0.1, horizon = 1) {
  const xs = clean(series);
  if (xs.length < 2) {
    const ses = exponentialSmoothing(xs, alpha);
    return { level: ses.forecast, trend: 0, forecast: ses.forecast, points: [], fitted: [] };
  }

  const a = clamp01(alpha);
  const b = clamp01(beta);

  let level = xs[0];
  let trend = xs[1] - xs[0];
  const points = [level];
  // One-step-ahead forecasts: fitted[t-1] is what the model predicted for
  // x_t before seeing it (level + trend of period t-1) -- what its error is
  // measured against. The level alone leaves the trend out.
  const fitted = [];

  for (let t = 1; t < xs.length; t++) {
    fitted.push(level + trend);
    const prevLevel = level;
    level = a * xs[t] + (1 - a) * (level + trend);
    trend = b * (level - prevLevel) + (1 - b) * trend;
    points.push(level);
  }

  const h = Math.max(1, Math.floor(horizon));
  return {
    level: round2(level),
    trend: round2(trend),
    forecast: round2(Math.max(0, level + h * trend)),
    points: points.map(round2),
    fitted: fitted.map(round2),
  };
}

/**
 * Mean absolute percentage error between actuals and fitted values.
 * Used to decide which estimator to trust and to show the vendor a
 * confidence figure instead of a bare number.
 *
 * Periods where actual === 0 are skipped: percentage error is undefined there
 * and including them produces an infinite MAPE.
 */
function mape(actual, fitted) {
  const a = clean(actual);
  const f = clean(fitted);
  const n = Math.min(a.length, f.length);
  if (n === 0) return null;

  let sum = 0;
  let counted = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === 0) continue;
    sum += Math.abs((a[i] - f[i]) / a[i]);
    counted++;
  }
  return counted === 0 ? null : round2((sum / counted) * 100);
}

/**
 * Pick an estimator and forecast `horizon` periods ahead.
 *
 * Chooses Holt when the series is long enough and actually trending, SES
 * otherwise, and falls back to a moving average when there is barely any
 * history. Reports which method won and its in-sample error so the vendor UI
 * can show "±12%" rather than implying false precision.
 */
function forecast(series, { horizon = 1, alpha = 0.3, beta = 0.1 } = {}) {
  const xs = clean(series);

  if (xs.length === 0) {
    return { value: null, method: "none", errorPercent: null, sampleSize: 0 };
  }
  if (xs.length < READINESS.minPointsForSmoothing) {
    return {
      value: simpleMovingAverage(xs, xs.length),
      method: "moving-average",
      errorPercent: null,
      sampleSize: xs.length,
      note: "Not enough history to measure accuracy or estimate a trend.",
    };
  }

  const ses = exponentialSmoothing(xs, alpha);
  const holt = holtLinearTrend(xs, alpha, beta, horizon);

  const sesErr = mape(xs.slice(1), ses.smoothed.slice(0, -1));
  // Holt's trend is seeded from x_0 and x_1, so its forecast of x_1 is exact
  // by construction; its error is measured from x_2 on.
  const holtErr = mape(xs.slice(2), holt.fitted.slice(1));

  // Prefer Holt only when the trend is meaningful relative to the level;
  // a near-zero slope means SES is the simpler equivalent model.
  const level = Math.abs(holt.level) || 1;
  const trendIsMeaningful = Math.abs(holt.trend) / level > 0.02;

  // A slope from a handful of points is mostly noise: a trend is only
  // estimated once there are enough periods to see one.
  const useHolt =
    xs.length >= READINESS.minPointsForTrend &&
    trendIsMeaningful &&
    holtErr !== null &&
    (sesErr === null || holtErr <= sesErr);

  // errorPercent: mean absolute percentage error of the one-step-ahead
  // forecasts over the history -- how far off each month's forecast was.
  // It is an error, not a confidence: lower is better.
  return useHolt
    ? {
        value: holt.forecast,
        method: "holt-linear-trend",
        errorPercent: holtErr,
        trend: holt.trend,
        sampleSize: xs.length,
      }
    : {
        value: ses.forecast,
        method: "exponential-smoothing",
        errorPercent: sesErr,
        trend: 0,
        sampleSize: xs.length,
      };
}

/**
 * How much history each method needs before it is used.
 *   smoothing  3 complete periods (and so at least 2 measured errors)
 *   trend      6 complete periods
 *   run rate   14 days since the first sale, before any month is complete
 *   variation  28 complete days of daily demand before a standard deviation
 *              is trusted for safety stock -- four weeks, so every weekday is
 *              seen at least four times
 */
const READINESS = Object.freeze({
  minPointsForSmoothing: 3,
  minPointsForTrend: 6,
  minDaysForRunRate: 14,
  minDaysForVariation: 28,
});

/** good <= 15% typical error, fair <= 35%, poor above; unmeasured without enough history. */
function reliabilityOf(errorPercent) {
  if (errorPercent === null || errorPercent === undefined || !Number.isFinite(errorPercent)) return "unmeasured";
  if (errorPercent <= 15) return "good";
  if (errorPercent <= 35) return "fair";
  return "poor";
}

const monthDays = (key) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const nextMonthKey = (key) => {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/**
 * Next month's value from a sales history (services/inventory/demandHistory.js), only
 * as far as the history supports:
 *
 *   no complete month   ready: false. After 14 days of sales, a run rate
 *                       (daily average since the first sale x days next
 *                       month) is offered separately and labelled as such.
 *   1-2 complete months moving average; accuracy "unmeasured"
 *   3+                  exponential smoothing, with its measured error
 *   6+                  Holt's trend method when a trend is real
 *
 * The running month is never fitted.
 */
function forecastFromHistory(history, { horizon = 1 } = {}) {
  const months = history?.months || [];
  const complete = months.filter((m) => m.complete).map((m) => m.value);
  const current = history?.current || null;
  const forMonth = current ? nextMonthKey(current.month) : null;
  const partialNote =
    current && months.some((m) => !m.complete)
      ? `The current month (${current.daysElapsed} of ${current.daysInMonth} days) is not used until it ends.`
      : null;

  const excluded = history?.excludedBookings || 0;
  const excludedText = `${excluded} booked by vendor or admin accounts ${excluded === 1 ? "is" : "are"} not counted`;

  if (complete.length === 0) {
    const days = history?.daysObserved || 0;
    const runRate =
      days >= READINESS.minDaysForRunRate && forMonth
        ? {
            value: round2((history.totalValue / days) * monthDays(forMonth)),
            basis: "daily average since the first sale, times the days in next month",
            daysObserved: days,
          }
        : null;
    return {
      ready: false,
      forMonth,
      value: null,
      method: "insufficient-history",
      errorPercent: null,
      reliability: "unmeasured",
      completeMonths: 0,
      daysObserved: days,
      runRate,
      reason:
        days === 0
          ? excluded
            ? `No completed customer sales yet (${excludedText}).`
            : "No completed sales yet."
          : `Only ${days} day${days === 1 ? "" : "s"} of sales so far. A monthly forecast needs at least one complete month.` +
            (excluded ? ` ${excluded} sale${excluded === 1 ? "" : "s"} ${excludedText.slice(String(excluded).length + 1)}.` : ""),
    };
  }

  const f = forecast(complete, { horizon });
  const notes = [];
  if (complete.length < READINESS.minPointsForSmoothing) {
    notes.push(
      `Based on ${complete.length} complete month${complete.length === 1 ? "" : "s"}: a plain average whose accuracy cannot be measured yet.`,
    );
  } else if (complete.length < READINESS.minPointsForTrend) {
    notes.push(`A trend is not estimated until ${READINESS.minPointsForTrend} complete months exist.`);
  }
  if (partialNote) notes.push(partialNote);
  if (excluded) {
    notes.push(`${excluded} sale${excluded === 1 ? "" : "s"} ${excludedText.slice(String(excluded).length + 1)}.`);
  }

  return {
    ready: true,
    forMonth,
    value: f.value,
    method: f.method,
    errorPercent: f.errorPercent ?? null,
    reliability: reliabilityOf(f.errorPercent),
    trend: f.trend ?? 0,
    completeMonths: complete.length,
    daysObserved: history.daysObserved,
    note: notes.join(" ") || null,
  };
}

/**
 * z for a cycle service level: the probability of NOT running out while a
 * delivery is on its way (standard normal quantiles).
 */
const SERVICE_LEVEL_Z = Object.freeze({ 90: 1.2816, 95: 1.6449, 98: 2.0537, 99: 2.3263 });

/**
 * Reorder point and order quantity from how demand actually varies.
 *
 *   d  = mean daily demand            sigma = sample std. dev. of daily demand
 *   L  = delivery lead time (days)    z     = SERVICE_LEVEL_Z[serviceLevel]
 *
 *   lead-time demand  = d x L
 *   safety stock      = z x sqrt(L x sigma^2 + d^2 x sigma_L^2)
 *   reorder point     = lead-time demand + safety stock
 *
 * sigma_L is how much the lead time itself varies (services/inventory/leadTime.js, from
 * recorded order-to-delivery times). With a fixed lead time it is 0 and safety
 * stock is z x sigma x sqrt(L); an unreliable supplier adds to it.
 *   suggested order   = next period's demand + safety stock - available stock
 *
 * Safety stock grows with how erratic demand is and with the square root of
 * the lead time (independent daily variation adds in variance, not in
 * spread). Next period's demand is the monthly forecast when one exists,
 * else the daily average times the days in the period, and says which.
 *
 * Held back -- ready: false with a reason -- until there are
 * READINESS.minDaysForVariation complete days: a standard deviation from a
 * handful of days is noise, and a reorder point built on it would be too.
 *
 * Assumes day-to-day demand is roughly independent and stable over the
 * window (no seasonality model); `variability` (sigma / d) lets the vendor
 * see how erratic the history is.
 *
 * @param {object} p
 * @param {{days:Array<{quantity:number}>}} p.daily  services/inventory/demandHistory.js dailyDemand
 * @param {number} p.leadTimeDays
 * @param {number} [p.leadTimeSdDays]  standard deviation of the lead time, days
 * @param {string|null} [p.leadTimeBasis]  "entered" | "measured" | "assumed"
 * @param {number} p.serviceLevel  90 | 95 | 98 | 99
 * @param {number} p.available     stock not already held for bookings
 * @param {object|null} p.monthForecast  forecastFromHistory result
 * @param {number} p.periodDays    days in the period being ordered for
 */
function reorderPlan({
  daily,
  leadTimeDays = 2,
  leadTimeSdDays = 0,
  leadTimeBasis = null,
  serviceLevel = 95,
  available = 0,
  monthForecast = null,
  periodDays = 30,
}) {
  const z = SERVICE_LEVEL_Z[serviceLevel];
  if (!z) throw new Error(`serviceLevel must be one of ${Object.keys(SERVICE_LEVEL_Z).join(", ")}`);

  const qty = (daily?.days || []).map((d) => Number(d.quantity) || 0);
  const n = qty.length;
  const required = READINESS.minDaysForVariation;
  const L = Math.max(0, Number(leadTimeDays) || 0);
  const sL = Math.max(0, Number(leadTimeSdDays) || 0);
  const base = {
    ready: false,
    sampleDays: n,
    requiredDays: required,
    serviceLevel,
    leadTimeDays: L,
    leadTimeSdDays: sL,
    leadTimeBasis,
  };

  if (n < required) {
    return {
      ...base,
      reason:
        n === 0
          ? "No customer sales history yet, so there is no demand to plan a reorder for."
          : `Safety stock needs ${required} complete days of customer sales to measure how demand varies; there ${n === 1 ? "is" : "are"} ${n} so far.`,
    };
  }

  const mean = qty.reduce((a, b) => a + b, 0) / n;
  if (!(mean > 0)) {
    return { ...base, reason: `No customer sales in the last ${n} days, so there is no demand to plan a reorder for.` };
  }
  const sd = Math.sqrt(qty.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));

  const leadTimeDemand = mean * L;
  const safetyStock = z * Math.sqrt(L * sd * sd + mean * mean * sL * sL);
  const reorderPoint = leadTimeDemand + safetyStock;

  const useForecast = monthForecast?.ready === true && Number.isFinite(monthForecast.value);
  const cycleDemand = useForecast ? monthForecast.value : mean * periodDays;
  const stock = Number.isFinite(available) ? available : 0;

  return {
    ready: true,
    sampleDays: n,
    requiredDays: required,
    serviceLevel,
    z,
    leadTimeDays: L,
    leadTimeSdDays: sL,
    leadTimeBasis,
    dailyDemand: round2(mean),
    dailyStdDev: round2(sd),
    variability: round2(sd / mean),
    leadTimeDemand: round2(leadTimeDemand),
    safetyStock: round2(safetyStock),
    reorderPoint: round2(reorderPoint),
    cycleDemand: round2(cycleDemand),
    cycleBasis: useForecast ? "forecast" : "daily-average",
    periodDays,
    available: round2(stock),
    shouldReorder: stock <= reorderPoint,
    suggestedQty: round2(Math.max(0, cycleDemand + safetyStock - stock)),
    daysOfCover: round2(stock / mean),
  };
}

function clean(series) {
  return (series || []).map(Number).filter(Number.isFinite);
}
const clamp01 = (v) => Math.min(1, Math.max(0.001, Number(v) || 0.3));
const round2 = (n) => Math.round(n * 100) / 100;

module.exports = {
  simpleMovingAverage,
  exponentialSmoothing,
  holtLinearTrend,
  mape,
  forecast,
  forecastFromHistory,
  reliabilityOf,
  reorderPlan,
  SERVICE_LEVEL_Z,
  READINESS,
};
