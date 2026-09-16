import { useAdminStore, type AdminTab } from "@/store/adminStore";
import type { SuperAdminDashboard } from "@/services/api/adminApi";
import { ConsoleLoading } from "@/components/console/ConsoleBits";
import { formatINR } from "@/utils/vendorFormat";

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
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
            <TodayByHour d={d} onViewOrders={() => void setTab("orders")} />
            <StatusSummary d={d} onViewOrders={() => void setTab("orders")} />
          </div>
        </>
      )}
      <InventoryPanel d={d} onManage={() => void setTab("stations")} />
    </>
  );
}

function Tile({
  icon,
  tone,
  label,
  value,
  note,
  testId,
}: {
  icon: string;
  tone: string;
  label: string;
  value: string;
  note: string;
  testId: string;
}) {
  return (
    <div className="vm-panel" style={{ padding: 18 }} data-testid={testId}>
      <div className="flex justify-between items-start mb-2 gap-2">
        <div className={`w-8 h-8 rounded-lg ${tone} flex items-center justify-center`}>
          <i className={`fas ${icon} text-sm`} aria-hidden />
        </div>
        <span className="text-xs vm-text-muted text-right">{note}</span>
      </div>
      <p className="vm-stat-label" style={{ marginBottom: 2 }}>
        {label}
      </p>
      <p className="vm-stat-value" style={{ fontSize: 22 }}>
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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 mb-3">
        <Tile
          testId="tile-revenue-today"
          icon="fa-wallet"
          tone="vm-accent/20 vm-accent-text"
          label="Today's Revenue"
          value={formatINR(today.revenue)}
          note={`${today.transactions} paid transaction${today.transactions === 1 ? "" : "s"}`}
        />
        <Tile
          testId="tile-bookings-today"
          icon="fa-box"
          tone="bg-emerald-500/20 text-emerald-400"
          label="Today's Bookings"
          value={String(d.today?.bookings ?? 0)}
          note="Scheduled today"
        />
        <Tile
          testId="tile-awaiting"
          icon="fa-hand-holding-dollar"
          tone="bg-orange-500/20 text-orange-400"
          label="Awaiting Collection"
          value={formatINR(awaiting.amount)}
          note={`${awaiting.count} fuelled, not yet paid`}
        />
        <Tile
          testId="tile-wait"
          icon="fa-clock"
          tone="bg-indigo-500/20 text-indigo-400"
          label="Avg. Live Wait"
          value={queue.avgWaitMinutes === null ? "—" : `${queue.avgWaitMinutes} min`}
          note={`${queue.vehicles} in line · ${queue.stations} active station${queue.stations === 1 ? "" : "s"}`}
        />
      </div>
      <p className="text-xs vm-text-muted mb-8" data-testid="revenue-windows">
        Last 7 days {formatINR(d.revenue.week?.revenue)} · This month {formatINR(d.revenue.month?.revenue)} · All time{" "}
        {formatINR(d.revenue.allTime?.revenue ?? d.revenue.total)} — {d.revenue.basis || "completed bookings whose payment was received"}.
      </p>
    </>
  );
}

