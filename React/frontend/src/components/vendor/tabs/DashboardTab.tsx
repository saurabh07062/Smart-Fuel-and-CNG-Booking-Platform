import { useVendorStore } from "@/store/vendorStore";
import { VendorFuelBar, VendorLoadPrompt, VendorStatCard } from "../VendorBits";
import { formatINR } from "@/utils/vendorFormat";

/** Port of renderVendorDashboardTab(). Same eight stats, same order. */
export default function DashboardTab() {
  const d = useVendorStore((s) => s.dashboard);
  const loadTab = useVendorStore((s) => s.loadTab);

  if (!d) {
    return (
      <VendorLoadPrompt
        icon="fa-tachometer-alt"
        title="Vendor Dashboard"
        message="Click below to load your dashboard"
        label="Load Dashboard"
        onLoad={() => void loadTab("dashboard")}
      />
    );
  }

  const stock = d.fuelStock ?? { petrol: 0, diesel: 0, cng: 0 };
  const cap = d.fuelCapacity;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <VendorStatCard label="Today's Revenue" value={formatINR(d.todaysRevenue)} icon="fa-wallet" color="emerald" />
        <VendorStatCard label="Today's Bookings" value={d.todaysBookings} icon="fa-calendar-check" color="blue" />
        <VendorStatCard label="Queue Status" value={`${d.queueStatus} waiting`} icon="fa-users" color="orange" />
        <VendorStatCard label="Revenue This Month" value={formatINR(d.monthlySales)} icon="fa-chart-line" color="cyan" />
      </div>

      {d.awaitingCollection && d.awaitingCollection.count > 0 && (
        <div
          className="vm-bg-surface rounded-2xl border border-orange-500/30 p-4 mb-6 flex items-center gap-3"
          role="status"
          data-testid="awaiting-collection"
        >
          <i className="fas fa-hand-holding-dollar text-orange-400" aria-hidden />
          <p className="text-sm vm-text">
            <b>{formatINR(d.awaitingCollection.amount)}</b> awaiting collection at the pump from{" "}
            {d.awaitingCollection.count} fuelled booking{d.awaitingCollection.count === 1 ? "" : "s"}. It becomes
            revenue once the payment is recorded in Bookings.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <VendorStatCard label="Total Stations" value={d.totalStations} icon="fa-gas-pump" color="indigo" />
        <VendorStatCard label="Total Bookings" value={d.totalBookings} icon="fa-receipt" color="blue" />
        <VendorStatCard label="Active Pumps" value={d.activePumps} icon="fa-bolt" color="emerald" />
        <VendorStatCard label="Customers Today" value={d.customersToday} icon="fa-user-friends" color="yellow" />
      </div>

      <div className="vm-bg-surface rounded-2xl border vm-border p-6 mb-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <i className="fas fa-gas-pump text-orange-400" aria-hidden /> Fuel Stock Overview
          </h3>
          <span className="vm-subtitle" style={{ fontSize: "11.5px" }}>
            Total across all stations
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          <VendorFuelBar label="Petrol" current={stock.petrol} max={cap?.petrol} color="orange" />
          <VendorFuelBar label="Diesel" current={stock.diesel} max={cap?.diesel} color="indigo" />
          <VendorFuelBar label="CNG" current={stock.cng} max={cap?.cng} color="emerald" unit="kg" />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div className="vm-panel" style={{ padding: 22 }}>
          <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
            <i className="fas fa-fire text-orange-400" aria-hidden /> Top Selling Fuel
          </h3>
          <div className="vm-bg-ground p-6 rounded-xl border vm-border text-center">
            <p className="text-4xl font-bold text-orange-400 mb-2">{d.topSellingFuel || "—"}</p>
            <p className="text-sm vm-text-muted">
              {d.topSellingFuel ? "Most sold this month" : "No paid sales this month yet"}
            </p>
          </div>
        </div>

        <QuickActions />
      </div>
    </>
  );
}

function QuickActions() {
  const setTab = useVendorStore((s) => s.setTab);
  const actions: Array<[string, string, string, string, Parameters<typeof setTab>[0]]> = [
    ["fa-plus-circle", "vm-accent-text", "Add New Station", "Register a new petrol pump", "stations"],
    ["fa-boxes", "text-orange-400", "Update Inventory", "Manage fuel stock levels", "inventory"],
    ["fa-calendar-check", "text-emerald-400", "View Bookings", "Check recent bookings", "bookings"],
  ];

  return (
    <div className="vm-panel" style={{ padding: 22 }}>
      <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
        <i className="fas fa-bolt vm-accent-text" aria-hidden /> Quick Actions
      </h3>
      <div className="space-y-3">
        {actions.map(([icon, color, title, sub, tab]) => (
          <button
            key={tab}
            onClick={() => void setTab(tab)}
            className="w-full vm-bg-ground vm-hover border vm-border rounded-xl p-4 text-left transition-colors flex items-center gap-3"
          >
            <i className={`fas ${icon} ${color} text-xl`} aria-hidden />
            <div>
              <p className="font-bold text-sm">{title}</p>
              <p className="text-xs vm-text-muted">{sub}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
