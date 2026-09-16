const express = require("express");
const router = express.Router();
const vendorController = require("../controllers/vendorController");
// Centralised upload middleware (middleware/upload.js). Replaces the old
// services/upload.js, which wrote every vendor file into uploads/vendors
// whatever it was and stored only a bare filename the client could not use.
const { uploadFields } = require("../middleware/upload");
const adminAuth = require("../middleware/admin");

// ============================================================
// VENDOR MANAGEMENT ROUTES (Admin-protected)
// ============================================================

// Dashboard stats - all metrics in one call
router.get("/dashboard", adminAuth, vendorController.getDashboardStats);

// Vendor status counts (quick summary)
router.get("/status-counts", adminAuth, vendorController.getVendorStatusCounts);

// Get all vendors (with optional ?status= and ?search= filters)
router.get("/", adminAuth, vendorController.getAllVendors);

// Get single vendor by ID (with stations & bookings)
router.get("/:id", adminAuth, vendorController.getVendorById);

// Mark a pending application as under review
router.patch("/:id/under-review", adminAuth, vendorController.markUnderReview);

// Approve a pending vendor
router.patch("/:id/approve", adminAuth, vendorController.approveVendor);
// Recovery path when the approval email never reached the vendor: issues a
// fresh code and revokes the old one. Admin only.
router.post("/:id/reissue-secret-code", adminAuth, vendorController.reissueSecretCode);

// Reject a vendor
router.patch("/:id/reject", adminAuth, vendorController.rejectVendor);

// Suspend an active vendor
router.patch("/:id/suspend", adminAuth, vendorController.suspendVendor);

// Reactivate a suspended vendor
router.patch("/:id/reactivate", adminAuth, vendorController.reactivateVendor);

// Update vendor details
router.put("/:id", adminAuth, vendorController.updateVendor);

// Delete vendor (and their stations)
router.delete("/:id", adminAuth, vendorController.deleteVendor);

// ============================================================
// VENDOR REGISTRATION (public - no admin auth needed)
// Accepts multipart/form-data (files + fields). Use multer to
// populate req.files and req.body safely so controllers can
// destructure without crashing when a non-JSON request arrives.
// ============================================================
// Multer fields: "licenseFile", "gstFile", "logoFile" -- unchanged, so the
// existing onboarding form keeps working. They now land in uploads/documents
// (PDFs are accepted there and only there) and are stored as public paths.
router.post(
  "/register",
  uploadFields("documents", [
    { name: "licenseFile", maxCount: 1 },
    { name: "gstFile", maxCount: 1 },
    { name: "logoFile", maxCount: 1 },
  ]),
  vendorController.registerVendor,
);

module.exports = router;