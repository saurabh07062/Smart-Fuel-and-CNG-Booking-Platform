/**
 * Recalibrates each station's queueing-model inputs from real booking
 * history, instead of the seed-only values every station started with.
 *
 * arrivalRatePerHour and observedAvgQueueLength are exactly the two fields
 * services/algorithms/queue.js needs -- arrivalRatePerHour is lambda for the Erlang-C
 * model, observedAvgQueueLength is L for the Little's Law calibration (see
 * predictWait() and littlesLawCalibration()). Before this job existed,
 * nothing but a handful of one-off seed scripts ever set those fields, so
 * the model silently never ran on real data for a station created through
 * the normal vendor-onboarding flow.
 *
 * observedAvgQueueLength has no true time-series to average, since the
 * Station document only ever stores the *current* queueLength, overwritten
 * in place. The honest proxy here is "how many bookings typically land on
 * the same (date, timeSlot)" -- a real signal computed from real data,
 * clearly documented as an approximation rather than a fabricated number.
 *
 * Runs on an interval from server.js; safe to call repeatedly and cheap
 * enough to run every few minutes.
 */

const Station = require("../../models/Station");
const Booking = require("../../models/Booking");

const DEFAULT_WINDOW_DAYS = 7;
const ACTIVE_STATUSES = ["upcoming", "serving", "waitlisted", "completed"];

/**
 * Recompute one station's metrics from its own booking history.
 * Exported separately so it's unit-testable without iterating every station.
 *
 * Returns null (and leaves the station untouched) when there isn't enough
 * recent activity to learn from -- zeroing out a quiet station's arrival
 * rate would be worse than leaving its last known value in place.
 */
async function recomputeStationMetrics(stationId, { windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await Booking.aggregate([
    {
      $match: {
        station: stationId,
        createdAt: { $gte: since },
        status: { $in: ACTIVE_STATUSES },
      },
    },
    {
      $group: {
        _id: { bookingDate: "$bookingDate", timeSlot: "$timeSlot" },
        count: { $sum: 1 },
      },
    },
    {
      $group: {
        _id: null,
        observedAvgQueueLength: { $avg: "$count" },
        totalBookings: { $sum: "$count" },
      },
    },
  ]);

  const summary = rows[0];
  if (!summary || !summary.totalBookings) {
    return null;
  }

  const windowHours = windowDays * 24;
  const arrivalRatePerHour = round2(summary.totalBookings / windowHours);
  const observedAvgQueueLength = round2(summary.observedAvgQueueLength);

  await Station.updateOne(
    { _id: stationId },
    { $set: { arrivalRatePerHour, observedAvgQueueLength } },
  );

  return { arrivalRatePerHour, observedAvgQueueLength, sampleSize: summary.totalBookings };
}

/**
 * Recompute every active station. Logged, never throws -- a bad window for
 * one station must not stop the rest from updating.
 */
async function recomputeAllStationMetrics(opts = {}) {
  const stations = await Station.find({ status: "Active" }).select("_id").lean();

  let updated = 0;
  for (const s of stations) {
    try {
      const result = await recomputeStationMetrics(s._id, opts);
      if (result) updated++;
    } catch (err) {
      console.error(`[stationMetrics] failed for station ${s._id}:`, err.message);
    }
  }
  return { total: stations.length, updated };
}

/** Start the recurring job. Returns the interval handle so callers can stop it. */
function startStationMetricsJob({ intervalMs = 15 * 60_000 } = {}) {
  const run = () => {
    // Once per interval across all server instances (services/core/lock.js).
    require("../core/lock")
      .runExclusive("stationMetrics", Math.max(1_000, intervalMs - 1_000), () => recomputeAllStationMetrics())
      .then(({ ran, result }) => {
        if (ran && result.updated > 0) {
          console.log(`[stationMetrics] refreshed ${result.updated}/${result.total} active station(s)`);
        }
      })
      .catch((err) => console.error("[stationMetrics] job failed:", err.message));
  };

  run(); // don't wait a full interval for the first calibration after boot
  const handle = setInterval(run, intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}

const round2 = (n) => Math.round(n * 100) / 100;

module.exports = {
  recomputeStationMetrics,
  recomputeAllStationMetrics,
  startStationMetricsJob,
  DEFAULT_WINDOW_DAYS,
};
