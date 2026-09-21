import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useResync, useSocketEvent } from "@/hooks/useSocket";
import { SOCKET_EVENTS } from "@/services/socket/socketEvents";
import { coalesce } from "@/utils/coalesce";
import ConsoleShell, { type ConsoleTab } from "@/components/console/ConsoleShell";
import { ConsoleEmpty, ConsoleLoading, ConsoleStat } from "@/components/console/ConsoleBits";
import { useSuperAdminStore, type SaTab } from "@/store/superAdminStore";
import type { SuperAdminDashboard } from "@/services/api/adminApi";

/** SA_TABS. */
const TABS: ConsoleTab<SaTab>[] = [
  { id: "dashboard", icon: "fa-chart-simple", label: "Overview" },
  { id: "vendors", icon: "fa-store", label: "Vendors" },
  { id: "revenue", icon: "fa-indian-rupee-sign", label: "Financials" },
];

/** SA_COPY. */
const COPY: Record<SaTab, [string, string]> = {
  dashboard: ["Global Command Center", "Every vendor operation on FuelMart, in one view"],
  vendors: ["Vendor Network", "Prices and stock across the whole network"],
  revenue: ["Financials", "Revenue and booking volume by month"],
};

/** saMoney(). Whole rupees -- these are network-scale figures. */
const money = (n: number | null | undefined) =>
  "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** saMonthLabel(). "2026-09" -> "Sep 2026". The API returns ISO year-months. */
function monthLabel(iso: string): string {
  const parts = String(iso || "").split("-");
  const name = MONTHS[parseInt(parts[1], 10) - 1];
  return name ? `${name} ${parts[0]}` : String(iso || "");
}

/** saFactRow(). */
function FactRow({ label, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <div className="vm-row" style={{ cursor: "default" }}>
      <div className="vm-row-main">
        <div className="vm-row-name">{label}</div>
        <div className="vm-row-sub">{meta}</div>
      </div>
      <div className="vm-row-right">
        <div className="vm-row-value" style={{ color: "var(--z-ink)", fontSize: 17 }}>
          {value}
        </div>
      </div>
    </div>
  );
}

const METHOD_LABEL: Record<string, string> = {
  "moving-average": "Average of complete months",
  "exponential-smoothing": "Exponential smoothing",
  "holt-linear-trend": "Trend (Holt)",
  "insufficient-history": "Not enough history",
};

const RELIABILITY_LABEL: Record<string, string> = {
  good: "typical error",
  fair: "typical error",
  poor: "typical error — treat as rough",
  unmeasured: "accuracy not measurable yet",
};

/**
 * Next month's revenue, only as far as the history supports it (backend
 * services/algorithms/forecast.js forecastFromHistory). With too little history the
 * panel says so and shows the evidence, instead of a number.
 */
