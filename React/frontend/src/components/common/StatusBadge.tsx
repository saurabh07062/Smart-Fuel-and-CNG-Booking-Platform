import type { BookingStatus } from "@/types";

/**
 * Port of getStatusBadge() in js/utils.js -- the same map, the same classes,
 * the same fallback (an unknown status renders itself with badge-blue).
 */
const MAP: Record<string, [string, string]> = {
  upcoming: ["badge-blue", "Upcoming"],
  serving: ["badge-orange", "Serving"],
  waitlisted: ["badge-orange", "Waitlisted"],
  completed: ["badge-green", "Completed"],
  cancelled: ["badge-red", "Cancelled"],
  no_show: ["badge-red", "No Show"],
  expired: ["badge-gray", "Expired"],
  active: ["badge-orange", "Active"],
};

export default function StatusBadge({ status }: { status: BookingStatus | string }) {
  const [cls, txt] = MAP[status] ?? ["badge-blue", status];
  return <span className={`badge ${cls}`}>{txt}</span>;
}
