/**
 * Delivery lead time, measured from the station's own deliveries.
 *
 * Lead time is how long an ORDER takes to arrive. The gap between two
 * deliveries is something else -- how often the station reorders -- and using
 * it as lead time would make safety stock describe the ordering habit rather
 * than the supplier. So lead time is measured only from deliveries recorded
 * with the date they were ordered (InventoryMovement.orderedOn):
 *
 *   leadTimeDays = India calendar days from the order date to the delivery day
 *
 * With at least LEAD_TIME.minSamples such deliveries in the window, the median
 * is used (robust to one late tanker) and the spread feeds safety stock
 * (services/algorithms/forecast.js reorderPlan). The delivery interval is reported
 * alongside, clearly as what it is.
 */

const mongoose = require("mongoose");
const InventoryMovement = require("../../models/InventoryMovement");
const { normaliseFuel } = require("../../config/fuels");
const { parseDateKey } = require("../../config/businessTime");

const DAY_MS = 24 * 60 * 60 * 1000;

const LEAD_TIME = Object.freeze({
  /** Measured deliveries needed before lead time is taken from them. */
  minSamples: 3,
  /** How far back deliveries count. */
  windowDays: 180,
  /** Longest order-to-delivery gap accepted when a delivery is recorded. */
  maxRecordableDays: 60,
  /** Used, and labelled "assumed", when nothing was entered or measured. */
  defaultDays: 2,
});

const round2 = (n) => Math.round(n * 100) / 100;

/** Whole India calendar days from key `a` to key `b` ("YYYY-MM-DD"); null if either is invalid. */
function daysBetweenKeys(a, b) {
  const pa = parseDateKey(a);
  const pb = parseDateKey(b);
  if (!pa || !pb) return null;
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / DAY_MS);
}

function median(xs) {
  const s = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * @returns {Promise<{ready:boolean, samples:number, requiredSamples:number,
 *   windowDays:number, medianDays:number|null, meanDays:number|null,
 *   sdDays:number|null, deliveries:number, deliveriesWithoutOrderDate:number,
 *   deliveryIntervalMedianDays:number|null, lastDeliveryAt:Date|null}>}
 */
async function measuredLeadTime(stationId, fuel, { now = new Date(), windowDays = LEAD_TIME.windowDays } = {}) {
  const key = normaliseFuel(fuel);
  const rows = key
    ? await InventoryMovement.find({
        station: new mongoose.Types.ObjectId(String(stationId)),
        fuel: key,
        type: "delivery",
        createdAt: { $gte: new Date(now.getTime() - windowDays * DAY_MS), $lte: now },
      })
        .select("createdAt leadTimeDays")
        .sort({ createdAt: 1 })
        .lean()
    : [];

  const samples = rows.map((r) => r.leadTimeDays).filter((v) => Number.isFinite(v));
  const n = samples.length;
  const mean = n ? samples.reduce((a, b) => a + b, 0) / n : null;
  const sd = n >= 2 ? Math.sqrt(samples.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : null;
  const gaps = rows.slice(1).map((r, i) => (new Date(r.createdAt) - new Date(rows[i].createdAt)) / DAY_MS);

  return {
    ready: n >= LEAD_TIME.minSamples,
    samples: n,
    requiredSamples: LEAD_TIME.minSamples,
    windowDays,
    medianDays: n ? round2(median(samples)) : null,
    meanDays: mean === null ? null : round2(mean),
    sdDays: sd === null ? null : round2(sd),
    deliveries: rows.length,
    deliveriesWithoutOrderDate: rows.length - n,
    deliveryIntervalMedianDays: gaps.length ? round2(median(gaps)) : null,
    lastDeliveryAt: rows.at(-1)?.createdAt ?? null,
  };
}

/**
 * The lead time a reorder plan should use, and why:
 *   entered   the vendor gave one for this calculation
 *   measured  median of recorded order-to-delivery times (enough samples)
 *   assumed   neither -- LEAD_TIME.defaultDays, to be replaced by real data
 */
function chooseLeadTime({ enteredDays = null, measured = null }) {
  if (enteredDays !== null && enteredDays !== undefined) {
    return { usedDays: enteredDays, sdDays: 0, basis: "entered" };
  }
  if (measured?.ready) {
    return { usedDays: measured.medianDays, sdDays: measured.sdDays || 0, basis: "measured" };
  }
  return { usedDays: LEAD_TIME.defaultDays, sdDays: 0, basis: "assumed" };
}

module.exports = { measuredLeadTime, chooseLeadTime, daysBetweenKeys, LEAD_TIME };
