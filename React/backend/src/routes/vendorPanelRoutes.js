const express = require("express");
const router = express.Router();
const vendorPanelController = require("../controllers/vendorPanelController");
const { uploadImage, uploadImages } = require("../middleware/upload");
const vendorAuth = require("../middleware/vendor");

// ============================================================
// DASHBOARD
// ============================================================
router.get("/dashboard", vendorAuth, vendorPanelController.getDashboard);

// ============================================================
// MY PETROL PUMPS
// ============================================================
router.get("/stations", vendorAuth, vendorPanelController.getMyStations);
// Station photos. Multer field: "stationImages" (up to 5). Station.images
// already existed as [String] and the admin station list already renders
// images[0] -- it was only ever settable by pasting a URL.
router.post(
  "/stations",
  vendorAuth,
  uploadImages("stations", "stationImages", 5),
  vendorPanelController.createStation,
);
router.put(
  "/stations/:id",
  vendorAuth,
  uploadImages("stations", "stationImages", 5),
  vendorPanelController.updateStation,
);
router.delete("/stations/:id", vendorAuth, vendorPanelController.deleteStation);
router.patch("/stations/:id/toggle-status", vendorAuth, vendorPanelController.toggleStationStatus);

// ============================================================
// FUEL PRICE MANAGEMENT
// ============================================================
router.put("/stations/:id/price", vendorAuth, vendorPanelController.updateFuelPrice);
router.get("/stations/:id/price-history", vendorAuth, vendorPanelController.getPriceHistory);

// ============================================================
// DEMAND FORECAST & REORDER PLANNING
// ============================================================
router.get("/stations/:id/forecast", vendorAuth, vendorPanelController.getForecast);

// ============================================================
// QUEUE MANAGEMENT
// ============================================================
router.get("/stations/:id/queue", vendorAuth, vendorPanelController.getQueueStatus);
router.put("/stations/:id/queue", vendorAuth, vendorPanelController.updateQueueStatus);
router.patch("/stations/:id/queue/close", vendorAuth, vendorPanelController.closeQueue);
// Walk-in vehicles in a fuel's line (services/queue/walkIns.js).
router.get("/stations/:id/walk-ins", vendorAuth, vendorPanelController.getWalkIns);
router.post("/stations/:id/walk-ins", vendorAuth, vendorPanelController.addWalkIn);
router.patch("/stations/:id/walk-ins/:walkInId", vendorAuth, vendorPanelController.updateWalkIn);

// ============================================================
// BOOKING MANAGEMENT
// ============================================================
router.get("/stations/:id/bookings", vendorAuth, vendorPanelController.getStationBookings);
router.patch("/stations/:stationId/bookings/:bookingId/status", vendorAuth, vendorPanelController.updateBookingStatus);
// The attendant received a pay-at-the-pump payment (recorded once).
router.patch("/stations/:stationId/bookings/:bookingId/collect", vendorAuth, vendorPanelController.collectBookingPayment);

// ============================================================
// INVENTORY MANAGEMENT
// ============================================================
router.put("/stations/:id/inventory", vendorAuth, vendorPanelController.updateInventory);
router.get("/stations/:id/inventory/movements", vendorAuth, vendorPanelController.getInventoryMovements);
router.get("/inventory/alerts", vendorAuth, vendorPanelController.getInventoryAlerts);

// ============================================================
// REVENUE
// ============================================================
router.get("/revenue", vendorAuth, vendorPanelController.getRevenue);

// ============================================================
// EMPLOYEES
// ============================================================
router.get("/employees", vendorAuth, vendorPanelController.getEmployees);
router.post("/employees", vendorAuth, vendorPanelController.addEmployee);
router.put("/employees/:id", vendorAuth, vendorPanelController.updateEmployee);
router.delete("/employees/:id", vendorAuth, vendorPanelController.deleteEmployee);

// ============================================================
// REVIEWS
// ============================================================
router.get("/reviews", vendorAuth, vendorPanelController.getReviews);

// ============================================================
// CUSTOMERS
// ============================================================
router.get("/customers", vendorAuth, vendorPanelController.getCustomers);

// ============================================================
// REPORTS
// ============================================================
router.get("/reports", vendorAuth, vendorPanelController.getReports);

// ============================================================
// PROFILE & SETTINGS
// ============================================================
router.get("/profile", vendorAuth, vendorPanelController.getProfile);
// Vendor profile photo. Multer field: "vendorImage".
router.put(
  "/profile",
  vendorAuth,
  uploadImage("vendors", "vendorImage"),
  vendorPanelController.updateProfile,
);

module.exports = router;