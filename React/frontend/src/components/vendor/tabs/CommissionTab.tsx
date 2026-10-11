import { useCallback, useEffect, useState } from "react";
import {
  fetchVendorCommission,
  fetchVendorCommissionEntries,
  fetchVendorSettlements,
  type CommissionEntry,
  type Settlement,
  type VendorCommission,
} from "@/services/api/commissionApi";
import { toApiError } from "@/services/api/apiClient";
import Loader from "@/components/common/Loader";
import { formatINR } from "@/utils/vendorFormat";
import { VendorStatCard } from "../VendorBits";
import DataTable from "@/components/common/DataTable";

/**
 * Commission: what FuelMart has earned from this vendor's sales, and what has
 * been collected.
 *
 * HOW TO READ THE THREE NUMBERS
 *
 * Fuel is paid for at the pump, so the vendor already holds every rupee the
 * customer handed over. These figures are the other direction -- the platform
 * fee owed back on each sale:
 *
 *   Earned    FuelMart's share of every sale so far
 *   Pending   accrued today (and any earlier day not yet collected),
 *             transferred at the end-of-day settlement
 *   Settled   transfers that have been CONFIRMED as received
 *
 * Every figure is the server's (backend services/commission/commissionService.js).
 * Nothing on this screen is calculated from anything else on this screen.
 */

const STATUS_LOOK: Record<string, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-yellow-900/30 text-yellow-400" },
  settled: { label: "Settled", className: "bg-emerald-900/30 text-emerald-400" },
  failed: { label: "Failed", className: "bg-red-900/30 text-red-400" },
  refunded: { label: "Refunded", className: "bg-slate-700/40 vm-text-muted" },
  awaiting_confirmation: { label: "Awaiting confirmation", className: "bg-yellow-900/30 text-yellow-400" },
};

const when = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

