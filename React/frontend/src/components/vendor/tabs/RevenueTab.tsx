import { useVendorStore } from "@/store/vendorStore";
import { formatINR } from "@/utils/vendorFormat";
import { VendorLoadPrompt, VendorStatCard } from "../VendorBits";
import { ChartCard, DonutChart, LineChart } from "@/components/admin/charts/Charts";

const unitOf = (fuel: string) => (fuel.toLowerCase() === "cng" ? "kg" : "L");

/**
 * One colour per fuel, from the tokens.
 *
 * Fixed rather than taken in order, so Petrol is the same colour on the
 * vendor's ring as on a station card, and dark mode is handled by the token
 * rather than by this file.
 */
const fuelColour = (fuel: string) => {
  const key = fuel.toLowerCase();
  if (key === "cng") return "var(--fuel-cng)";
  if (key === "diesel") return "var(--fuel-diesel)";
  if (key === "petrol") return "var(--fuel-petrol)";
  return "var(--chart-4)";
};

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
  // Absent on an older server, and absent in a month with no sales at all;
  // either way the trend panel simply does not render.
  const weeks = r.weeks ?? [];
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

      {/*
        This month, week by week.

        The server has computed these buckets all along (revenueWeeksThisMonth)
        and only the admin dashboard was ever given them, so a vendor could see
        four totals and no direction. A trend is the first thing somebody
        running a pump wants from a revenue page.
      */}
      {weeks.length > 0 && (
        <div className="mb-6">
          <ChartCard
            title="Revenue this month"
            icon="fa-chart-line"
            subtitle="Week by week, from completed bookings whose payment was received."
            testId="vendor-revenue-trend"
          >
            <LineChart
              points={weeks.map((w) => ({ label: w.label, value: w.revenue }))}
              colour="var(--chart-1)"
              format={(v) => formatINR(v)}
              ariaLabel="Revenue by week this month"
            />
          </ChartCard>
        </div>
      )}

      <div className="vm-bg-surface rounded-2xl border vm-border p-6 mb-6">
        <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
          <i className="fas fa-chart-bar vm-accent-text" aria-hidden /> Fuel Sales Breakdown (This Month)
        </h3>
        {/*
          A split is a share of a whole, which is what a ring shows and a row
          of bars does not. The bars stay underneath: they carry the litres
          and the transaction count, which the ring cannot. One fuel is not a
          split, so the ring only appears when there is something to compare.
        */}
        {fuelSales.length > 1 && (
          <div className="mb-6">
            {/* centreLabel is the noun under the total the ring prints
                itself, the way the admin donuts read ("stations",
                "bookings") -- not the amount again. */}
            <DonutChart
              slices={fuelSales.map(([fuel, data]) => ({ label: fuel, value: data.revenue, colour: fuelColour(fuel) }))}
              centreLabel="rupees"
              ariaLabel="Revenue by fuel this month"
            />
          </div>
        )}
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
