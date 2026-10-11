import { useCallback, useEffect, useState } from "react";
import {
  confirmSettlement,
  fetchAdminCommission,
  fetchAdminSettlements,
  runSettlement,
  type AdminCommission,
  type Settlement,
} from "@/services/api/commissionApi";
import { toApiError } from "@/services/api/apiClient";
import Loader from "@/components/common/Loader";
import StatCard from "@/components/common/StatCard";
import DataTable from "@/components/common/DataTable";
import { pushToast } from "@/store/toastStore";
import { formatINR } from "@/utils/consoleFormat";

/**
 * Commission owed to FuelMart, and the settlements that collect it.
 *
 * THE ONE ACTION ON THIS SCREEN THAT MATTERS
 *
 * "Mark received" is what turns a settlement from *awaiting confirmation*
 * into *settled*, and with it every booking's commission inside it. Nothing
 * else does -- not the end-of-day job firing, not time passing. FuelMart has
 * no payout rail (online payment is off entirely), so a human confirming the
 * money arrived IS the confirmation, and until they do, the ledger honestly
 * says the money has not moved.
 *
 * Every figure comes from the server
 * (backend services/commission/commissionService.js).
 */

const STATUS_LOOK: Record<string, { label: string; className: string }> = {
  awaiting_confirmation: { label: "Awaiting confirmation", className: "bg-yellow-900/30 text-yellow-400" },
  settled: { label: "Settled", className: "bg-emerald-900/30 text-emerald-400" },
  failed: { label: "Failed", className: "bg-red-900/30 text-red-400" },
};

const when = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

export default function AdminCommissionTab() {
  const [summary, setSummary] = useState<AdminCommission | null>(null);
  const [rows, setRows] = useState<Settlement[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const [s, list] = await Promise.all([fetchAdminCommission(), fetchAdminSettlements({ limit: 40 })]);
      setSummary(s);
      setRows(list.settlements);
      setState("ready");
    } catch (err) {
      setError(toApiError(err).msg || "Could not load commission.");
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const confirm = async (s: Settlement) => {
    // The reference is optional but asked for: a settlement that says which
    // transfer it was is one somebody can reconcile against a bank statement.
    const ref = window.prompt(
      `Record ${formatINR(s.amount)} from ${s.vendor?.businessName || s.vendor?.name || "this vendor"} as received?\n\n` +
        "Transfer reference (optional):",
      s.transferRef ?? "",
    );
    if (ref === null) return; // cancelled

    setBusy(s.id);
    try {
      const result = await confirmSettlement(s.id, ref.trim() || undefined);
      pushToast(result.msg, result.alreadySettled ? "info" : "success");
      await load();
    } catch (err) {
      pushToast(toApiError(err).msg || "Could not record the settlement.", "error");
    } finally {
      setBusy(null);
    }
  };

  const runNow = async () => {
    setBusy("run");
    try {
      const result = await runSettlement();
      pushToast(
        result.vendors === 0
          ? "Nothing pending to settle."
          : `${result.vendors} vendor(s): ${result.raised} raised, ${result.settled} settled, ${result.failed} failed.`,
        "info",
      );
      await load();
    } catch (err) {
      pushToast(toApiError(err).msg || "The settlement run failed.", "error");
    } finally {
      setBusy(null);
    }
  };

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

  // Was an inline copy of a stat card. The shared one draws it now, so this
  // panel matches the vendor console and every other figure in the product.
  const stat = (label: string, value: string, hint?: string, tone: "primary" | "good" | "warn" | "bad" = "primary") => (
    <StatCard label={label} value={value} hint={hint} tone={tone} />
  );

  return (
    <>
      <div className="flex items-start justify-between gap-4 mb-2 flex-wrap">
        <h2 className="text-2xl font-bold">Commission &amp; Settlements</h2>
        <button
          type="button"
          className="vm-btn vm-btn-primary"
          onClick={() => void runNow()}
          disabled={busy !== null}
          data-testid="run-settlement"
        >
          <i className={`fas ${busy === "run" ? "fa-spinner fa-spin" : "fa-play"} mr-2`} aria-hidden />
          Run settlement now
        </button>
      </div>
      <p className="text-xs vm-text-muted mb-6">
        {summary.rate}% of fuel value plus the booking fee, from every completed and paid booking. Settled daily at{" "}
        {summary.settlementTime}.{" "}
        {summary.payoutMode === "manual" && (
          <b>
            No payout gateway is configured, so a settlement is marked settled only when an admin records the money as
            received.
          </b>
        )}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {stat("Earned (all time)", formatINR(summary.earned))}
        {stat("Pending", formatINR(summary.pending), "accrued, not yet collected")}
        {stat("Settled", formatINR(summary.settled), "transfers confirmed")}
        {stat(
          "Awaiting confirmation",
          formatINR(summary.awaitingConfirmation.amount),
          `${summary.awaitingConfirmation.count} settlement${summary.awaitingConfirmation.count === 1 ? "" : "s"}`,
        )}
      </div>

      {summary.failed.count > 0 && (
        <p className="text-sm text-red-400 mb-4" role="alert">
          <i className="fas fa-triangle-exclamation mr-2" aria-hidden />
          {summary.failed.count} settlement{summary.failed.count === 1 ? "" : "s"} failed ({formatINR(summary.failed.amount)}).
          Their commission went back to pending and will be retried on the next run.
        </p>
      )}

      <h3 className="text-lg font-semibold mb-2">Settlement history</h3>
      {/*
        The shared table (components/common/DataTable.tsx): one header style,
        one empty state, one scroll behaviour, shared with every other table
        in the product instead of hand-rolled here.
      */}
      <DataTable
        label="Settlement history"
        testId="admin-settlements"
        rows={rows}
        rowKey={(s) => s.id}
        empty="No settlements yet. One is raised per vendor per day once there is commission to transfer."
        columns={[
          {
            key: "reference",
            header: "Reference",
            cell: (s) => (
              <>
                <span className="font-mono text-xs">{s.reference}</span>
                {s.transferRef && <span className="block text-xs vm-text-muted">{s.transferRef}</span>}
              </>
            ),
          },
          { key: "vendor", header: "Vendor", cell: (s) => s.vendor?.businessName || s.vendor?.name || "—" },
          { key: "day", header: "Day", cell: (s) => s.date, hideOnPhone: true },
          { key: "amount", header: "Amount", align: "right", cell: (s) => <b>{formatINR(s.amount)}</b> },
          { key: "count", header: "Bookings", align: "right", cell: (s) => s.entryCount, hideOnPhone: true },
          {
            key: "status",
            header: "Status",
            cell: (s) => {
              const look = STATUS_LOOK[s.status] ?? { label: s.status, className: "bg-slate-700/40 vm-text-muted" };
              return (
                <>
                  <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase ${look.className}`}>
                    {look.label}
                  </span>
                  {s.error && <span className="block text-xs text-red-400 mt-1">{s.error}</span>}
                </>
              );
            },
          },
          {
            key: "when",
            header: "When",
            hideOnPhone: true,
            cell: (s) => <span className="text-xs vm-text-muted">{when(s.confirmedAt ?? s.at)}</span>,
          },
          {
            key: "action",
            header: "",
            align: "right",
            cell: (s) =>
              s.status === "settled" ? null : (
                <button
                  type="button"
                  className="vm-btn vm-btn-approve"
                  onClick={() => void confirm(s)}
                  disabled={busy !== null}
                  data-testid={`confirm-${s.id}`}
                >
                  {busy === s.id ? "Saving…" : "Mark received"}
                </button>
              ),
          },
        ]}
      />
    </>
  );
}
