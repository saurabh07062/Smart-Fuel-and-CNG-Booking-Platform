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
    financialYear: { type: String, required: true, match: require("./shared/fieldValidators").FINANCIAL_YEAR },
    issuedAt: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);

// A station's invoice book for a financial year, newest first -- what the
// vendor's and the admin's invoice lists ask for.
InvoiceSchema.index({ station: 1, financialYear: 1, issuedAt: -1 });
// A customer's own invoices.
InvoiceSchema.index({ user: 1, issuedAt: -1 });

module.exports = mongoose.model("Invoice", InvoiceSchema);