function ForecastPanel({ revenue }: { revenue: SuperAdminDashboard["revenue"] }) {
  const f = revenue?.forecastNextMonth;
  if (!f || typeof f !== "object") return null;
  const evidence = revenue.history;

  const evidenceLine = evidence
    ? `${evidence.totalBookings} completed ${evidence.basis === "customer-sales" ? "customer " : ""}booking${evidence.totalBookings === 1 ? "" : "s"} over ${evidence.daysObserved} day${evidence.daysObserved === 1 ? "" : "s"}` +
      (evidence.excludedBookings
        ? ` · ${evidence.excludedBookings} by vendor/admin accounts not counted`
        : evidence.nonCustomerBookings
          ? ` · ${evidence.nonCustomerBookings} by vendor/admin accounts`
          : "")
    : null;

  return (
    <div className="vm-panel">
      <div className="vm-panel-head">
        <h3 className="vm-panel-title">
          <i className="fas fa-chart-line" aria-hidden /> Next month forecast
          {f.forMonth ? ` (${f.forMonth})` : ""}
        </h3>
        <span className="vm-subtitle">
          {METHOD_LABEL[f.method] ?? f.method} · {f.completeMonths} complete month{f.completeMonths === 1 ? "" : "s"}
        </span>
      </div>
      <div className="vm-panel-body is-padded">
        {f.ready ? (
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
            <span className="vm-stat-value" style={{ fontSize: 30 }}>
              {money(f.value ?? 0)}
            </span>
            {f.method === "holt-linear-trend" && (
              <span className={`vm-status ${(f.trend || 0) >= 0 ? "vm-status-active" : "vm-status-rejected"}`}>
                <i className={`fas fa-arrow-${(f.trend || 0) >= 0 ? "up" : "down"}`} aria-hidden />
                {money(Math.abs(f.trend || 0))} / month
              </span>
            )}
            <span className="vm-subtitle">
              {f.errorPercent !== null ? `±${Number(f.errorPercent).toFixed(1)}% ` : ""}
              {RELIABILITY_LABEL[f.reliability]}
            </span>
          </div>
        ) : (
          <div>
            <p style={{ fontWeight: 600, color: "var(--z-ink)" }}>No forecast yet</p>
            <p className="vm-subtitle" style={{ marginTop: 4 }}>
              {f.reason}
            </p>
            {f.runRate && (
              <p className="vm-subtitle" style={{ marginTop: 8 }}>
                Current run rate: {money(f.runRate.value)} for next month ({f.runRate.basis}).
              </p>
            )}
          </div>
        )}
        {f.note && (
          <p className="vm-subtitle" style={{ marginTop: 10 }}>
            {f.note}
          </p>
        )}
        {evidenceLine && (
          <p className="vm-subtitle" style={{ marginTop: 6 }}>
            Based on {evidenceLine}.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * saOutcomeRows(). Booking outcomes as proportional bars.
 *
 * `completed` is the only good outcome, so it is the only one that gets the
 * green; the rest are bookings the network did not convert and read in a
 * warning tone.
 */
const OUTCOME_TONE: Record<string, [string, string]> = {
  completed: ["var(--z-green)", "Completed"],
  cancelled: ["var(--z-red)", "Cancelled"],
  expired: ["var(--z-amber)", "Expired"],
  no_show: ["var(--z-slate)", "No-show"],
};

function OutcomeRows({ bookings, total }: { bookings: Record<string, number>; total: number }) {
  const keys = Object.keys(OUTCOME_TONE).filter((k) => bookings[k] !== undefined);
  if (!keys.length || !total) return <p className="vm-empty-inline">No bookings yet</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {keys.map((k) => {
        const [color, label] = OUTCOME_TONE[k];
        const n = bookings[k] || 0;
        const pct = Math.round((n / total) * 100);
        return (
          <div key={k}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <span style={{ fontSize: 13, color: "var(--z-ink)", fontWeight: 500 }}>{label}</span>
              <span style={{ fontSize: "12.5px", color: "var(--z-light)", fontVariantNumeric: "tabular-nums" }}>
                {n} · {pct}%
              </span>
            </div>
            <div style={{ height: 7, borderRadius: 999, background: "var(--z-line-soft)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 999 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Port of renderSuperAdmin() and its three tabs.
 *
 * The Vanilla page fetched from inside its own render function and needed a
 * `superAdminLoading` flag to stop that from looping. Fetching from an effect
 * removes the loop rather than guarding it.
 */
export default function SuperAdmin() {
  const navigate = useNavigate();
  const tab = useSuperAdminStore((s) => s.tab);
  const setTab = useSuperAdminStore((s) => s.setTab);
  const data = useSuperAdminStore((s) => s.data);
  const loading = useSuperAdminStore((s) => s.loading);
  const error = useSuperAdminStore((s) => s.error);
  const load = useSuperAdminStore((s) => s.load);
  const reset = useSuperAdminStore((s) => s.reset);

  useEffect(() => {
    void load();
  }, [load]);

  // Live: totals, revenue and vendor counts change with bookings, stations and
  // vendor accounts. Silent and coalesced, so a burst costs at most two requests.
  const refreshLive = useMemo(() => coalesce(() => useSuperAdminStore.getState().refreshLive()), []);
  useSocketEvent(SOCKET_EVENTS.BOOKING_CREATED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.BOOKING_UPDATED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.BOOKING_CANCELLED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.BOOKING_COMPLETED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.STATION_CREATED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.STATION_UPDATED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.STATION_DELETED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.VENDOR_REQUEST_CREATED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.VENDOR_STATUS_CHANGED, refreshLive);
  useResync(refreshLive);

  const body = () => {
    if (error) {
      return (
        <ConsoleEmpty
          icon="fa-plug-circle-exclamation"
          title="Could not load the global dashboard"
          text={error}
          action={
            <button type="button" className="vm-btn vm-btn-primary" onClick={() => void load()}>
              <i className="fas fa-rotate" aria-hidden /> Try again
            </button>
          }
        />
      );
    }
    if (loading || !data) return <ConsoleLoading label="Loading global dashboard..." />;
    if (tab === "vendors") return <VendorsTab data={data} onOpenVendorMgmt={() => navigate("/admin/vendors")} />;
    if (tab === "revenue") return <FinancialsTab data={data} />;
    return <OverviewTab data={data} />;
  };

  const [title, subtitle] = COPY[tab];

  return (
    <ConsoleShell
      logoIcon="fa-globe"
      logoName="Super Admin"
      logoSub="Global Overview"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      title={title}
      subtitle={subtitle}
      onRefresh={() => void load()}
      onBeforeLogout={reset}
    >
      {body()}
    </ConsoleShell>
  );
}

/** renderSuperAdminDashboard(). */
function OverviewTab({ data }: { data: SuperAdminDashboard }) {
  const st = data.stations ?? { total: 0, active: 0 };
  const ve = data.vendors ?? { total: 0, pending: 0 };
  const cu = data.customers ?? { total: 0 };
  const bk = data.bookings ?? {};
  const rv = data.revenue;

  const bookingTotal = Object.values(bk).reduce((a, b) => a + (b || 0), 0);

  return (
    <>
      <div className="vm-stats">
        <ConsoleStat label="Network Revenue" value={money(rv?.total)} icon="fa-indian-rupee-sign" tone="green" />
        <ConsoleStat label="Stations Live" value={`${st.active ?? 0} / ${st.total ?? 0}`} icon="fa-gas-pump" tone="red" />
        <ConsoleStat label="Vendors" value={ve.total ?? 0} icon="fa-store" tone="blue" />
        <ConsoleStat label="Customers" value={cu.total ?? 0} icon="fa-users" tone="amber" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(330px,1fr))", gap: 20 }}>
        <div className="vm-panel">
          <div className="vm-panel-head">
            <h3 className="vm-panel-title">
              <i className="fas fa-calendar-check" aria-hidden /> Bookings by outcome
            </h3>
            <span className="vm-subtitle">{bookingTotal} total</span>
          </div>
          <div className="vm-panel-body">
            <OutcomeRows bookings={bk} total={bookingTotal} />
          </div>
        </div>

        <div className="vm-panel">
          <div className="vm-panel-head">
            <h3 className="vm-panel-title">
              <i className="fas fa-store" aria-hidden /> Network at a glance
            </h3>
          </div>
          <div className="vm-panel-body">
            <div className="vm-rows">
              <FactRow
                label="Stations online"
                value={String(st.active ?? 0)}
                meta={`${(st.total ?? 0) - (st.active ?? 0)} offline`}
              />
              <FactRow
                label="Vendors approved"
                value={String((ve.total ?? 0) - (ve.pending ?? 0))}
                meta={`${ve.pending ?? 0} awaiting approval`}
              />
              <FactRow label="Registered customers" value={String(cu.total ?? 0)} meta="across the platform" />
            </div>
          </div>
        </div>
      </div>

      <ForecastPanel revenue={rv} />
    </>
  );
}

/** renderSuperAdminVendors(). Totals only -- per-vendor detail lives elsewhere. */
function VendorsTab({
  data,
  onOpenVendorMgmt,
}: {
  data: SuperAdminDashboard;
  onOpenVendorMgmt: () => void;
}) {
  const st = data.stations ?? { total: 0, active: 0 };
  const ve = data.vendors ?? { total: 0, pending: 0 };
  const cu = data.customers ?? { total: 0 };

  return (
    <>
      <div className="vm-stats">
        <ConsoleStat label="Total Vendors" value={ve.total ?? 0} icon="fa-store" tone="red" />
        <ConsoleStat label="Awaiting Approval" value={ve.pending ?? 0} icon="fa-clock" tone="amber" />
        <ConsoleStat label="Stations Live" value={st.active ?? 0} icon="fa-gas-pump" tone="green" />
        <ConsoleStat label="Customers" value={cu.total ?? 0} icon="fa-users" tone="blue" />
      </div>

      <div className="vm-panel">
        <div className="vm-panel-head">
          <h3 className="vm-panel-title">
            <i className="fas fa-store" aria-hidden /> Vendor network
          </h3>
          <button type="button" className="vm-link" onClick={onOpenVendorMgmt}>
            Open Vendor Management <i className="fas fa-arrow-right" aria-hidden />
          </button>
        </div>
        <div className="vm-panel-body">
          <div className="vm-rows">
            <FactRow
              label="Approved vendors"
              value={String((ve.total ?? 0) - (ve.pending ?? 0))}
              meta="can operate stations"
            />
            <FactRow
              label="Pending applications"
              value={String(ve.pending ?? 0)}
              meta={ve.pending ? "waiting on an admin decision" : "nothing waiting"}
            />
            <FactRow
              label="Stations offline"
              value={String((st.total ?? 0) - (st.active ?? 0))}
              meta={`of ${st.total ?? 0} total`}
            />
          </div>
          <p className="vm-subtitle" style={{ marginTop: 14 }}>
            This view reports totals only. Per-vendor detail, approvals and secret codes live in
            Vendor Management.
          </p>
        </div>
      </div>
    </>
  );
}

/** renderSuperAdminFinancials(). */
function FinancialsTab({ data }: { data: SuperAdminDashboard }) {
  const rv = data.revenue;
  const monthly = Array.isArray(rv?.monthly) ? rv.monthly : [];

  if (!monthly.length) {
    return (
      <ConsoleEmpty
        icon="fa-chart-column"
        title="No financial data yet"
        text="Revenue appears here once bookings are completed."
      />
    );
  }

  const max = Math.max(...monthly.map((m) => m.revenue || 0), 1);
  const bookings = monthly.reduce((a, m) => a + (m.bookings || 0), 0);
  // Averaged over EARNING months only, not all months -- a run of zero
  // months would otherwise drag the average toward zero and misreport what a
  // trading month actually looks like.
  const earning = monthly.filter((m) => (m.revenue || 0) > 0);
  const avg = earning.length ? (rv.total || 0) / earning.length : 0;

  return (
    <>
      <div className="vm-stats">
        <ConsoleStat label="Total Revenue" value={money(rv.total)} icon="fa-indian-rupee-sign" tone="green" />
        <ConsoleStat label="Total Bookings" value={bookings} icon="fa-calendar-check" tone="amber" />
        <ConsoleStat label="Average / Earning Month" value={money(avg)} icon="fa-chart-line" tone="blue" />
      </div>

      <div className="vm-panel">
        <div className="vm-panel-head">
          <h3 className="vm-panel-title">
            <i className="fas fa-chart-column" aria-hidden /> Monthly revenue
          </h3>
          <span className="vm-subtitle">{monthly.length} months</span>
        </div>
        <div className="vm-panel-body is-padded">
          <div className="vm-bars">
            {monthly.map((m) => (
              <div className="vm-bar-col" key={m.month}>
                <div className="vm-bar-track">
                  <div
                    className="vm-bar"
                    style={{ height: `${Math.max(((m.revenue || 0) / max) * 100, 2)}%` }}
                  >
                    <span className="vm-bar-value">
                      {money(m.revenue)} · {m.bookings || 0} bookings
                    </span>
                  </div>
                </div>
                <span className="vm-bar-label">{monthLabel(m.month).split(" ")[0]}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <ForecastPanel revenue={rv} />

      <div className="vm-panel">
        <div className="vm-panel-head">
          <h3 className="vm-panel-title">
            <i className="fas fa-list" aria-hidden /> Month by month
          </h3>
        </div>
        <div className="vm-panel-body">
          <div className="vm-rows">
            {monthly
              .slice()
              .reverse()
              .map((m) => (
                <div className="vm-row" style={{ cursor: "default" }} key={m.month}>
                  <div className="vm-row-main">
                    <div className="vm-row-name">{monthLabel(m.month)}</div>
                    <div className="vm-row-sub">
                      {m.bookings || 0} booking{m.bookings === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="vm-row-right">
                    <div className="vm-row-value">{money(m.revenue)}</div>
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>
    </>
  );
}
