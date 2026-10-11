import { useAdminStore, type AdminTab } from "@/store/adminStore";
import type { ReactNode } from "react";
import type { SuperAdminDashboard } from "@/services/api/adminApi";
import { ConsoleLoading } from "@/components/console/ConsoleBits";
import { formatINR } from "@/utils/vendorFormat";
import { useState } from "react";
import Money from "@/components/common/Money";
import { ChartCard, DonutChart, LineChart, MoneyColumns } from "./charts/Charts";
import AdminVendorsPanel from "./AdminVendorsPanel";
import AdminActivityPanel from "./AdminActivityPanel";

/**
 * The admin dashboard and inventory panels.
 *
 * Every figure is read from GET /api/v1/admin/dashboard, which aggregates real
 * bookings and stations: revenue from the one definition in
 * backend/src/services/payment/revenue.js (completed bookings whose payment was
 * received), today's bookings by their slot hour, stock recorded at active
 * stations and the live queue. The store re-reads it after every booking or
 * station socket event. With no transactions the figures read ₹0 / 0 -- the
 * placeholder numbers the Vanilla console showed here are gone.
 */
export default function AdminDashboardTab({ tab }: { tab: AdminTab }) {
  const d = useAdminStore((s) => s.dashboard);
  const error = useAdminStore((s) => s.dashboardError);
  const loadDashboard = useAdminStore((s) => s.loadDashboard);
  const setTab = useAdminStore((s) => s.setTab);

  if (!d) {
    if (error) {
      return (
        <div className="vm-panel text-center" style={{ padding: 28 }} role="alert">
          <p className="vm-text font-bold mb-2">{error}</p>
          <button type="button" className="vm-btn vm-btn-primary" onClick={() => void loadDashboard()}>
            Try again
          </button>
        </div>
      );
    }
    return <ConsoleLoading label="Loading dashboard..." />;
  }

  const showDashboard = tab === "dashboard";

  return (
    <>
      {showDashboard && (
        <>
          <StatTiles d={d} />

          {/*
            Two independent columns, not three rows of panels.

            A row-based grid makes every panel in a row wait for the tallest
            one: the short status ring beside the long vendor table left a
            field of empty space under it, and the next row could not start
            until the table ended. Stacking each column on its own lets the
            rail panels sit directly under one another.
          */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
            <div className="xl:col-span-2 space-y-4 min-w-0">
              <RevenueTrend d={d} />
              <AdminVendorsPanel />
              <InventoryPanel d={d} onManage={() => void setTab("stations")} />
            </div>

            <div className="space-y-4 min-w-0">
              <NetworkSummary d={d} />
              <StatusSummary d={d} onViewOrders={() => void setTab("orders")} />
              <AdminActivityPanel />
            </div>
          </div>
        </>
      )}
      {/* On the Inventory tab the stock panel is the page. */}
      {!showDashboard && <InventoryPanel d={d} onManage={() => void setTab("stations")} />}
    </>
  );
}

/**
 * One figure on the dashboard: what it is, what state it is in, and the
 * number itself -- in that reading order, with the state as a pill so it can
 * be taken in without reading the words.
 */
function Tile({
  icon,
  tone,
  label,
  value,
  note,
  pill = "t-idle",
  testId,
}: {
  icon: string;
  tone: string;
  label: string;
  value: ReactNode;
  note: string;
  /** Pill tone: t-good, t-warn, t-bad, t-info, t-idle. */
  pill?: string;
  testId: string;
}) {
  return (
    <div className="vm-panel vm-tile" style={{ padding: 16, marginBottom: 0 }} data-testid={testId}>
      <div className="flex justify-between items-start mb-3 gap-2">
        <div className={`w-9 h-9 rounded-xl ${tone} flex items-center justify-center`}>
          <i className={`fas ${icon} text-sm`} aria-hidden />
        </div>
        <span className={`vm-pill ${pill}`}>{note}</span>
      </div>
      <p className="vm-eyebrow" style={{ marginBottom: 4 }}>
        {label}
      </p>
      <p className="vm-stat-value" style={{ fontSize: 25 }}>
        {value}
      </p>
    </div>
  );
}

function StatTiles({ d }: { d: SuperAdminDashboard }) {
  const today = d.revenue.today ?? { revenue: 0, transactions: 0, fuelValue: 0, fees: 0, quantity: 0 };
  const awaiting = d.revenue.awaitingCollection ?? { count: 0, amount: 0 };
  const queue = d.liveQueue ?? { stations: 0, vehicles: 0, avgWaitMinutes: null };
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Tile
          testId="tile-revenue-today"
          icon="fa-wallet"
          tone="i-green"
          label="Today's Revenue"
          value={<Money label="today's revenue">{formatINR(today.revenue)}</Money>}
          pill={today.transactions > 0 ? "t-good" : "t-idle"}
          note={`${today.transactions} paid transaction${today.transactions === 1 ? "" : "s"}`}
        />
        <Tile
          testId="tile-bookings-today"
          icon="fa-box"
          tone="i-blue"
          label="Today's Bookings"
          value={String(d.today?.bookings ?? 0)}
          pill={(d.today?.bookings ?? 0) > 0 ? "t-info" : "t-idle"}
          note="Scheduled today"
        />
        <Tile
          testId="tile-awaiting"
          icon="fa-hand-holding-dollar"
          tone="i-amber"
          label="Awaiting Collection"
          value={<Money label="awaiting collection">{formatINR(awaiting.amount)}</Money>}
          // Money owed at the pumps is a thing to chase, not a neutral fact.
          pill={awaiting.count > 0 ? "t-warn" : "t-good"}
          note={awaiting.count > 0 ? `${awaiting.count} fuelled, not yet paid` : "All collected"}
        />
        <Tile
          testId="tile-wait"
          icon="fa-clock"
          tone="i-red"
          label="Avg. Live Wait"
          value={queue.avgWaitMinutes === null ? "—" : `${queue.avgWaitMinutes} min`}
          pill={queue.vehicles > 0 ? "t-warn" : "t-good"}
          note={`${queue.vehicles} in line · ${queue.stations} active station${queue.stations === 1 ? "" : "s"}`}
        />
      </div>
    </>
  );
}

