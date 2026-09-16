/**
 * Vendor application status. Mounted at /api/activation.
 *
 * The activate endpoint that used to live here is gone. It compared a
 * PLAINTEXT `activationCode` column, had no expiry, no attempt limit and no
 * dedicated rate limit, and it granted access without issuing a session --
 * every one of which the secret-code policy now forbids. Its replacement is
 * POST /api/vendor-access/verify (routes/vendorAccessRoutes.js).
 *
 * Two competing redemption paths against the same account would be worse than
 * either alone: the weaker one sets the real security level, whatever the
 * stronger one does. So this file keeps only the read-only status endpoint,
 * and the removed route answers 410 with a pointer rather than 404, so an
 * older client gets told what happened instead of a blank wall.
 */

const express = require("express");
const router = express.Router();
const User = require("../models/User");

/**
 * GET /api/activation/vendors/:id/status
 * Powers the vendor's application-tracking page. Public, so it returns only
 * what an applicant already knows about themselves -- never the activation
 * code itself, which would defeat the point of mailing it to them.
 */
router.get("/vendors/:id/status", async (req, res) => {
  try {
    const vendor = await User.findOne({ _id: req.params.id, role: "vendor" }).select(
      "name businessName vendorCode vendorStatus activated approvedAt rejectedAt rejectionReason createdAt " +
        "secretCodeExpiresAt secretCodeUsed",
    );
    if (!vendor) return res.status(404).json({ msg: "Vendor not found" });

    res.json({
      id: vendor._id,
      name: vendor.name,
      businessName: vendor.businessName,
      vendorCode: vendor.vendorCode || null,
      vendorStatus: vendor.vendorStatus,
      activated: !!vendor.activated,
      // Whether a usable code is outstanding -- never the code itself.
      secretCodeIssued: Boolean(vendor.secretCodeExpiresAt) && !vendor.secretCodeUsed,
      secretCodeExpiresAt: vendor.secretCodeExpiresAt || null,
      approvedAt: vendor.approvedAt || null,
      rejectedAt: vendor.rejectedAt || null,
      rejectionReason: vendor.rejectionReason || null,
      appliedAt: vendor.createdAt || null,
    });
  } catch (e) {
    console.error("[Activation status] Error:", e.message);
    res.status(500).json({ msg: "Server error" });
  }
});

/**
 * POST /api/activation/vendors/:id/activate  — REMOVED.
 *
 * 410 rather than 404: this URL existed and was deliberately withdrawn, and
 * saying so is what lets a stale frontend show something useful.
 */
router.post("/vendors/:id/activate", (req, res) => {
  res.status(410).json({
    msg: "This activation endpoint has been replaced. Use the Vendor Secret Code page on the FuelMart home page.",
    replacedBy: "POST /api/vendor-access/verify",
  });
});

module.exports = router;
