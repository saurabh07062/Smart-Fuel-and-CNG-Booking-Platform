import { useEffect, useState } from "react";
import * as api from "@/services/api/adminApi";
import type { AdminActivityEntry } from "@/services/api/adminApi";
import { toApiError } from "@/services/api/apiClient";
import { formatINR } from "@/utils/consoleFormat";
import Money from "@/components/common/Money";
import { ChartCard } from "./charts/Charts";

const KIND: Record<string, { icon: string; colour: string }> = {
  booking: { icon: "fa-calendar-check", colour: "#3b82f6" },
  payment: { icon: "fa-indian-rupee-sign", colour: "#22c55e" },
  vendor: { icon: "fa-store", colour: "#a855f7" },
  station: { icon: "fa-gas-pump", colour: "#f97316" },
};

/** "3 min ago", "2 h ago", "5 Sep". */
function whenText(at: string): string {
  const then = new Date(at).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (!Number.isFinite(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return new Date(at).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/**
 * What happened on the platform most recently: bookings, payments collected
 * at the pump, vendor registrations and station changes, newest first
 * (GET /api/v1/admin/activity). Read-only.
 */
export default function AdminActivityPanel() {
  const [entries, setEntries] = useState<AdminActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchAdminActivity(8)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((err) => {
        if (!cancelled) setError(toApiError(err).msg);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ChartCard title="Recent activity" icon="fa-wave-square" testId="admin-activity">
      {error ? (
        <p className="text-[12px] text-red-400" role="alert">
          {error}
        </p>
      ) : entries === null ? (
        <p className="text-[11px] vm-text-muted py-6 text-center">Loading activity…</p>
      ) : entries.length === 0 ? (
        <p className="text-[11px] vm-text-muted py-6 text-center">Nothing has happened on the platform yet.</p>
      ) : (
        <ul className="space-y-2" data-testid="activity-list">
          {entries.slice(0, 10).map((e, i) => {
            const k = KIND[e.kind] ?? KIND.booking;
            return (
              <li key={`${e.kind}-${e.at}-${i}`} className="flex items-start gap-3">
                <span
                  className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 text-[11px]"
                  style={{ background: `${k.colour}22`, color: k.colour }}
                  aria-hidden
                >
                  <i className={`fas ${k.icon}`} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-bold vm-text truncate">{e.title}</p>
                  {e.detail && <p className="text-[11px] vm-text-muted truncate">{e.detail}</p>}
                </div>
                <div className="text-right flex-shrink-0">
                  {e.amount != null && (
                    <p className="text-[11px] font-bold">
                      <Money label="amount">{formatINR(e.amount)}</Money>
                    </p>
                  )}
                  <p className="text-[10px] vm-text-muted whitespace-nowrap">{whenText(e.at)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </ChartCard>
  );
}
