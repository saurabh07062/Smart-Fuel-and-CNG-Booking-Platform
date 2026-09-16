/**
 * Vendor-console formatters, ported verbatim from js/pages/vendorPanel.js.
 *
 * These deliberately differ from the customer app's formatCurrency(): the
 * console shows "₹1,23,456.00" in Indian digit grouping, the customer app
 * shows "INR 1,234.00". Both are user-visible, so both are kept as they were.
 */

/** vFormatINR(). NaN/null render as "₹0", as in the original. */
export function formatINR(n: number | null | undefined): string {
  if (n === undefined || n === null || Number.isNaN(Number(n))) return "₹0";
  return (
    "₹" +
    Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

/** vFormatDate(). */
export function formatDate(d?: string | null): string {
  if (!d) return "N/A";
  return new Date(d).toLocaleDateString("en-IN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** vFormatDateTime(). */
export function formatDateTime(d?: string | null): string {
  if (!d) return "N/A";
  return new Date(d).toLocaleString("en-IN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Badge colours for the stock tiers the backend computes
 * (backend/src/services/inventory/inventoryThreshold.js). The tier itself is never
 * re-derived here.
 */
export const INVENTORY_TIER_CLASS: Record<string, string> = {
  out_of_stock: "bg-red-900/40 text-red-400 border-red-700",
  critical: "bg-red-900/40 text-red-400 border-red-700",
  low: "bg-yellow-900/40 text-yellow-400 border-yellow-700",
  normal: "bg-emerald-900/40 text-emerald-400 border-emerald-700",
  capacity_unset: "vm-bg-surface vm-text-muted vm-border",
};
