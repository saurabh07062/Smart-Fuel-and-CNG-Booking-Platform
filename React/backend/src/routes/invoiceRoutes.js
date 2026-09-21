/**
 * Refuelling invoices.
 *
 *   GET /api/invoices/verify/:code   public: is this invoice genuine? (no personal data)
 *   GET /api/invoices/:bookingId     the invoice page (approved template, A4, print to PDF)
 *        ?print=1   open the browser's print dialog on load ("Save as PDF")
 *        ?format=json   the invoice data instead of the page
 *
 * Only the booking's customer, the station's owner, or an admin may open an
 * invoice; anyone else gets 404, the same as a booking that does not exist.
 * An invoice exists only for a completed booking (409 otherwise). It is issued
 * at completion (services/booking/bookingCompletion.js) and, as a fallback,
 * the first time it is opened.
 */

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const Booking = require("../models/Booking");
const Station = require("../models/Station");
const invoiceService = require("../services/invoice/invoiceService");
const { renderInvoiceHtml } = require("../services/invoice/invoiceTemplate");

const router = express.Router();

router.get("/verify/:code", async (req, res) => {
  try {
    const result = await invoiceService.verifyInvoice(req.params.code);
    if (!result) return res.status(404).json({ valid: false, msg: "No invoice matches this code." });
    res.json(result);
  } catch (err) {
    console.error("[invoice] verify failed:", err.message);
    res.status(500).json({ msg: "Could not verify the invoice." });
  }
});

router.get("/:bookingId", auth, async (req, res) => {
  try {
    const { bookingId } = req.params;
    if (!mongoose.isValidObjectId(bookingId)) return res.status(404).json({ msg: "Invoice not found" });

    const booking = await Booking.findById(bookingId).select("user station status paymentStatus payMethod collectedAt").lean();
    if (!booking) return res.status(404).json({ msg: "Invoice not found" });

    const isAdmin = req.user.role === "admin";
    const isCustomer = String(booking.user) === String(req.user.id);
    let isOwner = false;
    if (!isAdmin && !isCustomer && req.user.role === "vendor" && booking.station) {
      isOwner = Boolean(await Station.exists({ _id: booking.station, owner: req.user.id }));
    }
    if (!isAdmin && !isCustomer && !isOwner) return res.status(404).json({ msg: "Invoice not found" });

    if (booking.status !== "completed") {
      return res.status(409).json({ msg: "The invoice is issued when refuelling is completed.", reason: "NOT_COMPLETED" });
    }

    const invoice = await invoiceService.ensureInvoice(bookingId);
    if (!invoice) return res.status(409).json({ msg: "The invoice could not be issued yet.", reason: "NOT_COMPLETED" });

    const live = { paymentStatus: booking.paymentStatus, payMethod: booking.payMethod, collectedAt: booking.collectedAt };
    if (req.query.format === "json") {
      return res.json({ invoiceNo: invoice.invoiceNo, verifyCode: invoice.verifyCode, issuedAt: invoice.issuedAt, amount: invoice.amount, data: invoice.data, payment: live });
    }

    // The page's one script (print) runs under a nonce; nothing else may.
    const nonce = crypto.randomBytes(16).toString("base64");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data:",
        "base-uri 'none'",
        "frame-ancestors 'self'",
      ].join("; "),
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.type("html").send(
      renderInvoiceHtml(invoice, live, {
        nonce,
        autoPrint: req.query.print === "1",
        supportEmail: process.env.SUPPORT_EMAIL || null,
      }),
    );
  } catch (err) {
    console.error("[invoice] could not render:", err.message);
    res.status(500).json({ msg: "Could not load the invoice." });
  }
});

module.exports = router;
