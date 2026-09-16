import { useVendorStore } from "@/store/vendorStore";
import { formatINR } from "@/utils/vendorFormat";
import { VendorLoadPrompt, VendorStatCard } from "../VendorBits";

const unitOf = (fuel: string) => (fuel.toLowerCase() === "cng" ? "kg" : "L");

/**
 * Port of renderVendorRevenueTab().
 *
 * Every figure is the server's aggregation of real bookings
 * (backend/src/services/payment/revenue.js): completed bookings whose payment
 * was received, dated when earned. Nothing is estimated here and nothing is
 * summed on the client; with no transactions the cards read ₹0.
 */
export default function RevenueTab() {
  const r = useVendorStore((s) => s.revenue);
  const loadTab = useVendorStore((s) => s.loadTab);

  if (!r) {
    return (
      <VendorLoadPrompt
        icon="fa-wallet"
        title="Revenue Analytics"
        message="Click below to load revenue data"
        label="Load Revenue"
        onLoad={() => void loadTab("revenue")}
      />
    );
  }

  const fuelSales = Object.entries(r.fuelSales ?? {});
  // Guard the divisor: an all-zero month would otherwise make every bar NaN%.
  const maxRevenue = Math.max(...fuelSales.map(([, v]) => v.revenue), 1);
  const tx = r.transactions ?? { today: 0, week: 0, month: 0, allTime: 0 };
  const awaiting = r.awaitingCollection ?? { count: 0, amount: 0 };

  return (
    <>
      <h2 className="text-2xl font-bold mb-2">Revenue Analytics</h2>
      <p className="text-xs vm-text-muted mb-6" data-testid="revenue-basis">
        {r.basis || "Completed bookings whose payment was received"} · updates live as bookings are completed and paid.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <VendorStatCard label={`Today's Revenue · ${tx.today} paid`} value={formatINR(r.todaysRevenue)} icon="fa-calendar-day" color="blue" />
        <VendorStatCard label={`Last 7 Days · ${tx.week} paid`} value={formatINR(r.weeklyRevenue)} icon="fa-calendar-week" color="cyan" />
        <VendorStatCard label={`This Month · ${tx.month} paid`} value={formatINR(r.monthlyRevenue)} icon="fa-calendar" color="emerald" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <VendorStatCard label={`All Time · ${tx.allTime} paid`} value={formatINR(r.allTimeRevenue)} icon="fa-sack-dollar" color="indigo" />
        <VendorStatCard
          label={`Awaiting Collection · ${awaiting.count} booking${awaiting.count === 1 ? "" : "s"}`}
          value={formatINR(awaiting.amount)}
          icon="fa-hand-holding-dollar"
          color="orange"
        />
        <VendorStatCard
          label="This Month: Fuel + Fees"
          value={`${formatINR(r.monthBreakdown?.fuelValue)} + ${formatINR(r.monthBreakdown?.fees)}`}
          icon="fa-receipt"
          color="yellow"
        />
      </div>

      <div className="vm-bg-surface rounded-2xl border vm-border p-6 mb-6">
        <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
          <i className="fas fa-chart-bar vm-accent-text" aria-hidden /> Fuel Sales Breakdown (This Month)
        </h3>
        {fuelSales.length === 0 ? (
          <p className="vm-text-muted text-sm text-center py-8">No paid sales this month yet</p>
        ) : (
          <div className="space-y-4">
            {fuelSales.map(([fuel, data]) => (
              <div key={fuel}>
                <div className="flex justify-between items-end mb-2">
                  <span className="text-sm font-bold">{fuel}</span>
                  <span className="vm-subtitle" style={{ fontSize: "11.5px" }}>
                    {data.quantity} {unitOf(fuel)} • {formatINR(data.revenue)}
                    {typeof data.transactions === "number" ? ` • ${data.transactions} paid` : ""}
                  </span>
                </div>
                <div className="h-3 w-full vm-bg-ground rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-blue-600 to-cyan-400 rounded-full transition-all"
                    style={{ width: `${(data.revenue / maxRevenue) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
