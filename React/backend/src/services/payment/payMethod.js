/**
 * Payment-method vocabulary.
 *
 * The system stores exactly two payment methods, because only two behaviours
 * exist downstream:
 *
 *   'online'   settles before the pump (gateway confirms, then we serve)
 *   'station'  settles at the pump (attendant collects, serving IS payment)
 *
 * Clients speak a much larger vocabulary than that. The legacy frontend sends
 * `wallet`, `card`, `uppi` (sic) and `cod`; the new customer app sends `online`
 * and `station`. Rather than widening the enum until it means nothing, every
 * inbound value is normalised here, and the raw label is kept separately for
 * display so nothing is actually lost.
 *
 * This module is the single source of truth for that mapping — the Booking
 * schema wires it in as a setter, so no write path can bypass it.
 */

/** Everything that means "pay at the pump". */
const STATION_ALIASES = new Set([
  "station",
  "cod",
  "cash",
  "cash_on_delivery",
  "cashondelivery",
  "pay_at_station",
  "payatstation",
  "pod",
  "offline",
]);

/** Everything that means "pay before arriving". */
const ONLINE_ALIASES = new Set([
  "online",
  "wallet",
  "card",
  "credit",
  "debit",
  "creditcard",
  "debitcard",
  "upi",
  "uppi", // legacy frontend typo — kept deliberately, it is in shipped code
  "gpay",
  "googlepay",
  "phonepe",
  "paytm",
  "netbanking",
  "razorpay",
]);

/**
 * Map any client value onto 'online' | 'station'.
 *
 * Unknown values become 'station'. That is the safe direction: the worst case
 * is a customer who intended to pay online is asked for money at the pump,
 * versus being marked paid when nothing was collected.
 */
function normalisePayMethod(value) {
  if (value === undefined || value === null) return "station";

  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (ONLINE_ALIASES.has(key)) return "online";
  if (STATION_ALIASES.has(key)) return "station";

  // Also catch the underscore-free spellings of the multiword aliases.
  const compact = key.replace(/_/g, "");
  if (ONLINE_ALIASES.has(compact)) return "online";
  if (STATION_ALIASES.has(compact)) return "station";

  return "station";
}

/** Is this value one we actually recognise, or are we falling back? */
function isKnownPayMethod(value) {
  if (value === undefined || value === null) return false;
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  const compact = key.replace(/_/g, "");
  return (
    ONLINE_ALIASES.has(key) ||
    STATION_ALIASES.has(key) ||
    ONLINE_ALIASES.has(compact) ||
    STATION_ALIASES.has(compact)
  );
}

/** The payment status a fresh booking should start in. */
function initialPaymentStatus(method) {
  return normalisePayMethod(method) === "online" ? "pending" : "due_at_station";
}

/** Human label for the raw choice, for receipts and the vendor queue. */
const LABELS = {
  wallet: "FuelMart Wallet",
  card: "Credit/Debit Card",
  credit: "Credit Card",
  debit: "Debit Card",
  upi: "UPI",
  uppi: "UPI",
  gpay: "Google Pay",
  googlepay: "Google Pay",
  phonepe: "PhonePe",
  paytm: "Paytm",
  netbanking: "Net Banking",
  razorpay: "Razorpay",
  online: "Paid online",
  cod: "Cash at station",
  cash: "Cash at station",
  station: "Pay at station",
};

function payMethodLabel(raw) {
  if (!raw) return LABELS.station;
  const key = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
  return LABELS[key] || LABELS[key.replace(/_/g, "")] || LABELS[normalisePayMethod(raw)];
}

module.exports = {
  PAY_METHODS: ["online", "station"],
  normalisePayMethod,
  isKnownPayMethod,
  initialPaymentStatus,
  payMethodLabel,
  STATION_ALIASES,
  ONLINE_ALIASES,
};