/** The server's own monthly revenue series. */
function RevenueTrend({ d }: { d: SuperAdminDashboard }) {
  const months = (d.revenue.monthly ?? []).map((m) => ({ label: monthLabel(m.month), value: Number(m.revenue) || 0 }));
  const weeks = (d.revenue.weeksThisMonth ?? []).map((w) => ({ label: w.label, value: Number(w.revenue) || 0 }));

  /**
   * Which series the panel draws.
   *
   * The weeks of the month a customer is standing in say something they can
   * act on ("the middle of the month is our week"); a year of months does
   * not. So weeks lead, and the months are the view for someone looking
   * further back -- which is also the only series an older backend sends.
   */
  const [range, setRange] = useState<"month" | "year">(weeks.length > 0 ? "month" : "year");
  /** The period a click picked out of the chart, or null for the whole view. */
  const [picked, setPicked] = useState<string | null>(null);
  const showWeeks = range === "month" && weeks.length > 0;
  const series = showWeeks ? weeks : months;
  const best = series.reduce((t, m) => Math.max(t, m.value), 0);

  return (
    <ChartCard
      title="Revenue trend"
      icon="fa-chart-line"
      subtitle={showWeeks ? "This month, week by week" : "Month by month, as sales were collected"}
      testId="revenue-trend"
      note={
        weeks.length > 0 ? (
          <select
            className="vm-input"
            style={{ height: 30, padding: "0 8px", fontSize: 11.5 }}
            aria-label="Revenue period"
            value={range}
            onChange={(e) => setRange(e.target.value as "month" | "year")}
          >
            <option value="month">This month</option>
            <option value="year">By month</option>
          </select>
        ) : best > 0 ? (
          <>
            Best month <Money>{formatINR(best)}</Money>
          </>
        ) : null
      }
      footer={
        // The three windows as their own cards: an admin reads these more
        // often than the chart, and a run-on sentence buried them.
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 w-full" data-testid="revenue-windows">
          <RevenueWindow icon="fa-calendar-week" label="Last 7 days" amount={d.revenue.week?.revenue} />
          <RevenueWindow icon="fa-calendar-days" label="This month" amount={d.revenue.month?.revenue} />
          <RevenueWindow icon="fa-clock-rotate-left" label="All time" amount={d.revenue.allTime?.revenue ?? d.revenue.total} />
        </div>
      }
    >
      {/* The figure first, then its shape over time: the panel exists to
          answer "how much", and the chart answers "when". */}
      <div className="text-center mb-3">
        <span className="vm-pill t-good inline-flex mb-2">
          <i className="fas fa-circle" style={{ fontSize: 6 }} aria-hidden /> Active billing cycle
        </span>
        <p className="vm-figure is-accent" style={{ fontSize: 38 }}>
          {formatINR(d.revenue.month?.revenue)}
        </p>
        <p className="text-[11px] vm-text-muted mt-1">
          {months.length === 0
            ? "No sales recorded yet."
            : showWeeks
              ? `${d.revenue.basis || "Completed bookings whose payment was received"}.`
              : months.length === 1
                ? `${months[0].label} — the first month with sales.`
                : `${months[0].label} to ${months[months.length - 1].label} — ${months.length} months of sales.`}
        </p>
      </div>

      {showWeeks ? (
        <>
          <MoneyColumns
            points={weeks}
            ariaLabel="Revenue by week this month"
            format={(v) => compactINR(v)}
            selected={picked}
            onSelect={(p) => setPicked((was) => (was === p.label ? null : p.label))}
          />
          <WeekDetail weeks={d.revenue.weeksThisMonth ?? []} picked={picked} />
        </>
      ) : (
        <LineChart points={months} colour="var(--z-accent)" ariaLabel="Monthly revenue" format={(v) => formatINR(v)} />
      )}
    </ChartCard>
  );
}

