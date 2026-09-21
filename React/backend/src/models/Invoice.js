const mongoose = require("mongoose");

/**
 * A tax invoice / bill of supply for one completed booking.
 *
 * Issued once, when refuelling completes (services/invoice/invoiceService.js),
 * and never recalculated: `data` is the snapshot printed on the invoice --
 * seller, customer, lines, tax split, refuelling times -- so a later price,
 * address or name change cannot alter an invoice already issued. The payment
 * tile is the one live part (a pump payment may be recorded after the fill).
 */
const InvoiceSchema = new mongoose.Schema(
  {
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, unique: true },
    station: { type: mongoose.Schema.Types.ObjectId, ref: "Station", required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    invoiceNo: { type: String, required: true, unique: true },
    // Public check that an invoice is genuine (GET /api/invoices/verify/:code).
    verifyCode: { type: String, required: true, unique: true },
    financialYear: { type: String, required: true },
    issuedAt: { type: Date, required: true },
    amount: { type: Number, required: true },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Invoice", InvoiceSchema);