const hourLabel = (h: number) => {
  const suffix = h < 12 ? "AM" : "PM";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${suffix}`;
};

function TodayByHour({ d, onViewOrders }: { d: SuperAdminDashboard; onViewOrders: () => void }) {
  const rows = d.today?.byHour ?? [];
  const max = Math.max(1, ...rows.map((r) => r.bookings));
  return (
    <div className="lg:col-span-2 vm-bg-surface rounded-2xl border vm-border p-6 flex flex-col">
      <div className="flex items-center justify-between mb-6">
        <h3 className="vm-panel-title">Today&apos;s Bookings by Slot Hour</h3>
        <button
          onClick={onViewOrders}
          className="vm-bg-surface px-3 py-1.5 rounded-lg border vm-border text-xs font-bold vm-text-muted flex items-center gap-2 cursor-pointer vm-hover transition-colors"
        >
          View All Orders <i className="fas fa-arrow-right text-[10px]" aria-hidden />
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="vm-text-muted text-sm text-center py-10" data-testid="by-hour-empty">
          No bookings scheduled today yet.
        </p>
      ) : (
        <div className="space-y-2" data-testid="by-hour">
          {rows.map((r) => (
            <div key={r.hour} className="flex items-center gap-3 text-xs">
              <span className="w-12 vm-text-muted font-bold">{hourLabel(r.hour)}</span>
              <div className="flex-1 h-3 vm-bg-ground rounded-full overflow-hidden">
                <div className="h-full vm-accent rounded-full" style={{ width: `${(r.bookings / max) * 100}%` }} />
              </div>
              <span className="w-32 text-right vm-text">
                {r.bookings} booked · {r.completed} done
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_ORDER = ["upcoming", "serving", "waitlisted", "completed", "cancelled", "no_show", "expired"];

function StatusSummary({ d, onViewOrders }: { d: SuperAdminDashboard; onViewOrders: () => void }) {
  const entries = STATUS_ORDER.map((s) => [s, d.bookings?.[s] ?? 0] as const).filter(([, n]) => n > 0);
  const total = Object.values(d.bookings ?? {}).reduce((a, b) => a + b, 0);
  return (
    <div className="lg:col-span-1 vm-bg-surface rounded-2xl border vm-border p-6 flex flex-col">
      <div className="flex items-center gap-3 mb-6">
        <i className="fas fa-box vm-accent-text" aria-hidden />
        <h3 className="vm-panel-title">All Bookings by Status</h3>
      </div>
      {entries.length === 0 ? (
        <p className="vm-text-muted text-sm mb-6">No bookings on the platform yet.</p>
      ) : (
        <ul className="space-y-2 mb-6 text-sm">
          {entries.map(([status, n]) => (
            <li key={status} className="flex justify-between">
              <span className="vm-text-muted capitalize">{status.replace("_", " ")}</span>
              <span className="vm-text font-bold">{n}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-auto">
        <div className="flex justify-between items-end mb-4">
          <h4 className="text-[11px] font-bold vm-text-muted tracking-widest uppercase">Total</h4>
          <span className="vm-accent-text font-bold text-lg leading-none">{total}</span>
        </div>
        <button
          onClick={onViewOrders}
          className="w-full py-3 vm-accent vm-accent-hover vm-text rounded-xl text-sm font-bold transition-colors flex items-center justify-center gap-2"
        >
          <i className="fas fa-box" aria-hidden /> Go to Orders
        </button>
      </div>
    </div>
  );
}

/** Network stock recorded at active stations, shown on the dashboard and the Inventory tab. */
function InventoryPanel({ d, onManage }: { d: SuperAdminDashboard; onManage: () => void }) {
  const stock = d.fuelStock ?? { petrol: 0, diesel: 0, cng: 0 };
  const cap = d.fuelCapacity ?? { petrol: null, diesel: null, cng: null };
  const fuels: Array<[string, "petrol" | "diesel" | "cng", string, string]> = [
    ["Petrol", "petrol", "L", "bg-orange-500"],
    ["Diesel", "diesel", "L", "vm-accent"],
    ["CNG", "cng", "kg", "bg-emerald-500"],
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
      <div className="lg:col-span-1 vm-bg-surface rounded-2xl border vm-border p-6 flex flex-col" data-testid="inventory-panel">
        <div className="flex items-center justify-between mb-2">
          <h3 className="vm-panel-title">Inventory</h3>
          <span className="text-[10px] font-bold vm-text-muted">{d.stations.active} active stations</span>
        </div>
        <p className="text-xs vm-text-muted mb-6">Stock recorded by stations, across the network.</p>

        <div className="space-y-6 mb-8">
          {fuels.map(([label, key, unit, cls]) => {
            const current = stock[key] ?? 0;
            const capacity = cap[key];
            const pct = capacity ? Math.min(100, Math.round((current / capacity) * 100)) : null;
            return (
              <div key={key}>
                <div className="flex justify-between items-end mb-2">
                  <span className="text-sm font-bold">{label}</span>
                  <span className="text-[11px] font-bold vm-text-muted">
                    <span className="vm-text">
                      {current.toLocaleString("en-IN")} {unit}
                    </span>
                    {capacity ? ` / ${capacity.toLocaleString("en-IN")} ${unit}` : " · capacity not recorded"}
                  </span>
                </div>
                {pct !== null && (
                  <div className="h-2 w-full vm-bg-surface rounded-full overflow-hidden">
                    <div className={`h-full ${cls} rounded-full`} style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <button
          type="button"
          onClick={onManage}
          className="w-full mt-auto py-3 vm-bg-surface vm-hover border vm-border rounded-xl text-sm font-bold transition-colors flex items-center justify-center gap-2"
        >
          <i className="fas fa-gas-pump vm-text-muted" aria-hidden /> Manage Stations
        </button>
      </div>
    </div>
  );
}
