/**
 * Formatting helpers, ported verbatim from frontend/js/utils.js.
 *
 * These produce user-visible strings, so their output is copied exactly --
 * "INR 1,234.00" (not the Intl "₹1,234.00" a rewrite would have reached for),
 * and the same status labels the Vanilla badges used.
 */

import { istDateKey, slotEndMs } from "./businessTime";

/** js/utils.js formatCurrency(). Same "INR " prefix, same thousands grouping. */
export function formatCurrency(n: number | null | undefined): string {
  const v = Number(n);
  const safe = Number.isFinite(v) ? v : 0;
  return "INR " + safe.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** js/utils.js getQueueColor(). Thresholds unchanged: <=2 good, <=5 warn, else bad. */
export function getQueueColor(q: number): string {
  return q <= 2 ? "var(--secondary)" : q <= 5 ? "var(--accent)" : "var(--danger)";
}

/** The three-way queue level the station card and detail page both key off. */
export function queueLevel(q: number): "low" | "medium" | "high" {
  return q <= 2 ? "low" : q <= 5 ? "medium" : "high";
}

export function queueLabel(q: number): string {
  return q <= 2 ? "Low queue" : q <= 5 ? "Moderate queue" : "High queue";
}

/**
 * Pill level from the server's wait-based queue status (backend
 * services/algorithms/queue.js toQueueStatus), so a pill and the wait beside it always
 * agree -- a vehicle count alone says nothing about a 40 s petrol fill versus
 * a 5 min CNG one.
 */
export function queueLevelOf(status?: string | null): "low" | "medium" | "high" {
  if (status === "High" || status === "Very High") return "high";
  if (status === "Moderate") return "medium";
  return "low";
}

export function queueLabelOf(status?: string | null): string {
  if (status === "High" || status === "Very High") return "High queue";
  if (status === "Moderate") return "Moderate queue";
  if (!status || status === "Unknown") return "Queue unknown";
  return "Low queue";
}

/**
 * Has this slot's time gone by? India time, the same rule as the server
 * (backend/config/booking.js isSlotElapsed): a label ends 30 minutes after it
 * starts, a range at its second time, and a missing date counts as elapsed --
 * the dashboard's "active bookings" filter depends on that.
 */
export function isSlotElapsed(bookingDate?: string | null, timeSlot?: string | null): boolean {
  if (!bookingDate) return true;
  const today = istDateKey();
  if (bookingDate < today) return true;
  if (bookingDate > today) return false;
  if (!timeSlot) return false;
  const end = slotEndMs(bookingDate, timeSlot);
  return end !== null && Date.now() > end;
}

/** Colour pair the dashboard/booking cards tint by fuel. Same values as dashboard.js. */
export function fuelColors(fuelType?: string): { color: string; bg: string } {
  if (fuelType === "CNG") return { color: "var(--secondary)", bg: "var(--secondary-light)" };
  if (fuelType === "Diesel") return { color: "var(--accent)", bg: "var(--accent-light)" };
  return { color: "var(--primary)", bg: "var(--primary-light)" };
}
