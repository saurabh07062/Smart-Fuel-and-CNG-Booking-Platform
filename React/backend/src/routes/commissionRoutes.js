const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const commissionService = require("../services/commission/commissionService");
const settlementJob = require("../services/commission/settlementJob");
const { dateKey } = require("../config/businessTime");

/**
 * Commission and settlement over HTTP.
 *
 *   GET  /api/v1/commission/vendor              the signed-in vendor's position
 *   GET  /api/v1/commission/vendor/entries      their per-booking history
 *   GET  /api/v1/commission/vendor/settlements  their settlement history
 *
 *   GET  /api/v1/commission/admin               what FuelMart is owed and has collected
 *   GET  /api/v1/commission/admin/settlements   every vendor's settlements
 *   POST /api/v1/commission/admin/settlements/:id/confirm   record the money as received
 *   POST /api/v1/commission/admin/run           settle a day now, rather than waiting
 *
 * WHOSE FIGURES
 *
 * A vendor's endpoints read `req.user.id` and nothing else -- there is no way
 * to ask for another vendor's commission, because no screen needs one and the
 * id would be the only thing standing between the two.
 */

/* ───────────────────────────── vendor ───────────────────────────── */

router.get("/vendor", auth, requireRole("vendor"), async (req, res) => {
  try {
    res.json({ success: true, ...(await commissionService.summaryForVendor(req.user.id)) });
  } catch (err) {
    console.error("[commission] vendor summary failed:", err.message);
    res.status(500).json({ success: false, msg: "Could not load your commission." });
  }
});

router.get("/vendor/entries", auth, requireRole("vendor"), async (req, res) => {
  try {
    const { entries, total } = await commissionService.entriesForVendor(req.user.id, {
      limit: req.query.limit,
      skip: req.query.skip,
      status: typeof req.query.status === "string" ? req.query.status : null,
    });
    res.json({ success: true, entries, total });
  } catch (err) {
    console.error("[commission] vendor entries failed:", err.message);
    res.status(500).json({ success: false, msg: "Could not load your commission history." });
  }
});

router.get("/vendor/settlements", auth, requireRole("vendor"), async (req, res) => {
  try {
    const { settlements, total } = await commissionService.settlements({
      vendorId: req.user.id,
      limit: req.query.limit,
      skip: req.query.skip,
    });
    res.json({ success: true, settlements, total });
  } catch (err) {
    console.error("[commission] vendor settlements failed:", err.message);
    res.status(500).json({ success: false, msg: "Could not load your settlements." });
  }
});

/* ───────────────────────────── admin ───────────────────────────── */

router.get("/admin", auth, requireRole("admin"), async (req, res) => {
  try {
    res.json({ success: true, ...(await commissionService.adminSummary()) });
  } catch (err) {
    console.error("[commission] admin summary failed:", err.message);
    res.status(500).json({ success: false, msg: "Could not load the commission summary." });
  }
});

router.get("/admin/settlements", auth, requireRole("admin"), async (req, res) => {
  try {
    const { settlements, total } = await commissionService.settlements({
      limit: req.query.limit,
      skip: req.query.skip,
      status: typeof req.query.status === "string" ? req.query.status : null,
    });
    res.json({ success: true, settlements, total });
  } catch (err) {
    console.error("[commission] admin settlements failed:", err.message);
    res.status(500).json({ success: false, msg: "Could not load settlements." });
  }
});

/**
 * Record that a settlement's money actually arrived.
 *
 * This is the confirmation the whole flow waits for: until an admin (or a
 * payout provider) says the transfer happened, the settlement sits as
 * "awaiting confirmation" and its entries stay pending. Nothing about a
 * schedule firing moves money.
 */
router.post("/admin/settlements/:id/confirm", auth, requireRole("admin"), async (req, res) => {
  try {
    const result = await commissionService.confirmSettlement({
      settlementId: req.params.id,
      adminId: req.user.id,
      transferRef: req.body?.transferRef ?? null,
    });
    res.json({
      success: true,
      alreadySettled: result.alreadySettled,
      settlement: commissionService.publicSettlement(result.settlement),
      msg: result.alreadySettled ? "That settlement was already recorded as received." : "Settlement recorded as received.",
    });
  } catch (err) {
    if (err instanceof commissionService.CommissionError) {
      return res.status(err.status).json({ success: false, reason: err.reason, msg: err.message });
    }
    console.error("[commission] confirming a settlement failed:", err.message);
    res.status(500).json({ success: false, msg: "Could not record the settlement." });
  }
});

/**
 * Settle a day now instead of waiting for the scheduled time.
 *
 * Harmless to press twice: a vendor who already has a settlement for that day
 * is skipped by the unique index, not paid again.
 */
router.post("/admin/run", auth, requireRole("admin"), async (req, res) => {
  const day = typeof req.body?.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.day) ? req.body.day : dateKey();
  try {
    const result = await settlementJob.runOnce(day);
    if (!result) return res.status(409).json({ success: false, msg: "A settlement run is already in progress." });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[commission] manual settlement run failed:", err.message);
    res.status(500).json({ success: false, msg: "The settlement run failed." });
  }
});

module.exports = router;