/**
 * The exact figures for the week a click picked out.
 *
 * The chart rounds to "₹4.6K" so five columns fit; this is where the real
 * number lives, for the one period someone actually asked about.
 */
function WeekDetail({
  weeks,
  picked,
}: {
  weeks: NonNullable<SuperAdminDashboard["revenue"]["weeksThisMonth"]>;
  picked: string | null;
}) {
  const week = picked ? weeks.find((w) => w.label === picked) : null;
  if (!week) {
    return (
      <p className="text-[11px] vm-text-muted text-center mt-2" data-testid="week-hint">
        Tap a week to see its exact figures.
      </p>
    );
  }
  return (
    <div
      className="rounded-xl px-3.5 py-2.5 mt-3 flex items-center justify-between gap-3 flex-wrap"
      style={{ background: "var(--z-ground)", border: "1px solid var(--z-accent)" }}
      data-testid="week-detail"
    >
      <span className="text-[12px] font-bold vm-text">{week.label}</span>
      <span className="text-[12px] vm-text-muted">
        <Money label={`revenue for ${week.label}`}>{formatINR(week.revenue)}</Money> ·{" "}
        {week.transactions} paid transaction{week.transactions === 1 ? "" : "s"}
      </span>
    </div>
  );
}

/** One of the three revenue windows under the chart. */
function RevenueWindow({ icon, label, amount }: { icon: string; label: string; amount?: number | null }) {
  return (
    <div className="vm-bg-ground rounded-xl border vm-border px-3 py-2 flex items-center gap-2.5">
      <span
        className="inline-flex items-center justify-center rounded-lg flex-shrink-0"
        style={{ width: 28, height: 28, background: "var(--z-accent-soft)", color: "var(--z-accent)" }}
        aria-hidden
      >
        <i className={`fas ${icon}`} style={{ fontSize: 11 }} />
      </span>
      <span className="min-w-0">
        <span className="vm-eyebrow block">{label}</span>
        <span className="text-[12.5px] font-bold vm-text">
          <Money label={`${label} revenue`}>{formatINR(amount)}</Money>
        </span>
      </span>
    </div>
  );
}

/** "₹7.5K" on an axis, where the full figure would not fit. */
function compactINR(v: number): string {
  if (v >= 1000) {
    const k = v / 1000;
    return `₹${k % 1 === 0 ? k : k.toFixed(1)}K`;
  }
  return `₹${Math.round(v)}`;
}

/**
 * What the network is made of: stations by state, then the counts and the
 * stock behind them.
 *
 * The ring answers one question (how many stations, and are they live); every
 * other figure is a labelled row underneath, right-aligned so the numbers
 * line up and a long one (5,29,986 kg) has room instead of wrapping under its
 * own label.
 */
