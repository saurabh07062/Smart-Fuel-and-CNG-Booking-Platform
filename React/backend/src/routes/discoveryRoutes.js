/**
 * Station discovery + live ETA.  Mounted at /api/v1/discovery
 *
 * Public: a customer must be able to see nearby stations and wait times
 * before creating an account. Booking is where auth starts mattering.
 */

const express = require("express");
const router = express.Router();

const Station = require("../models/Station");
const discovery = require("../services/station/discovery");
const { predictWait, mmcWaitMinutes, etaForPosition } = require("../services/algorithms/queue");

/**
 * GET /api/v1/discovery/nearby?lat=&lng=&radiusKm=&fuelType=&limit=&minQuantity=
 *
 * The main customer entry point: Haversine + 2dsphere radius filter, live
 * M/M/c ETA per station, KNN trim, then weighted ranking.
 */
router.get("/nearby", async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({
      msg: "lat and lng query parameters are required and must be numbers",
    });
  }

  try {
    const weights = parseWeights(req.query);

    const stations = await discovery.findNearbyStations(
      { lat, lng },
      {
        radiusKm: req.query.radiusKm,
        limit: req.query.limit,
        fuelType: req.query.fuelType,
        minQuantity: req.query.minQuantity ? Number(req.query.minQuantity) : undefined,
        weights,
      },
    );

    res.json({
      origin: { lat, lng },
      radiusKm: Number(req.query.radiusKm) || discovery.DEFAULT_RADIUS_KM,
      count: stations.length,
      weights: weights || undefined,
      stations: stations.map(toDiscoveryDTO),
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("[discovery] nearby failed:", err);
    res.status(status).json({ msg: err.message || "Discovery failed" });
  }
});

/**
 * GET /api/v1/discovery/stations/:id/eta
 *
 * Current expected wait for one station, with the model inputs exposed so the
 * vendor/admin UI can show *why* the number is what it is.
 */
router.get("/stations/:id/eta", async (req, res) => {
  try {
    const station = await Station.findById(req.params.id).lean();
    if (!station) return res.status(404).json({ msg: "Station not found" });

    // The live lines on the station's app nozzles (services/queue/stationQueue.js).
    // Public, so only the totals -- never who is in line.
    const stationQueue = require("../services/queue/stationQueue");
    const q = (await stationQueue.queueSnapshots([station._id])).get(String(station._id));

    res.json({
      stationId: String(station._id),
      name: station.name,
      queueLength: q.queueLength,
      waitMinutes: q.waitMinutes,
      queueStatus: q.queueStatus,
      basis: q.basis,
      fuelQueues: stationQueue.fuelQueueSummary(q),
    });
  } catch (err) {
    console.error("[discovery] eta failed:", err);
    res.status(500).json({ msg: "Failed to compute ETA" });
  }
});

/**
 * GET /api/v1/discovery/stations/:id/queue-preview?fuelType=&quantity=&date=&timeSlot=
 *
 * Before booking: the real line on this station's nozzle for one fuel (from
 * live bookings and vendor-recorded walk-ins), and where a booking of
 * `quantity` at `date`/`timeSlot` would stand in it -- vehicles ahead,
 * estimated wait, service time, start and completion
 * (services/queue/stationQueue.js buildQueuePreview). date/timeSlot are
 * optional: without them the estimate is for arriving now.
 *
 * Public, like the rest of discovery; vehicles appear only as masked plates.
 */
