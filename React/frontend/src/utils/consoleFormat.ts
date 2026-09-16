/**
 * Operator-console formatting helpers, ported from js/console-ui.js.
 *
 * That file exists in the Vanilla app for exactly the reason this one does:
 * four separate console pages (Admin, Vendor Management, Super Admin, Vendor
 * Panel) need the same money/date/badge formatting, and leaving it in
 * whichever page happened to define it first made the other three depend on a
 * file they have nothing to do with.
 *
 * `vmEsc()` is deliberately NOT ported. It existed because vendor-supplied
 * strings were interpolated into template literals, so a vendor registering
 * as `<img onerror=...>` would run script in the admin's session. React
 * escapes text children by default, so the whole class of bug is gone rather
 * than guarded -- there is no call site left that could forget it.
 */

/** vmFormatINR(). Full precision, Indian digit grouping. */
export function formatINR(n: number | null | undefined): string {
  if (n === undefined || n === null || Number.isNaN(Number(n))) return "₹0";
  return (
    "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

/**
 * vmFormatINRShort(). Compact money for card facts, where a full 2-decimal
 * figure would wrap: 1,24,500 -> "₹1.2L". Indian units, matching every other
 * number on these screens.
 */
export function formatINRShort(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v >= 10000000) return "₹" + (v / 10000000).toFixed(1).replace(/\.0$/, "") + "Cr";
  if (v >= 100000) return "₹" + (v / 100000).toFixed(1).replace(/\.0$/, "") + "L";
  if (v >= 1000) return "₹" + (v / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return "₹" + Math.round(v);
}

/** vmFormatDate(). */
export function formatDate(d?: string | null): string {
  if (!d) return "N/A";
  return new Date(d).toLocaleDateString("en-IN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * vmTint(). Stable per-vendor cover tint, so the same vendor keeps the same
 * colour between renders instead of shuffling on every reload.
 */
export function tint(id: string | null | undefined): number {
  const s = String(id || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 5;
  return h;
}

/** vmInitial(). */
export function initial(name?: string | null): string {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}

/** The vendor-status chip's class, icon and label. From vmStatusBadge(). */
export const VENDOR_STATUS = {
  active: { cls: "vm-status-active", icon: "fa-circle", label: "Active" },
  pending: { cls: "vm-status-pending", icon: "fa-clock", label: "Pending" },
  under_review: { cls: "vm-status-review", icon: "fa-magnifying-glass", label: "Under Review" },
  suspended: { cls: "vm-status-suspended", icon: "fa-pause", label: "Suspended" },
  rejected: { cls: "vm-status-rejected", icon: "fa-xmark", label: "Rejected" },
} as const;

export function vendorStatusVisual(status?: string) {
  return VENDOR_STATUS[status as keyof typeof VENDOR_STATUS] ?? VENDOR_STATUS.pending;
}
