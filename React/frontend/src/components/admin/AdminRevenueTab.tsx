import { useState } from "react";
import { useAdminStore } from "@/store/adminStore";
import { ConsoleLoading } from "@/components/console/ConsoleBits";
import { formatINR } from "@/utils/vendorFormat";
import AdminForecastTab from "./AdminForecastTab";
import Money from "@/components/common/Money";
import { ChartCard, MoneyColumns } from "./charts/Charts";

/**
 * What the platform has earned, in one place.
 *
 * This tab used to be an "Under Construction" panel while the same figures
 * were scattered across the dashboard and the Forecasting tab. It now owns
 * them: the windows (today, week, month, all time), the money still owed at
 * the pumps, the weekly shape of the current month, and -- below -- the sales
 * history and forecast that were the Forecasting tab.
 *
 * Every figure is the server's, on one definition (completed bookings whose
 * payment was received, backend services/payment/revenue.js). Nothing is
 * summed in the browser.
 */
export default function AdminRevenueTab() {
  /** The week a click picked out of the chart, or null for the whole month. */
  const [picked, setPicked] = useState<string | null>(null);
  const d = useAdminStore((s) => s.dashboard);
  const error = useAdminStore((s) => s.dashboardError);
  const loadDashboard = useAdminStore((s) => s.loadDashboard);

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
    return <ConsoleLoading label="Loading revenue…" />;
  }

  const zero = { revenue: 0, transactions: 0 };
  const today = d.revenue.today ?? zero;
  const week = d.revenue.week ?? zero;
  const month = d.revenue.month ?? zero;
  const allTime = d.revenue.allTime ?? zero;
  const awaiting = d.revenue.awaitingCollection ?? { count: 0, amount: 0 };
  const weeks = (d.revenue.weeksThisMonth ?? []).map((w) => ({ label: w.label, value: Number(w.revenue) || 0 }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <RevenueCard
          icon="fa-wallet"
          tone="i-green"
          label="Today"
          amount={today.revenue}
          note={`${today.transactions} paid transaction${today.transactions === 1 ? "" : "s"}`}
          pill={today.transactions > 0 ? "t-good" : "t-idle"}
        />
        <RevenueCard
          icon="fa-calendar-week"
          tone="i-blue"
          label="Last 7 days"
          amount={week.revenue}
          note={`${week.transactions} paid`}
          pill="t-info"
        />
        <RevenueCard
          icon="fa-calendar-days"
          tone="i-blue"
          label="This month"
          amount={month.revenue}
          note={`${month.transactions} paid`}
          pill="t-info"
        />
        <RevenueCard
          icon="fa-hand-holding-dollar"
          tone="i-amber"
          label="Awaiting collection"
          amount={awaiting.amount}
          note={awaiting.count > 0 ? `${awaiting.count} fuelled, not yet paid` : "All collected"}
          pill={awaiting.count > 0 ? "t-warn" : "t-good"}
        />
      </div>

      <ChartCard
        title="This month, week by week"
        icon="fa-chart-column"
        subtitle="Collected revenue inside the current billing cycle"
        testId="revenue-weeks"
        note={
          <span>
            All time <Money label="all-time revenue">{formatINR(allTime.revenue ?? d.revenue.total)}</Money>
          </span>
        }
        footer={
          <>
            <span>{d.revenue.basis || "Completed bookings whose payment was received"}.</span>
            {awaiting.count > 0 && (
              <span className="vm-pill t-warn">
                <Money label="awaiting collection">{formatINR(awaiting.amount)}</Money> still owed at the pumps
              </span>
            )}
          </>
        }
      >
        {weeks.length === 0 ? (
          <p className="text-[12px] vm-text-muted py-8 text-center">
            No sales recorded this month yet. Completed fills appear here as their payment is recorded.
          </p>
        ) : (
          <>
            <MoneyColumns
              points={weeks}
              ariaLabel="Revenue by week this month"
              format={compactINR}
              selected={picked}
              onSelect={(p) => setPicked((was) => (was === p.label ? null : p.label))}
            />
            {(() => {
              const week = picked ? (d.revenue.weeksThisMonth ?? []).find((w) => w.label === picked) : null;
              if (!week) {
                return (
                  <p className="text-[11px] vm-text-muted text-center mt-2">Tap a week to see its exact figures.</p>
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
            })()}
          </>
        )}
      </ChartCard>

      {/* Sales history, station performance and next month's forecast. */}
      <AdminForecastTab />
    </div>
  );
}

/** One revenue window: the amount, masked, with the state it is in. */
function RevenueCard({
  icon,
  tone,
  label,
  amount,
  note,
  pill,
}: {
  icon: string;
  tone: string;
  label: string;
  amount: number | null | undefined;
  note: string;
  pill: string;
}) {
  return (
    <div className="vm-panel vm-tile" style={{ padding: 16, marginBottom: 0 }} data-testid={`revenue-${label.toLowerCase().replace(/\W+/g, "-")}`}>
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
        <Money label={`${label} revenue`}>{formatINR(amount)}</Money>
      </p>
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