router.get("/stations/:id/queue-preview", async (req, res) => {
  try {
    const mongoose = require("mongoose");
    const { normaliseFuel } = require("../config/fuels");
    const { QUANTITY_MIN, QUANTITY_MAX, BOOKABLE_SLOT_LABELS } = require("../config/booking");
    const { parseDateKey } = require("../config/businessTime");
    const nozzleScheduler = require("../services/queue/nozzleScheduler");

    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ msg: "Station not found" });
    const fuel = normaliseFuel(req.query.fuelType);
    if (!fuel) return res.status(400).json({ msg: "fuelType must be Petrol, Diesel or CNG" });
    const quantity = Number(req.query.quantity);
    if (!Number.isFinite(quantity) || quantity < QUANTITY_MIN || quantity > QUANTITY_MAX) {
      return res.status(400).json({ msg: `quantity is required, between ${QUANTITY_MIN} and ${QUANTITY_MAX}` });
    }

    const date = req.query.date ? String(req.query.date) : null;
    const timeSlot = req.query.timeSlot ? String(req.query.timeSlot) : null;
    if (date && !parseDateKey(date)) return res.status(400).json({ msg: "date must be a YYYY-MM-DD date" });
    if (timeSlot && !BOOKABLE_SLOT_LABELS.includes(timeSlot)) {
      return res.status(400).json({ msg: "timeSlot must be one of the bookable slots" });
    }
    if (timeSlot && !date) return res.status(400).json({ msg: "date is required with timeSlot" });

    const station = await Station.findById(req.params.id).select("name fuelTypes status").lean();
    if (!station) return res.status(404).json({ msg: "Station not found" });
    if (!(station.fuelTypes || []).some((f) => normaliseFuel(f) === fuel)) {
      return res.status(409).json({ msg: "This station does not sell that fuel" });
    }

    const preview = await require("../services/queue/stationQueue").buildQueuePreview({
      stationId: station._id,
      fuelType: fuel,
      quantity,
      slotStart: timeSlot ? nozzleScheduler.parseStartDateTime(date, timeSlot) : null,
      bookingDate: date,
    });
    res.json({ ...preview, stationName: station.name, stationActive: station.status === "Active", date, timeSlot });
  } catch (err) {
    console.error("[discovery] queue-preview failed:", err);
    res.status(500).json({ msg: "Failed to compute the queue" });
  }
});

/**
 * POST /api/v1/discovery/simulate-wait
 *
 * Runs the M/M/c model on caller-supplied numbers without touching the DB.
 * The vendor "what if I open another nozzle" planner uses this.
 */
router.post("/simulate-wait", (req, res) => {
  const { arrivalRatePerHour, serviceRatePerHour, nozzles, position, avgServiceMinutes } =
    req.body || {};

  const steadyState = mmcWaitMinutes({
    arrivalRatePerHour: Number(arrivalRatePerHour),
    serviceRatePerHour: Number(serviceRatePerHour),
    nozzles: Number(nozzles),
  });

  const positional = Number.isFinite(Number(position))
    ? etaForPosition({
        position: Number(position),
        nozzles: Number(nozzles),
        avgServiceMinutes: Number(avgServiceMinutes) || 5,
      })
    : null;

  res.json({ steadyStateWaitMinutes: steadyState, positionalWaitMinutes: positional });
});

/** Optional caller-supplied ranking weights, e.g. ?wDistance=0.6&wWait=0.3 */
function parseWeights(q) {
  const d = Number(q.wDistance);
  const w = Number(q.wWait);
  const p = Number(q.wPrice);
  if (![d, w, p].some(Number.isFinite)) return null;
  return {
    distance: Number.isFinite(d) ? d : 0.45,
    wait: Number.isFinite(w) ? w : 0.4,
    price: Number.isFinite(p) ? p : 0.15,
  };
}

/** Trim the document to what a customer list actually needs. */
function toDiscoveryDTO(s) {
  return {
    id: String(s._id),
    name: s.name,
    address: s.address,
    coordinates: s.coordinates,
    // kNearest recomputes distance via Haversine, so round at the edge rather
    // than upstream — otherwise full float precision leaks into the response.
    distanceKm: round2(s.distanceKm),
    roadDistanceKm: round2(s.roadDistanceKm),
    waitMinutes: s.waitMinutes,
    queueStatus: s.queueStatus,
    etaBasis: s.etaBasis,
    queueLength: s.queueLength,
    nozzles: s.nozzles,
    prices: s.prices,
    fuelTypes: s.fuelTypes,
    amenities: s.amenities,
    rating: s.rating,
    images: s.images,
    openingHours: s.openingHours,
    score: round3(s.score),
    scoreBreakdown: s.scoreBreakdown,
  };
}

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const round3 = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null);

module.exports = router;