function NetworkSummary({ d }: { d: SuperAdminDashboard }) {
  const stations = d.stations ?? { total: 0, active: 0 };
  const vendors = d.vendors ?? { total: 0, pending: 0 };
  const stock = d.fuelStock ?? { petrol: 0, diesel: 0, cng: 0 };
  const inactive = Math.max(0, stations.total - stations.active);
  const n = (v: number | null | undefined) => Math.round(Number(v) || 0).toLocaleString("en-IN");

  return (
    <ChartCard
      title="Network"
      icon="fa-diagram-project"
      subtitle="Stations, vendors and stock"
      testId="network-summary"
      footer={
        <>
          <span>{d.customers?.total ?? 0} registered customers</span>
          <span>{stations.active} of {stations.total} stations serving</span>
        </>
      }
    >
      <DonutChart
        layout="stack"
        size={124}
        centreLabel="stations"
        ariaLabel="Stations by state"
        slices={[
          { label: "Active", value: stations.active, colour: "var(--z-accent)" },
          { label: "Inactive", value: inactive, colour: "var(--chart-axis)" },
        ]}
      />

      <dl className="mt-4 text-[12px]" data-testid="network-figures">
        <NetworkRow label="Vendors" value={n(vendors.total)} note={vendors.pending > 0 ? `${vendors.pending} pending` : undefined} />
        <NetworkRow label="Customers" value={n(d.customers?.total)} />
        <NetworkRow label="Petrol in tanks" value={`${n(stock.petrol)} L`} />
        <NetworkRow label="Diesel in tanks" value={`${n(stock.diesel)} L`} />
        <NetworkRow label="CNG in tanks" value={`${n(stock.cng)} kg`} last />
      </dl>
    </ChartCard>
  );
}

/** One "label ......... value" line, with an optional state beside the value. */
function NetworkRow({
  label,
  value,
  note,
  last = false,
}: {
  label: string;
  value: string;
  note?: string;
  last?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 py-2"
      style={last ? undefined : { borderBottom: "1px solid var(--z-line)" }}
    >
      <dt className="vm-text-muted">{label}</dt>
      <dd className="flex items-center gap-2 text-right">
        {note && <span className="vm-pill t-warn">{note}</span>}
        <span className="font-bold vm-text whitespace-nowrap" style={{ fontVariantNumeric: "tabular-nums" }}>
          {value}
        </span>
      </dd>
    </div>
  );
}

/** "2026-09" -> "Sep". */
function monthLabel(month: string): string {
  const [y, m] = String(month).split("-").map(Number);
  if (!y || !m) return String(month);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
}

const STATUS_ORDER = ["upcoming", "serving", "waitlisted", "completed", "cancelled", "no_show", "expired"];

const STATUS_COLOUR: Record<string, string> = {
  upcoming: "var(--chart-1)",
  serving: "var(--chart-6)",
  waitlisted: "var(--chart-4)",
  completed: "var(--status-good)",
  cancelled: "var(--status-warn)",
  no_show: "var(--status-bad)",
  expired: "var(--chart-axis)",
};

function StatusSummary({ d, onViewOrders }: { d: SuperAdminDashboard; onViewOrders: () => void }) {
  const entries = STATUS_ORDER.map((st) => [st, d.bookings?.[st] ?? 0] as const).filter(([, n]) => n > 0);
  const total = entries.reduce((t, [, n]) => t + n, 0);
  const completed = d.bookings?.completed ?? 0;
  // What share of every booking ever placed actually ended in a fill.
  const fulfilment = total > 0 ? (completed / total) * 100 : null;
  return (
    <ChartCard
      title="All bookings by status"
      icon="fa-box"
      testId="status-summary"
      note={
        <button
          onClick={onViewOrders}
          className="vm-bg-surface px-2.5 py-1 rounded-lg border vm-border text-[11px] font-bold vm-text-muted vm-hover transition-colors"
        >
          All orders <i className="fas fa-arrow-right text-[9px]" aria-hidden />
        </button>
      }
      footer={
        fulfilment === null ? null : (
          <>
            <span>
              Fulfilment rate <b className="vm-text">{fulfilment.toFixed(1)}%</b> completion
            </span>
            <span>{total} bookings all time</span>
          </>
        )
      }
    >
      {entries.length === 0 ? (
        <p className="vm-text-muted text-sm mb-4">No bookings on the platform yet.</p>
      ) : (
        <DonutChart
          centreLabel="bookings"
          ariaLabel="Bookings by status"
          slices={entries.map(([status, n]) => ({
            label: status.replace("_", " ").replace(/^./, (c) => c.toUpperCase()),
            value: n,
            colour: STATUS_COLOUR[status] ?? "var(--chart-axis)",
          }))}
        />
      )}
    </ChartCard>
  );
}

