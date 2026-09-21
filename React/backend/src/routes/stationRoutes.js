const express = require("express");
const router = express.Router();
const stationController = require("../controllers/stationController");
const adminAuth = require("../middleware/admin");

// ============================================================
// PUBLIC ROUTES (no auth required)
// ============================================================
router.get("/", stationController.getAllStations);
router.get("/search", stationController.searchStations);
router.get("/nearby", stationController.getNearbyStations);
router.get("/nearest", stationController.getNearestStations);
router.get("/stats", adminAuth, stationController.getStationStats);
// Road distance from a point to this station (services/station/roadDistance.js).
router.get("/:id/route", stationController.getRouteDistance);
router.get("/:id", stationController.getStationById);

// ============================================================
// ADMIN-PROTECTED ROUTES (require admin JWT token)
// ============================================================
router.post("/", adminAuth, stationController.createStation);
router.put("/:id", adminAuth, stationController.updateStation);
router.delete("/:id", adminAuth, stationController.deleteStation);
router.patch("/:id/toggle-status", adminAuth, stationController.toggleStationStatus);

module.exports = router;