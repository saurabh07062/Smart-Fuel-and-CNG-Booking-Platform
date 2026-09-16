/**
 * UPI payment intent links.
 *
 * A *dynamic* QR — one that already carries the exact amount — is worth the
 * small amount of work here. A static payee QR makes the customer type the
 * amount themselves at the pump, which is slow and is where wrong-amount
 * disputes come from. Encoding `am` means they scan, see 101.72, and approve.
 *
 * Format (NPCI UPI Linking Specification):
 *
 *   upi://pay?pa=<vpa>&pn=<payee>&am=<amount>&cu=INR&tn=<note>&tr=<ref>
 *
 *   pa  payee address (VPA)     required
 *   pn  payee name              required — shown in the payer's app
 *   am  amount, 2 decimals      omit for a static "enter any amount" QR
 *   cu  currency                INR only
 *   tn  transaction note        free text, shown to the payer
 *   tr  transaction reference   our id for reconciliation
 *
 * Every value must be percent-encoded. An unencoded `&` inside a payee name
 * silently truncates the rest of the link, which is the classic UPI QR bug.
 */

// user@bank. The user part allows dots, hyphens and underscores and may be a
// single character; bank handles are alphabetic-initial and never 1 char.
// Deliberately permissive on the user part — rejecting a legitimate VPA is a
// worse failure than accepting one the bank will reject anyway.
const VPA_RE = /^[a-zA-Z0-9.\-_]{1,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/;

function isValidVpa(vpa) {
  return typeof vpa === "string" && VPA_RE.test(vpa.trim());
}

/**
 * `tr` and `tn` are echoed by banks into statements and some apps reject
 * punctuation, so keep them conservative: alphanumerics, space, hyphen.
 */
function sanitiseRef(value, maxLen = 35) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, maxLen);
}

function sanitiseNote(value, maxLen = 50) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9 \-.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/**
 * Build a UPI intent URI.
 *
 * @param {object} o
 * @param {string} o.vpa        payee UPI id (required)
 * @param {string} o.payeeName  shown in the payer's app (required)
 * @param {number} [o.amount]   rupees; omitted -> static any-amount QR
 * @param {string} [o.note]     transaction note
 * @param {string} [o.ref]      transaction reference
 * @returns {{uri:string}|{error:string}}
 */
function buildUpiUri({ vpa, payeeName, amount, note, ref }) {
  const pa = String(vpa || "").trim();
  if (!isValidVpa(pa)) {
    return { error: `"${pa || "(empty)"}" is not a valid UPI ID. Expected something like name@bank.` };
  }

  const pn = sanitiseNote(payeeName || "Merchant", 40);
  if (!pn) return { error: "Payee name is required" };

  const params = [
    ["pa", pa],
    ["pn", pn],
    ["cu", "INR"],
  ];

  if (amount !== undefined && amount !== null && amount !== "") {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return { error: "Amount must be a positive number" };
    }
    // UPI expects at most 2 decimals. toFixed also fixes the float artefacts
    // that bite the Razorpay path (4775.4 -> "4775.40", never "4775.3999…").
    params.push(["am", amt.toFixed(2)]);
  }

  const tn = sanitiseNote(note);
  if (tn) params.push(["tn", tn]);

  const tr = sanitiseRef(ref);
  if (tr) params.push(["tr", tr]);

  const query = params
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

  return { uri: `upi://pay?${query}` };
}

/**
 * Resolve which UPI id to charge for a station.
 *
 * Per-station first (each vendor is paid directly), then a platform-wide
 * fallback from the environment so a station that has not configured one
 * still works.
 */
function resolvePayee(station) {
  const stationVpa = station?.upiId?.trim();
  if (isValidVpa(stationVpa)) {
    return {
      vpa: stationVpa,
      payeeName: station.upiName || station.name || "FuelMart",
      source: "station",
    };
  }

  const envVpa = process.env.UPI_ID?.trim();
  if (isValidVpa(envVpa)) {
    return {
      vpa: envVpa,
      payeeName: process.env.UPI_PAYEE_NAME || "FuelMart",
      source: "platform",
    };
  }

  return null;
}

/**
 * Render a UPI URI as a PNG data URI, server-side.
 *
 * The client used to draw this from a CDN-hosted QR library. When that CDN is
 * blocked, slow, or offline the library is simply absent and the customer gets
 * a blank white box at the pump with no way to pay. Rendering here removes the
 * third-party dependency from the critical path entirely — ~2.6KB of base64 is
 * cheap next to a payment that cannot happen.
 */
async function toQrDataUri(uri, size = 220) {
  if (!uri) return null;
  try {
    const QRCode = require("qrcode");
    return await QRCode.toDataURL(uri, {
      width: size,
      margin: 1,
      // M tolerates camera glare and a centre logo overlay.
      errorCorrectionLevel: "M",
      color: { dark: "#0F172A", light: "#FFFFFF" },
    });
  } catch (err) {
    console.error("[upi] QR render failed:", err.message);
    return null;
  }
}

/** The full payload the UI needs to render a scannable QR for one booking. */
async function buildBookingPayment(booking, station) {
  const payee = resolvePayee(station);
  if (!payee) {
    return {
      error:
        "No UPI ID configured for this station. The vendor can add one in Inventory & pricing, or set UPI_ID in backend/.env.",
    };
  }

  const built = buildUpiUri({
    vpa: payee.vpa,
    payeeName: payee.payeeName,
    amount: booking.amount,
    note: `FuelMart ${booking.verificationCode || ""}`.trim(),
    ref: booking.verificationCode || String(booking._id || ""),
  });

  if (built.error) return { error: built.error };

  return {
    uri: built.uri,
    // Pre-rendered so the client needs no QR library at all.
    qrDataUri: await toQrDataUri(built.uri),
    vpa: payee.vpa,
    payeeName: payee.payeeName,
    amount: booking.amount,
    currency: "INR",
    reference: sanitiseRef(booking.verificationCode || String(booking._id || "")),
    source: payee.source,
  };
}

module.exports = {
  isValidVpa,
  toQrDataUri,
  buildUpiUri,
  resolvePayee,
  buildBookingPayment,
  sanitiseRef,
  sanitiseNote,
  VPA_RE,
};
