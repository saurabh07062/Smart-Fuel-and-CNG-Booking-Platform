/**
 * How a booking's payment reads on screen, from its real fields. The server
 * decides the payment state (backend/src/services/payment/*); this only names it.
 */

export type PaymentTone = "good" | "warn" | "bad" | "muted";

interface PaymentFields {
  _id?: string;
  orderId?: string;
  status?: string;
  paymentStatus?: string;
  payMethod?: string;
  /** How a pay-at-the-pump payment was collected. */
  collectionMethod?: "cash" | "upi" | null;
  /** Set when the car checked in at the pump. */
  arrivalTime?: string | null;
}

const ENDED_WITHOUT_SERVICE = ["cancelled", "expired", "no_show"];

export function paymentState(b: PaymentFields): { label: string; tone: PaymentTone } {
  switch (b.paymentStatus) {
    case "paid":
      if (b.payMethod === "online") return { label: "Paid online", tone: "good" };
      if (b.collectionMethod === "cash") return { label: "Paid at pump · Cash", tone: "good" };
      if (b.collectionMethod === "upi") return { label: "Paid at pump · UPI", tone: "good" };
      return { label: "Paid at pump", tone: "good" };
    case "refunded":
      return { label: "Refunded", tone: "muted" };
    case "failed":
      return { label: "Payment failed", tone: "bad" };
    default:
      break;
  }
  if (ENDED_WITHOUT_SERVICE.includes(String(b.status))) return { label: "Not charged", tone: "muted" };
  if (b.paymentStatus === "due_at_station") return { label: "Due at pump", tone: "warn" };
  if (b.paymentStatus === "pending") return { label: "Payment pending", tone: "warn" };
  return { label: "—", tone: "muted" };
}

/** The payment is owed at the pump and can be collected now: the car is at the pump (checked in), being fuelled, or done. */
export function canCollectAtPump(b: PaymentFields): boolean {
  if (b.payMethod !== "station" || b.paymentStatus !== "due_at_station") return false;
  if (["serving", "completed"].includes(String(b.status))) return true;
  return b.status === "upcoming" && !!b.arrivalTime;
}

/** A short, stable reference for a booking: its order id, else the end of its database id. */
export function bookingRef(b: PaymentFields): string {
  if (b.orderId) return b.orderId;
  return `#${String(b._id ?? "").slice(-8).toUpperCase()}`;
}

export const PAYMENT_TONE_COLOR: Record<PaymentTone, string> = {
  good: "var(--success, #15803d)",
  warn: "var(--status-warn, #b45309)",
  bad: "var(--danger, #b91c1c)",
  muted: "var(--muted, #64748b)",
};
