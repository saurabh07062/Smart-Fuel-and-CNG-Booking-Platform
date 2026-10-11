import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as api from "@/services/api/adminApi";
import type { ManagedVendor } from "@/services/api/adminApi";
import { toApiError } from "@/services/api/apiClient";
import { formatINR } from "@/utils/consoleFormat";
import Money from "@/components/common/Money";
import { ChartCard } from "./charts/Charts";
import DataTable, { type Column } from "@/components/common/DataTable";

const STATUS_COLOUR: Record<string, string> = {
  active: "var(--status-good)",
  pending: "var(--status-warn)",
  under_review: "var(--chart-1)",
  suspended: "var(--status-bad)",
  rejected: "var(--chart-axis)",
};

const statusText = (s: string) => s.replace("_", " ").replace(/^./, (c) => c.toUpperCase());

/**
 * Every vendor on the platform, as the admin console's vendor endpoint
 * returns them (GET /api/vendors): business, contact, application state, how
 * many stations they run and what those stations have taken. Nothing is
 * computed here -- the station count and revenue come from the server.
 *
 * The ring shows how the vendors split by state; the table lists them all,
 * busiest first. "Manage vendors" opens the full page, where they can be
 * approved, suspended and so on.
 */
export default function AdminVendorsPanel() {
  const navigate = useNavigate();
  const [vendors, setVendors] = useState<ManagedVendor[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchManagedVendors()
      .then((list) => {
        if (!cancelled) setVendors(list);
      })
      .catch((err) => {
        if (!cancelled) setError(toApiError(err).msg);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const byStatus = new Map<string, number>();
  for (const v of vendors ?? []) {
    const key = String(v.vendorStatus || "pending");
    byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
  }
  const rows = [...(vendors ?? [])].sort(
    (a, b) => (b.totalRevenue ?? 0) - (a.totalRevenue ?? 0) || (b.stationCount ?? 0) - (a.stationCount ?? 0),
  );

  const total = rows.length;
  const active = byStatus.get("active") ?? 0;
  const pending = (byStatus.get("pending") ?? 0) + (byStatus.get("under_review") ?? 0);
  const stations = rows.reduce((t, v) => t + (v.stationCount ?? 0), 0);
  // The dashboard is a summary: the busiest few, with the rest one click away.
  const PREVIEW = 6;
  const shown = rows.slice(0, PREVIEW);

  return (
    <ChartCard
      title="Vendors"
      icon="fa-store"
      subtitle="Who sells on the platform, busiest first"
      testId="admin-vendors"
      footer={
        total === 0 ? null : (
          <>
            <span className="flex items-center gap-2 flex-wrap">
              <span className="vm-pill t-good">{active} active</span>
              {pending > 0 && <span className="vm-pill t-warn">{pending} awaiting review</span>}
              {(byStatus.get("suspended") ?? 0) > 0 && (
                <span className="vm-pill t-bad">{byStatus.get("suspended")} suspended</span>
              )}
              {(byStatus.get("rejected") ?? 0) > 0 && (
                <span className="vm-pill t-idle">{byStatus.get("rejected")} rejected</span>
              )}
            </span>
            <span>
              {total} vendor{total === 1 ? "" : "s"} · {stations} station{stations === 1 ? "" : "s"}
            </span>
          </>
        )
      }
      note={
        <button
          type="button"
          onClick={() => navigate("/admin/vendors")}
          className="vm-bg-surface px-2.5 py-1 rounded-lg border vm-border text-[11px] font-bold vm-text-muted vm-hover transition-colors"
        >
          Manage vendors <i className="fas fa-arrow-right text-[9px]" aria-hidden />
        </button>
      }
    >
      {error ? (
        <p className="text-[12px] text-red-400" role="alert">
          {error}
        </p>
      ) : vendors === null ? (
        <p className="text-[11px] vm-text-muted py-6 text-center">Loading vendors…</p>
      ) : vendors.length === 0 ? (
        <p className="text-[11px] vm-text-muted py-6 text-center">No vendors have registered yet.</p>
      ) : (
        <div>
          <DataTable
            label="Vendors"
            rows={shown}
            rowKey={(v) => String(v._id)}
            rowTestId={(v) => `vendor-row-${v._id}`}
            testId="vendor-rows"
            columns={VENDOR_COLUMNS}
          />

          {rows.length > PREVIEW && (
            <button
              type="button"
              onClick={() => navigate("/admin/vendors")}
              className="w-full mt-3 py-2 rounded-xl text-[12px] font-bold vm-text-muted border vm-border vm-hover transition-colors"
            >
              {rows.length - PREVIEW} more vendor{rows.length - PREVIEW === 1 ? "" : "s"} — open vendor management{" "}
              <i className="fas fa-arrow-right text-[10px]" aria-hidden />
            </button>
          )}
        </div>
      )}
    </ChartCard>
  );
}

/**
 * The vendor columns for the admin dashboard preview.
 *
 * "Joined" is deliberately absent — it was the column that pushed this table
 * into a scrollbar, and it is the one an admin needs least on a dashboard; it
 * stays on the vendor management page. Contact and the station count drop
 * again on a phone, leaving who they are, whether they are active, and what
 * they are worth.
 */
const VENDOR_COLUMNS: Column<ManagedVendor>[] = [
  {
    key: "vendor",
    header: "Vendor",
    cell: (v) => (
      <>
        <p className="font-bold vm-text truncate max-w-[200px]">
          {v.businessName?.trim() || v.name || "Unnamed vendor"}
        </p>
        <p className="vm-text-muted truncate max-w-[200px]">{v.name}</p>
      </>
    ),
  },
  {
    key: "contact",
    header: "Contact",
    hideOnPhone: true,
    cell: (v) => (
      <div className="vm-text-muted">
        <p className="truncate max-w-[190px]">{v.email}</p>
        <p>{v.phone || "—"}</p>
      </div>
    ),
  },
  {
    key: "status",
    header: "Status",
    cell: (v) => {
      const colour = STATUS_COLOUR[String(v.vendorStatus)] ?? "var(--chart-axis)";
      return (
        <span
          className="px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap"
          style={{ color: colour, border: `1px solid color-mix(in srgb, ${colour} 34%, transparent)` }}
        >
          {statusText(String(v.vendorStatus || "pending"))}
        </span>
      );
    },
  },
  {
    key: "stations",
    header: "Stations",
    align: "right",
    hideOnPhone: true,
    cell: (v) => <span className="font-bold">{v.stationCount ?? 0}</span>,
  },
  {
    key: "revenue",
    header: "Revenue",
    align: "right",
    cell: (v) => (
      <span className="whitespace-nowrap">
        <Money label={`revenue of ${v.businessName || v.name}`}>{formatINR(v.totalRevenue || 0)}</Money>
      </span>
    ),
  },
];
