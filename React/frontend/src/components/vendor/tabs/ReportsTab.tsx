import { useEffect, useState } from "react";
import { useVendorStore } from "@/store/vendorStore";
import * as api from "@/services/api/vendorApi";
import type { VendorForecast } from "@/services/api/vendorApi";
import { toApiError } from "@/services/api/apiClient";
import { formatINR } from "@/utils/vendorFormat";
import { VendorLoadPrompt, VendorStatCard } from "../VendorBits";

const METHOD_LABEL: Record<string, string> = {
  "moving-average": "Average of complete months",
  "exponential-smoothing": "Exponential smoothing",
  "holt-linear-trend": "Trend (Holt)",
  "insufficient-history": "Not enough history",
};

const RELIABILITY_STYLE: Record<string, string> = {
  good: "text-emerald-400",
  fair: "text-yellow-400",
  poor: "text-red-400",
  unmeasured: "vm-text-muted",
};

/** Reports: completed-sale revenue by month, station performance, and the demand forecast. */
export default function ReportsTab() {
  const r = useVendorStore((s) => s.reports);
  const loadTab = useVendorStore((s) => s.loadTab);

  if (!r) {
    return (
      <VendorLoadPrompt
        icon="fa-chart-bar"
        title="Reports & Analytics"
        message="Click below to generate reports"
        label="Generate Reports"
        onLoad={() => void loadTab("reports")}
      />
    );
  }

  const monthly = r.monthlyData ?? [];
  const maxRevenue = Math.max(...monthly.map((m) => m.revenue), 1);

  return (
    <>
      <h2 className="text-2xl font-bold mb-6">Reports & Analytics</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <VendorStatCard label="Total Revenue" value={formatINR(r.totalRevenue)} icon="fa-wallet" color="emerald" />
        <VendorStatCard label="Total Bookings" value={r.totalBookings} icon="fa-receipt" color="blue" />
      </div>

      <div className="vm-bg-surface rounded-2xl border vm-border p-6 mb-6">
        <h3 className="text-lg font-bold mb-1 flex items-center gap-2">
          <i className="fas fa-chart-bar vm-accent-text" aria-hidden /> Monthly revenue from completed sales
        </h3>
        <p className="text-xs vm-text-muted mb-6">India months, from your first sale. The current month is still running.</p>
        {monthly.length === 0 ? (
          <p className="vm-text-muted text-sm text-center py-8">No completed sales yet</p>
        ) : (
          <div className="flex items-end justify-between gap-2 h-48">
            {monthly.map((m) => (
              <div key={m.month} className="flex-1 flex flex-col items-center gap-2 group">
                <div className="relative w-full flex-1 flex items-end">
                  <div
                    className={`w-full bg-gradient-to-t from-blue-600 to-cyan-400 rounded-t-lg transition-all duration-300 relative ${m.complete === false ? "opacity-60" : ""}`}
                    // The 2% floor keeps a zero-revenue month visible as a
                    // stub rather than an invisible column.
                    style={{ height: `${Math.max((m.revenue / maxRevenue) * 100, 2)}%` }}
                  >
                    <div className="absolute -top-7 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap text-[10px] font-bold vm-accent-text vm-bg-ground px-2 py-1 rounded">
                      {formatINR(m.revenue)}
                    </div>
                  </div>
                </div>
                <span className="text-[10px] vm-text-muted font-bold">{m.month}</span>
                <span className="text-[9px] vm-text-muted">
                  {m.bookings} sale{m.bookings === 1 ? "" : "s"}
                  {m.complete === false ? " · so far" : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <ForecastSection />

      <div className="vm-panel" style={{ padding: 22 }}>
        <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
          <i className="fas fa-gas-pump text-indigo-400" aria-hidden /> Station Performance
        </h3>
        <div className="w-full overflow-x-auto">
          <table className="vm-table">
            <thead>
              <tr>
                <th className="px-6 py-3 font-bold">Station</th>
                <th className="px-6 py-3 font-bold">Bookings</th>
                <th className="px-6 py-3 font-bold">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {(r.stationPerformance ?? []).map((s) => (
                <tr key={s.stationName}>
                  <td className="px-6 py-3 font-bold vm-text">{s.stationName}</td>
                  <td className="px-6 py-3 font-mono">{s.totalBookings}</td>
                  <td className="px-6 py-3 font-mono text-emerald-400">{formatINR(s.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/** Which lead time the reorder plan used, and the delivery evidence behind it. */
function LeadTimeNote({ lead }: { lead: NonNullable<VendorForecast["leadTime"]> }) {
  const m = lead.measured;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  let text: string;
  if (lead.basis === "measured") {
    text = `Lead time ${lead.usedDays} days: the median of ${plural(m.samples, "delivery")} recorded with an order date` +
      (lead.sdDays ? `, varying by about ±${lead.sdDays} days (included in safety stock)` : "") + ".";
  } else if (lead.basis === "entered") {
    text = `Lead time ${lead.usedDays} days, as entered.` +
      (m.ready ? ` Your recorded deliveries measure ${m.medianDays} days.` : "");
  } else {
    text = `Lead time ${lead.usedDays} days is an assumed default. ` +
      (m.samples > 0
        ? `${plural(m.samples, "delivery")} recorded with an order date so far; ${m.requiredSamples} are needed to measure it.`
        : "Record the order date with each delivery (Inventory tab) and it will be measured.");
  }

  return (
    <p className="text-xs vm-text-muted mt-3 border-t vm-border pt-2">
      {text}
      {m.deliveryIntervalMedianDays !== null &&
        ` Deliveries arrive about every ${m.deliveryIntervalMedianDays} days — that is how often you reorder, not lead time.`}
    </p>
  );
}

/**
 * Next month's demand for one station and fuel (GET .../forecast). Shows only
 * what the history supports: with too little of it, the reason and the
 * evidence instead of a number, and no reorder plan.
 */
function ForecastSection() {
  const stations = useVendorStore((s) => s.stations);
  const loadStations = useVendorStore((s) => s.loadStations);

  const [stationId, setStationId] = useState("");
  const [fuel, setFuel] = useState("petrol");
  // Blank = the server's measured lead time (or its labelled default).
  const [leadTime, setLeadTime] = useState("");
  const [serviceLevel, setServiceLevel] = useState(95);
  const [data, setData] = useState<VendorForecast | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (stations.length === 0) void loadStations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!stationId && stations.length > 0) setStationId(String(stations[0]._id));
  }, [stations, stationId]);

  const station = stations.find((s) => String(s._id) === stationId);
  const fuels = (station?.fuelTypes ?? []).map((f) => f.toLowerCase());

  useEffect(() => {
    if (fuels.length > 0 && !fuels.includes(fuel)) setFuel(fuels[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationId, fuels.join(",")]);

  const run = async (lead = leadTime) => {
    if (!stationId) return;
    setLoading(true);
    setError(null);
    try {
      const entered = lead.trim() === "" ? null : Number(lead);
      setData(
        await api.fetchVendorForecast(stationId, fuel, entered !== null && Number.isFinite(entered) ? entered : null, serviceLevel),
      );
    } catch (err) {
      setError(toApiError(err).msg);
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationId, fuel, serviceLevel]);

  const f = data?.forecast;
  const h = data?.history;
  const unit = data?.unit ?? "L";

  return (
    <div className="vm-panel" style={{ padding: 22, marginBottom: 24 }}>
      <h3 className="text-lg font-bold mb-1 flex items-center gap-2">
        <i className="fas fa-chart-line vm-accent-text" aria-hidden /> Demand forecast
      </h3>
      <p className="text-xs vm-text-muted mb-4">
        Next month's sales from your completed bookings. A forecast needs at least one complete month; accuracy can
        only be measured from three.
      </p>

      {stations.length === 0 ? (
        <p className="text-sm vm-text-muted">Add a station to see its forecast.</p>
      ) : (
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <label className="text-xs vm-text-muted">
            Station
            <select
              className="block vm-input px-3 py-1.5 text-sm vm-text mt-1"
              value={stationId}
              onChange={(e) => setStationId(e.target.value)}
            >
              {stations.map((s) => (
                <option key={String(s._id)} value={String(s._id)}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs vm-text-muted">
            Fuel
            <select
              className="block vm-input px-3 py-1.5 text-sm vm-text mt-1"
              value={fuel}
              onChange={(e) => setFuel(e.target.value)}
            >
              {fuels.map((x) => (
                <option key={x} value={x}>
                  {x === "cng" ? "CNG" : x.charAt(0).toUpperCase() + x.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs vm-text-muted">
            Delivery lead time (days)
            <input
              type="number"
              min="0"
              max="30"
              placeholder="Measured"
              title="Leave blank to use the lead time measured from your recorded deliveries"
              className="block vm-input px-3 py-1.5 text-sm vm-text mt-1 w-28"
              value={leadTime}
              onChange={(e) => setLeadTime(e.target.value)}
            />
          </label>
          <label className="text-xs vm-text-muted">
            Service level
            <select
              className="block vm-input px-3 py-1.5 text-sm vm-text mt-1"
              value={serviceLevel}
              onChange={(e) => setServiceLevel(Number(e.target.value))}
              title="Chance of not running out while a delivery is on its way"
            >
              {api.SERVICE_LEVELS.map((sl) => (
                <option key={sl} value={sl}>
                  {sl}%
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="vm-bg-surface vm-hover border vm-border vm-text font-bold py-1.5 px-3 rounded-lg text-sm"
            onClick={() => void run()}
            disabled={loading}
          >
            <i className={`fas fa-rotate ${loading ? "fa-spin" : ""}`} aria-hidden /> Update
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      {f && h && (
        <div className="space-y-4">
          {f.ready ? (
            <div className="flex flex-wrap items-baseline gap-4">
              <span className="text-3xl font-bold">
                {f.value} {unit}
              </span>
              <span className="text-sm vm-text-muted">for {f.forMonth}</span>
              <span className={`text-sm font-bold ${RELIABILITY_STYLE[f.reliability]}`}>
                {f.errorPercent !== null ? `±${f.errorPercent}% typical error (${f.reliability})` : "accuracy not measurable yet"}
              </span>
              <span className="text-xs vm-text-muted">{METHOD_LABEL[f.method] ?? f.method}</span>
            </div>
          ) : (
            <div className="vm-bg-ground rounded-xl border vm-border p-4">
              <p className="font-bold">No forecast yet</p>
              <p className="text-sm vm-text-muted mt-1">{f.reason}</p>
              {f.runRate && (
                <p className="text-sm mt-2">
                  Current run rate: {f.runRate.value} {unit} next month{" "}
                  <span className="vm-text-muted">({f.runRate.basis})</span>
                </p>
              )}
            </div>
          )}

          {f.note && <p className="text-xs vm-text-muted">{f.note}</p>}

          <p className="text-xs vm-text-muted">
            Based on {h.totalBookings} completed {h.basis === "customer-sales" ? "customer " : ""}sale
            {h.totalBookings === 1 ? "" : "s"} ({h.totalQuantity} {unit}) over {h.daysObserved} day
            {h.daysObserved === 1 ? "" : "s"}
            {(h.excludedBookings ?? 0) > 0 &&
              ` — ${h.excludedBookings} booked by vendor or admin accounts ${h.excludedBookings === 1 ? "is" : "are"} not counted as demand`}
            .
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="vm-bg-ground rounded-xl border vm-border p-4">
              <p className="text-xs font-bold uppercase tracking-wider vm-text-muted mb-2">Reorder plan</p>
              {data.reorder.ready ? (
                <>
                  <dl className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <dt className="vm-text-muted">Daily demand</dt>
                      <dd>
                        {data.reorder.dailyDemand} {unit} ± {data.reorder.dailyStdDev}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="vm-text-muted">Demand during {data.reorder.leadTimeDays}-day delivery</dt>
                      <dd>
                        {data.reorder.leadTimeDemand} {unit}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="vm-text-muted">Safety stock ({data.reorder.serviceLevel}% service level)</dt>
                      <dd>
                        {data.reorder.safetyStock} {unit}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="vm-text-muted">Reorder point</dt>
                      <dd>
                        {data.reorder.reorderPoint} {unit}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="vm-text-muted">Stock not held for bookings</dt>
                      <dd>
                        {data.reorder.available} {unit}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="vm-text-muted">Days of cover</dt>
                      <dd>{data.reorder.daysOfCover}</dd>
                    </div>
                    <div className="flex justify-between font-bold">
                      <dt>{data.reorder.shouldReorder ? "Order now" : "Suggested order"}</dt>
                      <dd className={data.reorder.shouldReorder ? "text-red-400" : ""}>
                        {data.reorder.suggestedQty} {unit}
                      </dd>
                    </div>
                  </dl>
                  <p className="text-xs vm-text-muted mt-2">
                    From {data.reorder.sampleDays} complete days of customer sales. Covers{" "}
                    {data.reorder.cycleBasis === "forecast" ? "next month's forecast" : "the daily average over next month"}{" "}
                    plus safety stock. Safety stock = {data.reorder.z} × daily variation × √lead time
                    {(data.reorder.variability ?? 0) > 1 ? "; demand is very erratic, so treat it as rough" : ""}.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm vm-text-muted">{data.reorder.reason}</p>
                  {data.reorder.sampleDays > 0 && (
                    <div className="mt-2 h-1.5 vm-bg-surface rounded-full overflow-hidden" aria-hidden>
                      <div
                        className="h-full bg-blue-500 rounded-full"
                        style={{ width: `${Math.min(100, (data.reorder.sampleDays / data.reorder.requiredDays) * 100)}%` }}
                      />
                    </div>
                  )}
                </>
              )}
              {data.leadTime && <LeadTimeNote lead={data.leadTime} />}
            </div>

            <div className="vm-bg-ground rounded-xl border vm-border p-4">
              <p className="text-xs font-bold uppercase tracking-wider vm-text-muted mb-2">Sales by month</p>
              {h.months.length === 0 ? (
                <p className="text-sm vm-text-muted">No completed sales of this fuel yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {h.months.map((m) => (
                      <tr key={m.month} className="border-t vm-border first:border-t-0">
                        <td className="py-1">{m.month}</td>
                        <td className="py-1 text-right font-mono">
                          {m.quantity} {unit}
                        </td>
                        <td className="py-1 text-right text-xs vm-text-muted">{m.complete ? "" : "so far"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