function StatusPill({ status }: { status: string }) {
  const look = STATUS_LOOK[status] ?? { label: status, className: "bg-slate-700/40 vm-text-muted" };
  return (
    <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase ${look.className}`}>{look.label}</span>
  );
}

export default function CommissionTab() {
  const [summary, setSummary] = useState<VendorCommission | null>(null);
  const [entries, setEntries] = useState<CommissionEntry[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      // One pass: the three reads describe the same ledger, and showing a
      // summary that disagrees with the rows under it would be worse than
      // waiting a moment longer.
      const [s, e, st] = await Promise.all([
        fetchVendorCommission(),
        fetchVendorCommissionEntries({ limit: 25 }),
        fetchVendorSettlements({ limit: 15 }),
      ]);
      setSummary(s);
      setEntries(e.entries);
      setSettlements(st.settlements);
      setState("ready");
    } catch (err) {
      setError(toApiError(err).msg || "Could not load your commission.");
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === "loading") return <Loader label="Loading commission…" />;

  if (state === "error" || !summary) {
    return (
      <div className="py-8">
        <p className="text-sm vm-text-muted mb-3" role="alert">
          <i className="fas fa-triangle-exclamation mr-2" aria-hidden /> {error}
        </p>
        <button type="button" className="vm-btn vm-btn-primary" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <>
      <h2 className="text-2xl font-bold mb-2">Commission &amp; Settlement</h2>
      <p className="text-xs vm-text-muted mb-6" data-testid="commission-basis">
        FuelMart&apos;s share is the booking fee plus {summary.rate}% of fuel value, taken from each completed, paid
        booking. Customers pay you at the pump, so the day&apos;s commission is transferred to FuelMart at{" "}
        {summary.settlementTime} each day.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <VendorStatCard label="Commission earned (all time)" value={formatINR(summary.earned)} icon="fa-percent" color="blue" />
        <VendorStatCard
          label={`Pending · ${summary.pendingCount} booking${summary.pendingCount === 1 ? "" : "s"}`}
          value={formatINR(summary.pending)}
          icon="fa-hourglass-half"
          color="amber"
        />
        <VendorStatCard
          label={`Settled · ${summary.settledCount} booking${summary.settledCount === 1 ? "" : "s"}`}
          value={formatINR(summary.settled)}
          icon="fa-circle-check"
          color="emerald"
        />
      </div>

      {/* Today, so the vendor can reconcile against their own till. */}
      <div className="vm-bg-surface rounded-2xl border vm-border p-4 mb-6">
        <h3 className="text-sm font-semibold mb-3">
          Today <span className="vm-text-muted font-normal">· {summary.today.day}</span>
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <p className="vm-text-muted text-xs">Collected at the pump</p>
            <p className="font-semibold">{formatINR(summary.today.gross)}</p>
            <p className="vm-text-muted text-xs">
              {summary.today.bookings} booking{summary.today.bookings === 1 ? "" : "s"}
            </p>
          </div>
          <div>
            <p className="vm-text-muted text-xs">Your share</p>
            <p className="font-semibold" data-testid="commission-today-vendor">
              {formatINR(summary.today.vendorPayable)}
            </p>
            <p className="vm-text-muted text-xs">already yours — the customer paid you</p>
          </div>
          <div>
            <p className="vm-text-muted text-xs">FuelMart commission</p>
            <p className="font-semibold" data-testid="commission-today-amount">
              {formatINR(summary.today.commission)}
            </p>
            <p className="vm-text-muted text-xs">transferred at {summary.settlementTime}</p>
          </div>
        </div>
        {summary.minSettlement > 0 && (
          <p className="text-xs vm-text-muted mt-3">
            A day below {formatINR(summary.minSettlement)} is carried forward to the next settlement.
          </p>
        )}
      </div>

      {/* ---- settlements: the transfers themselves ---- */}
      <h3 className="text-lg font-semibold mb-2">Settlement history</h3>
      <div className="mb-6">
        <DataTable
          label="Settlement history"
          testId="settlement-history"
          rows={settlements}
          rowKey={(s) => s.id}
          empty="No settlements yet. One is raised per day once there is commission to transfer."
          columns={[
            { key: "reference", header: "Reference", cell: (s) => <span className="font-mono text-xs">{s.reference}</span> },
            { key: "day", header: "Day", cell: (s) => s.date },
            { key: "amount", header: "Amount", align: "right", cell: (s) => <b>{formatINR(s.amount)}</b> },
            { key: "count", header: "Bookings", align: "right", cell: (s) => s.entryCount, hideOnPhone: true },
            {
              key: "status",
              header: "Status",
              cell: (s) => (
                <>
                  <StatusPill status={s.status} />
                  {s.error && <span className="block text-xs vm-text-muted mt-1">{s.error}</span>}
                </>
              ),
            },
            {
              key: "when",
              header: "When",
              hideOnPhone: true,
              cell: (s) => <span className="text-xs vm-text-muted">{when(s.confirmedAt ?? s.at)}</span>,
            },
          ]}
        />
      </div>

      {/* ---- per booking: where each rupee came from ---- */}
      <h3 className="text-lg font-semibold mb-2">Commission per booking</h3>
      <DataTable
        label="Commission per booking"
        testId="commission-entries"
        rows={entries}
        rowKey={(e) => e.id}
        empty="Nothing yet. Commission is recorded when a booking is completed and its payment is received."
        columns={[
          {
            key: "booking",
            header: "Booking",
            cell: (e) => (
              <>
                <span className="font-mono text-xs">{e.bookingRef ?? "—"}</span>
                {e.fuelType && <span className="block text-xs vm-text-muted">{e.fuelType}</span>}
              </>
            ),
          },
          { key: "day", header: "Day", cell: (e) => e.date, hideOnPhone: true },
          { key: "gross", header: "Collected", align: "right", cell: (e) => formatINR(e.gross) },
          { key: "share", header: "Your share", align: "right", cell: (e) => formatINR(e.vendorPayable), hideOnPhone: true },
          { key: "commission", header: "Commission", align: "right", cell: (e) => <b>{formatINR(e.commission)}</b> },
          {
            key: "status",
            header: "Status",
            cell: (e) => (
              <>
                <StatusPill status={e.status} />
                {e.note && <span className="block text-xs vm-text-muted mt-1">{e.note}</span>}
              </>
            ),
          },
          {
            key: "settlement",
            header: "Settlement",
            hideOnPhone: true,
            cell: (e) => <span className="font-mono text-xs vm-text-muted">{e.settlementRef ?? "—"}</span>,
          },
        ]}
      />
    </>
  );
}
