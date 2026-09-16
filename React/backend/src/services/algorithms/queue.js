/**
 * Wait-time prediction for a fuel station.
 *
 * A station is a multi-server queue: `c` nozzles serve one shared line, so it
 * is M/M/c, not M/M/1. Modelling it as a single line badly over-estimates the
 * wait -- with 4 nozzles the queue drains roughly 4x faster than one line.
 *
 * Two different questions get two different answers here:
 *
 *   etaForPosition()  "I am 7th in line right now, when do I get served?"
 *                     -> deterministic, uses the queue we can actually see.
 *
 *   mmcWaitMinutes()  "What is the typical wait at this station?"
 *                     -> steady-state Erlang C, used for search results and
 *                        for stations where we have no live queue snapshot.
 *
 * predictWait() blends the two and applies a Little's Law calibration factor
 * so the model stays honest against what the station actually achieves.
 *
 * All functions are pure. Times are minutes, rates are per hour.
 */

/**
 * Erlang C: probability an arriving customer has to wait at all
 * (i.e. finds every one of the c servers busy).
 *
 *              (cρ)^c / (c! (1-ρ))
 *   P_wait = ---------------------------------------
 *            Σ(n=0..c-1) (cρ)^n/n!  +  (cρ)^c/(c!(1-ρ))
 *
 * where ρ = λ / (cμ) is per-server utilisation.
 *
 * Computed with a running term rather than factorials: c! overflows to
 * Infinity around c=171, and (cρ)^c overflows too, but their *ratio* stays
 * small. Iterating term *= (cρ)/n keeps everything in range.
 */
function erlangC(lambda, mu, c) {
  const servers = Math.max(1, Math.floor(c));

  if (!(lambda > 0) || !(mu > 0)) return 0;

  const rho = lambda / (servers * mu);

  // Offered load >= capacity: the queue grows without bound, everyone waits.
  if (rho >= 1) return 1;

  const a = lambda / mu; // offered load in erlangs (= cρ)

  // sum = Σ(n=0..c-1) a^n/n!, tracked via term_n = a^n/n!
  let term = 1; // n = 0
  let sum = 1;
  for (let n = 1; n < servers; n++) {
    term *= a / n;
    sum += term;
  }

  // last term is a^(c-1)/(c-1)!, so one more step gives a^c/c!
  const tailTerm = (term * a) / servers; // a^c / c!
  const tail = tailTerm / (1 - rho);

  const denom = sum + tail;
  if (!Number.isFinite(denom) || denom <= 0) return 1;

  return Math.min(1, Math.max(0, tail / denom));
}

/**
 * Steady-state average wait *in queue* (excluding service), in minutes.
 *
 *   Wq = P_wait / (cμ - λ)
 */
function mmcWaitMinutes({ arrivalRatePerHour, serviceRatePerHour, nozzles }) {
  const lambda = numOr(arrivalRatePerHour, 0);
  const mu = numOr(serviceRatePerHour, 0);
  const c = Math.max(1, Math.floor(numOr(nozzles, 1)));

  if (!(mu > 0)) return null;
  if (!(lambda > 0)) return 0;

  const capacity = c * mu;

  // Over capacity: Wq is unbounded in theory. Return a large-but-finite
  // number so callers can still sort and display something sane.
  if (lambda >= capacity) return OVERLOAD_WAIT_MINUTES;

  const pWait = erlangC(lambda, mu, c);
  const wqHours = pWait / (capacity - lambda);
  return round1(wqHours * 60);
}

const OVERLOAD_WAIT_MINUTES = 120;

/**
 * Deterministic ETA for someone at a known position in a visible queue.
 *
 * With c nozzles the queue drains in batches of c, so the person at 0-based
 * index `position` waits for floor(position / c) service rounds.
 *
 *   waitMinutes = floor(position / c) * avgServiceMinutes
 *
 * `inServiceMinutesRemaining` optionally accounts for the vehicles already at
 * the pump partway through filling.
 */
function etaForPosition({
  position,
  nozzles,
  avgServiceMinutes,
  inServiceMinutesRemaining = 0,
}) {
  const pos = Math.max(0, Math.floor(numOr(position, 0)));
  const c = Math.max(1, Math.floor(numOr(nozzles, 1)));
  const svc = Math.max(0, numOr(avgServiceMinutes, 0));

  const rounds = Math.floor(pos / c);
  const remaining = Math.max(0, numOr(inServiceMinutesRemaining, 0));

  // The first round is shortened by however far along the current fills are.
  const base = rounds * svc;
  return round1(rounds > 0 ? base - Math.min(remaining, svc) + remaining : remaining);
}

