/**
 * /api/v1/queue -- RETIRED.
 *
 * These routes ran a second queue model over the Pump and QueueEntry
 * collections, which nothing ever populated (both are empty) and no client
 * called. Worse, POST /arrival and /start-fueling had no authentication and
 * wrote arrivalTime / fuelingStartTime onto any booking by id.
 *
 * The live queue and ETAs are computed from bookings in
 * services/queue/stationQueue.js, and reach clients through GET /api/stations,
 * GET /api/v1/discovery/stations/:id/eta and the realtime queue events.
 */

const express = require("express");
const router = express.Router();

const retired = (req, res) =>
  res.status(410).json({
    reason: "ENDPOINT_RETIRED",
    msg: "The /api/v1/queue endpoints have been retired. Queue and wait times come from GET /api/v1/discovery/stations/:id/eta.",
  });

router.get("/:stationId/live", retired);
router.post("/arrival", retired);
router.post("/start-fueling", retired);

module.exports = router;
