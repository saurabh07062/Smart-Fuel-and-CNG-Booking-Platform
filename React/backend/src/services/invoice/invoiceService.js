/**
 * Refuelling invoices (TAX INVOICE / BILL OF SUPPLY).
 *
 *   ensureInvoice(bookingId)  issue the invoice for a completed booking, once
 *   verifyInvoice(code)       public genuineness check, no personal data
 *
 * Tax treatment (confirmed for the approved template):
 *   - Petrol, High Speed Diesel and CNG are outside GST: the fuel line carries
 *     no CGST/SGST; its price already includes State VAT.
 *   - The booking convenience fee (config/booking.js CONVENIENCE_FEE) is a
 *     service taxed at 18%, shown inclusive: taxable + 9% CGST + 9% SGST.
 * The invoice total always equals the booking's stored amount.
 *
 * Numbering: FM/<station code>/<financial year>/<6-digit running number>, one
 * sequence per station per Indian financial year (April-March), from an atomic
 * counter (models/Counter.js).
 */

const crypto = require("crypto");
const Booking = require("../../models/Booking");
const Station = require("../../models/Station");
const User = require("../../models/User");
const Invoice = require("../../models/Invoice");
const Counter = require("../../models/Counter");
const { CONVENIENCE_FEE } = require("../../config/booking");
const { dateKey } = require("../../config/businessTime");
const { normaliseFuel } = require("../../config/fuels");

const HSN = { petrol: "27101241", diesel: "27101943", cng: "27112100" };
const FUEL_NAME = { petrol: "Petrol (MS)", diesel: "High Speed Diesel (HSD)", cng: "CNG" };
const FUEL_UNIT = { petrol: "L", diesel: "L", cng: "kg" };
const FEE_SAC = "998599";
const FEE_GST_RATE = 18;

const GST_STATES = {
  "01": "JAMMU AND KASHMIR", "02": "HIMACHAL PRADESH", "03": "PUNJAB", "04": "CHANDIGARH", "05": "UTTARAKHAND",
  "06": "HARYANA", "07": "DELHI", "08": "RAJASTHAN", "09": "UTTAR PRADESH", "10": "BIHAR", "11": "SIKKIM",
  "12": "ARUNACHAL PRADESH", "13": "NAGALAND", "14": "MANIPUR", "15": "MIZORAM", "16": "TRIPURA", "17": "MEGHALAYA",
  "18": "ASSAM", "19": "WEST BENGAL", "20": "JHARKHAND", "21": "ODISHA", "22": "CHHATTISGARH", "23": "MADHYA PRADESH",
  "24": "GUJARAT", "26": "DADRA AND NAGAR HAVELI AND DAMAN AND DIU", "27": "MAHARASHTRA", "29": "KARNATAKA",
  "30": "GOA", "31": "LAKSHADWEEP", "32": "KERALA", "33": "TAMIL NADU", "34": "PUDUCHERRY",
  "35": "ANDAMAN AND NICOBAR ISLANDS", "36": "TELANGANA", "37": "ANDHRA PRADESH", "38": "LADAKH",
};
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** A valid 15-character GSTIN (uppercased), or null. */
function normaliseGstin(value) {
  const g = String(value || "").trim().toUpperCase();
  return GSTIN_RE.test(g) ? g : null;
}