/**
 * Little's Law:  L = λ · W
 *
 * Used as a sanity check, not as a predictor. If the station's *observed*
 * average queue length and arrival rate disagree with the M/M/c prediction,
 * the model's assumptions (Poisson arrivals, exponential service) are off for
 * this station and we scale our estimate to match reality.
 *
 * Returns a multiplier to apply to the modelled wait, clamped so a noisy hour
 * of data cannot swing the ETA wildly.
 */
function littlesLawCalibration({
  observedAvgQueueLength, // L
  arrivalRatePerHour, // λ
  modelledWaitMinutes, // W predicted by M/M/c
  clamp = [0.5, 2.0],
}) {
  const L = numOr(observedAvgQueueLength, NaN);
  const lambda = numOr(arrivalRatePerHour, NaN);
  const modelled = numOr(modelledWaitMinutes, NaN);

  if (!Number.isFinite(L) || !Number.isFinite(lambda) || lambda <= 0) return 1;
  if (!Number.isFinite(modelled) || modelled <= 0) return 1;

  // W_observed = L / λ, in hours -> minutes
  const observedWaitMinutes = (L / lambda) * 60;
  const factor = observedWaitMinutes / modelled;

  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return Math.min(clamp[1], Math.max(clamp[0], factor));
}

/**
 * The number callers actually want: expected wait in minutes for a customer
 * arriving now, given whatever data we happen to have about the station.
 *
 * Prefers the live queue snapshot (it is ground truth) and falls back to the
 * steady-state model. When both exist we blend, weighting the live signal
 * higher because it reflects this minute rather than this month.
 */
function predictWait(station = {}, history = {}) {
  const c = Math.max(1, Math.floor(numOr(station.nozzles, 1)));
  const svc = Math.max(0.5, numOr(station.avgServiceMinutes, 5));
  const muFromService = 60 / svc; // services per hour per nozzle

  const mu = numOr(station.serviceRatePerHour, muFromService);
  const lambda = numOr(
    history.arrivalRatePerHour,
    numOr(station.arrivalRatePerHour, NaN),
  );

  const liveQueue = numOr(station.queueLength, NaN);

  const live = Number.isFinite(liveQueue)
    ? etaForPosition({
        position: liveQueue, // an arrival joins *behind* everyone waiting
        nozzles: c,
        avgServiceMinutes: svc,
      })
    : null;

  let modelled = null;
  if (Number.isFinite(lambda)) {
    modelled = mmcWaitMinutes({
      arrivalRatePerHour: lambda,
      serviceRatePerHour: mu,
      nozzles: c,
    });

    if (modelled !== null && Number.isFinite(history.observedAvgQueueLength)) {
      const k = littlesLawCalibration({
        observedAvgQueueLength: history.observedAvgQueueLength,
        arrivalRatePerHour: lambda,
        modelledWaitMinutes: modelled,
      });
      modelled = round1(modelled * k);
    }
  }

  let waitMinutes;
  let basis;
  if (live !== null && modelled !== null) {
    waitMinutes = round1(LIVE_WEIGHT * live + (1 - LIVE_WEIGHT) * modelled);
    basis = "blended";
  } else if (live !== null) {
    waitMinutes = live;
    basis = "live-queue";
  } else if (modelled !== null) {
    waitMinutes = modelled;
    basis = "mmc-model";
  } else {
    waitMinutes = null;
    basis = "unknown";
  }

  return {
    waitMinutes,
    basis,
    nozzles: c,
    queueLength: Number.isFinite(liveQueue) ? liveQueue : null,
    utilisation: Number.isFinite(lambda) && mu > 0 ? round2(lambda / (c * mu)) : null,
    queueStatus: toQueueStatus(waitMinutes),
  };
}

const LIVE_WEIGHT = 0.7;

/**
 * Coarse bucket the UI uses for colour-coding. Uses the Station.queueStatus
 * vocabulary ("Moderate", not "Medium") so the value can be stored as-is.
 */
function toQueueStatus(waitMinutes) {
  if (!Number.isFinite(waitMinutes)) return "Unknown";
  if (waitMinutes <= 5) return "Low";
  if (waitMinutes <= 15) return "Moderate";
  return "High";
}

function numOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

module.exports = {
  erlangC,
  mmcWaitMinutes,
  etaForPosition,
  littlesLawCalibration,
  predictWait,
  toQueueStatus,
  OVERLOAD_WAIT_MINUTES,
};