/** Network stock recorded at active stations, shown on the dashboard and the Inventory tab. */
function InventoryPanel({ d, onManage }: { d: SuperAdminDashboard; onManage: () => void }) {
  const stock = d.fuelStock ?? { petrol: 0, diesel: 0, cng: 0 };
  const cap = d.fuelCapacity ?? { petrol: null, diesel: null, cng: null };
  const fuels: Array<{ label: string; key: "petrol" | "diesel" | "cng"; unit: string; colour: string }> = [
    { label: "Petrol", key: "petrol", unit: "L", colour: "var(--fuel-petrol)" },
    { label: "Diesel", key: "diesel", unit: "L", colour: "var(--fuel-diesel)" },
    { label: "CNG", key: "cng", unit: "kg", colour: "var(--fuel-cng)" },
  ];
  const n = (v: number | null | undefined) => Math.round(Number(v) || 0).toLocaleString("en-IN");

  return (
    <ChartCard
      title="Network stock"
      icon="fa-boxes-stacked"
      subtitle="Recorded by the stations themselves"
      testId="inventory-panel"
      note={`${d.stations.active} active station${d.stations.active === 1 ? "" : "s"}`}
      footer={
        <>
          <span>Litres and kilograms are different units, so each fuel is shown against its own tanks.</span>
          <button
            type="button"
            onClick={onManage}
            className="vm-bg-surface px-2.5 py-1 rounded-lg border vm-border text-[11px] font-bold vm-text-muted vm-hover transition-colors"
          >
            Manage stations <i className="fas fa-arrow-right text-[9px]" aria-hidden />
          </button>
        </>
      }
    >
      {/*
        One row per fuel: what is in the tanks, out of what they hold, with a
        bar for the share. The dashboard used to carry this AND a bar chart
        AND a litres donut of the same three numbers -- three pictures of one
        fact, none of them saying how full anything was.
      */}
      <div className="space-y-4" data-testid="stock-levels">
        {fuels.map(({ label, key, unit, colour }) => {
          const current = Number(stock[key]) || 0;
          const capacity = cap[key];
          const pct = capacity ? Math.min(100, Math.round((current / capacity) * 100)) : null;
          // Under a fifth of the tank is the point at which someone should act.
          const low = pct !== null && pct < 20;
          return (
            <div key={key}>
              <div className="flex justify-between items-baseline gap-3 mb-1.5">
                <span className="text-[13px] font-bold vm-text flex items-center gap-2">
                  <span className="inline-block rounded-sm" style={{ width: 9, height: 9, background: colour }} aria-hidden />
                  {label}
                  {low && <span className="vm-pill t-warn">Low</span>}
                </span>
                <span className="text-[11.5px] vm-text-muted whitespace-nowrap" style={{ fontVariantNumeric: "tabular-nums" }}>
                  <b className="vm-text">
                    {n(current)} {unit}
                  </b>
                  {capacity ? ` / ${n(capacity)} ${unit}` : " · capacity not recorded"}
                </span>
              </div>
              <div className="h-2 w-full rounded-full overflow-hidden" style={{ background: "var(--z-line)" }}>
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${pct ?? 100}%`,
                    background: colour,
                    opacity: pct === null ? 0.3 : 1,
                    transition: "width .3s ease",
                  }}
                />
              </div>
              {pct !== null && (
                <p className="text-[10.5px] vm-text-muted mt-1">{pct}% of recorded capacity</p>
              )}
            </div>
          );
        })}
      </div>
    </ChartCard>
  );
}