/** "2026-27" for any date from 1 Apr 2026 to 31 Mar 2027 (India date). */
function financialYear(date = new Date()) {
  const [y, m] = dateKey(date).split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** A fee inclusive of 18% GST split into taxable + CGST + SGST that add back up exactly. */
function splitInclusiveFee(fee) {
  const total = round2(fee);
  const taxable = round2(total / (1 + FEE_GST_RATE / 100));
  const gst = round2(total - taxable);
  const cgst = round2(gst / 2);
  const sgst = round2(gst - cgst);
  return { total, taxable, cgst, sgst };
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function words99(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
}
function words999(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? words99(r) : ""].filter(Boolean).join(" ");
}
/** Indian numbering: 451.08 -> "Indian Rupees Four Hundred Fifty-One and Eight Paise Only". */
function amountInWords(amount) {
  const rupees = Math.floor(round2(amount));
  const paise = Math.round((round2(amount) - rupees) * 100);
  const parts = [];
  let r = rupees;
  const crore = Math.floor(r / 1e7); r %= 1e7;
  const lakh = Math.floor(r / 1e5); r %= 1e5;
  const thousand = Math.floor(r / 1e3); r %= 1e3;
  if (crore) parts.push(`${words999(crore)} Crore`);
  if (lakh) parts.push(`${words99(lakh)} Lakh`);
  if (thousand) parts.push(`${words99(thousand)} Thousand`);
  if (r) parts.push(words999(r));
  const rupeeText = parts.length ? parts.join(" ") : "Zero";
  return `Indian Rupees ${rupeeText}${paise ? ` and ${words99(paise)} Paise` : ""} Only`;
}

/** Deterministic, unguessable verification code for an invoice. */
function makeVerifyCode(invoiceNo, bookingId, amount) {
  const secret = process.env.JWT_SECRET || "fuelmart-invoice";
  const digest = crypto.createHmac("sha256", secret).update(`${invoiceNo}|${bookingId}|${round2(amount)}`).digest();
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += alphabet[digest[i] % alphabet.length];
  return `FM-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

const maskPhone = (p) => {
  const d = String(p || "").replace(/\D/g, "");
  return d.length >= 4 ? `+91 ••••••${d.slice(-4)}` : null;
};
const maskId = (id) => {
  const s = String(id || "");
  return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
};

/** Build the printed snapshot for a completed booking. */
async function buildInvoiceData(booking, { invoiceNo, verifyCode, issuedAt }) {
  const [station, customer] = await Promise.all([
    Station.findById(booking.station).select("name address owner").lean(),
    User.findById(booking.user).select("name phone").lean(),
  ]);
  const vendor = station?.owner
    ? await User.findById(station.owner).select("name businessName gstNumber vendorCode vendorAddress signatureImage").lean()
    : null;

  const fuel = normaliseFuel(booking.fuelType) || "petrol";
  const fee = splitInclusiveFee(Number(booking.taxes ?? CONVENIENCE_FEE) || 0);
  const amount = round2(booking.amount);
  const fuelValue = round2(amount - fee.total);
  const qty = Number(booking.quantity);
  const gstin = normaliseGstin(vendor?.gstNumber);

  const start = booking.fuelingStartTime ? new Date(booking.fuelingStartTime) : null;
  const end = booking.completionTime ? new Date(booking.completionTime) : null;

  return {
    invoiceNo,
    verifyCode,
    issuedAt,
    bookingRef: booking.orderId || `FM-${String(booking._id).slice(-8).toUpperCase()}`,
    bookingId: String(booking._id),
    seller: {
      stationName: station?.name?.trim() || booking.stationName || "Fuel Station",
      businessName: vendor?.businessName?.trim() || null,
      address: station?.address?.trim() || vendor?.vendorAddress || "",
      gstin,
      vendorCode: vendor?.vendorCode || null,
      placeOfSupply: gstin ? `${GST_STATES[gstin.slice(0, 2)] || "INDIA"} (${gstin.slice(0, 2)})` : null,
      signatureImage: vendor?.signatureImage || null,
    },
    customer: {
      name: customer?.name || booking.userName || "Customer",
      id: maskId(booking.user),
      phone: maskPhone(customer?.phone),
    },
    vehicle: { plate: booking.vehiclePlate || null, name: booking.vehicleName || null },
    lines: [
      {
        sr: 1,
        name: FUEL_NAME[fuel],
        description: [`Dispensed at pump, ${qty.toFixed(2)} ${FUEL_UNIT[fuel]}`, "Price incl. State VAT"],
        hsn: HSN[fuel],
        qty: `${qty.toFixed(2)} ${FUEL_UNIT[fuel]}`,
        rate: round2(booking.price),
        taxable: fuelValue,
        cgstRate: null,
        cgst: 0,
        sgstRate: null,
        sgst: 0,
        cess: 0,
        total: fuelValue,
      },
      ...(fee.total > 0
        ? [{
            sr: 2,
            name: "Booking convenience fee",
            description: ["FuelMart slot booking"],
            hsn: FEE_SAC,
            qty: "1",
            rate: fee.taxable,
            taxable: fee.taxable,
            cgstRate: FEE_GST_RATE / 2,
            cgst: fee.cgst,
            sgstRate: FEE_GST_RATE / 2,
            sgst: fee.sgst,
            cess: 0,
            total: fee.total,
          }]
        : []),
    ],
    totals: {
      taxable: round2(fuelValue + fee.taxable),
      cgst: fee.cgst,
      sgst: fee.sgst,
      cess: 0,
      total: amount,
    },
    amountInWords: amountInWords(amount),
    fuel: { key: fuel, label: booking.fuelType },
    refuelling: {
      start: start?.toISOString() || null,
      end: end?.toISOString() || null,
      seconds: start && end ? Math.max(0, Math.round((end - start) / 1000)) : null,
    },
    payMethod: booking.payMethod,
  };
}

/**
 * The invoice for a booking, issuing it the first time. Only a completed
 * booking has one (null otherwise). Safe to call repeatedly and concurrently:
 * the booking is unique on Invoice, so a racing second issue reads the first.
 */
async function ensureInvoice(bookingId) {
  const existing = await Invoice.findOne({ booking: bookingId }).lean();
  if (existing) return existing;

  const booking = await Booking.findById(bookingId).lean();
  if (!booking || booking.status !== "completed" || !booking.station) return null;

  const issuedAt = booking.completionTime ? new Date(booking.completionTime) : new Date();
  const fy = financialYear(issuedAt);
  const seq = await Counter.next(`invoice:${booking.station}:${fy}`);
  const invoiceNo = `FM/${String(booking.station).slice(-6).toUpperCase()}/${fy}/${String(seq).padStart(6, "0")}`;
  const verifyCode = makeVerifyCode(invoiceNo, booking._id, booking.amount);
  const data = await buildInvoiceData(booking, { invoiceNo, verifyCode, issuedAt: issuedAt.toISOString() });

  try {
    const created = await Invoice.create({
      booking: booking._id,
      station: booking.station,
      user: booking.user,
      invoiceNo,
      verifyCode,
      financialYear: fy,
      issuedAt,
      amount: round2(booking.amount),
      data,
    });
    await Booking.updateOne({ _id: booking._id }, { $set: { invoiceUrl: `/api/invoices/${booking._id}` } });
    return created.toObject();
  } catch (err) {
    if (err.code === 11000) {
      const winner = await Invoice.findOne({ booking: bookingId }).lean();
      if (winner) return winner;
    }
    throw err;
  }
}

/** Genuineness check for anyone holding the printed code. No customer data. */
async function verifyInvoice(code) {
  const inv = await Invoice.findOne({ verifyCode: String(code || "").trim().toUpperCase() }).lean();
  if (!inv) return null;
  return {
    valid: true,
    invoiceNo: inv.invoiceNo,
    issuedAt: inv.issuedAt,
    amount: inv.amount,
    station: inv.data?.seller?.stationName || null,
  };
}

module.exports = {
  ensureInvoice,
  verifyInvoice,
  buildInvoiceData,
  amountInWords,
  splitInclusiveFee,
  financialYear,
  normaliseGstin,
  makeVerifyCode,
};
