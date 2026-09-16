import { useCallback, useEffect, useState } from "react";
import * as api from "@/services/api/adminApi";
import type { AdminAnalytics } from "@/services/api/adminApi";
import { toApiError } from "@/services/api/apiClient";
import { ConsoleLoading } from "@/components/console/ConsoleBits";
import { formatINR } from "@/utils/vendorFormat";

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

/**
 * Network-wide forecasting (GET /api/v1/admin/analytics).
 *
 * The forecast is next month's revenue from customer sales, gated on how much
 * history exists (backend services/algorithms/forecast.js): with too little, the reason
 * and the evidence are shown instead of a number. The sales tables below are
 * every completed sale, as money actually collected.
 */
export default function AdminForecastTab() {
  const [months, setMonths] = useState(6);
  const [data, setData] = useState<AdminAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.fetchAdminAnalytics(months));
    } catch (err) {
      setError(toApiError(err).msg);
    } finally {
      setLoading(false);
    }
  }, [months]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !data) {
    return (
      <div className="vm-panel" style={{ padding: 22 }}>
        <p className="text-red-400 font-bold">Could not load forecasting</p>
        <p className="vm-text-muted text-sm mt-1">{error}</p>
        <button type="button" className="vm-link mt-3" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }
  if (!data) return <ConsoleLoading label="Loading forecasting..." />;

  const f = data.forecast;
  const h = data.history;
  const maxRevenue = Math.max(...data.monthlyRevenue.map((m) => m.revenue), 1);

  return (
    <div className="space-y-6">
      <section className="vm-panel" style={{ padding: 22, marginBottom: 0 }}>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <i className="fas fa-chart-line vm-accent-text" aria-hidden /> Next month's revenue
            {f.forMonth ? <span className="vm-text-muted font-normal text-sm">({f.forMonth})</span> : null}
          </h3>
          <span className="vm-text-muted text-xs">
            {METHOD_LABEL[f.method] ?? f.method} · {f.completeMonths} complete month{f.completeMonths === 1 ? "" : "s"}
          </span>
        </div>

        {f.ready ? (
          <div className="flex flex-wrap items-baseline gap-4">
            <span className="text-3xl font-bold">{formatINR(f.value ?? 0)}</span>
            <span className={`text-sm font-bold ${RELIABILITY_STYLE[f.reliability]}`}>
              {f.errorPercent !== null ? `±${f.errorPercent}% typical error (${f.reliability})` : "accuracy not measurable yet"}
            </span>
          </div>
        ) : (
          <div className="vm-bg-ground rounded-xl border vm-border p-4">
            <p className="font-bold">No forecast yet</p>
            <p className="text-sm vm-text-muted mt-1">{f.reason}</p>
            {f.runRate && (
              <p className="text-sm mt-2">
                Current run rate: {formatINR(f.runRate.value)} next month{" "}
                <span className="vm-text-muted">({f.runRate.basis})</span>
              </p>
            )}
          </div>
        )}

        {f.note && <p className="text-xs vm-text-muted mt-3">{f.note}</p>}
        <p className="text-xs vm-text-muted mt-2">
          Forecast based on {h.totalBookings} completed {h.basis === "customer-sales" ? "customer " : ""}sale
          {h.totalBookings === 1 ? "" : "s"} over {h.daysObserved} day{h.daysObserved === 1 ? "" : "s"}
          {(h.excludedBookings ?? 0) > 0 &&
            ` — ${h.excludedBookings} booked by vendor or admin accounts ${h.excludedBookings === 1 ? "is" : "are"} not counted as demand`}
          . A forecast needs one complete month; accuracy is measured from three, and a trend is estimated from six.
        </p>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="vm-panel" style={{ padding: 22, marginBottom: 0 }}>
          <div className="flex items-center justify-between gap-3 mb-4">
            <h3 className="text-lg font-bold">Revenue by month</h3>
            <select
              className="vm-input px-3 py-1.5 text-sm vm-text"
              value={months}
              onChange={(e) => setMonths(Number(e.target.value))}
              aria-label="Months shown"
              disabled={loading}
            >
              {[3, 6, 12, 24].map((n) => (
                <option key={n} value={n}>
                  Last {n} months
                </option>
              ))}
            </select>
          </div>
          {data.monthlyRevenue.length === 0 ? (
            <p className="vm-text-muted text-sm">No completed sales yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {data.monthlyRevenue.map((m) => (
                  <tr key={m.month} className="border-t vm-border first:border-t-0">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {m.month}
                      {!m.complete && <span className="vm-text-muted text-xs"> · so far</span>}
                    </td>
                    <td className="py-2 pr-3 w-1/2">
                      <div className="h-2 vm-bg-ground rounded-full overflow-hidden">
                        <div
                          className={`h-full bg-blue-500 rounded-full ${m.complete ? "" : "opacity-60"}`}
                          style={{ width: `${Math.max((m.revenue / maxRevenue) * 100, 2)}%` }}
                        />
                      </div>
                    </td>
                    <td className="py-2 text-right font-mono whitespace-nowrap">{formatINR(m.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-xs vm-text-muted mt-3">Every completed sale, India months, from the first sale.</p>
        </section>

        <section className="vm-panel" style={{ padding: 22, marginBottom: 0 }}>
          <h3 className="text-lg font-bold mb-4">Completed sales by fuel</h3>
          {data.byFuel.length === 0 ? (
            <p className="vm-text-muted text-sm">No completed sales yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="vm-text-muted text-left text-xs uppercase">
                  <th className="py-2 pr-3">Fuel</th>
                  <th className="py-2 pr-3 text-right">Volume</th>
                  <th className="py-2 pr-3 text-right">Sales</th>
                  <th className="py-2 text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {data.byFuel.map((row) => (
                  <tr key={row.fuelType} className="border-t vm-border">
                    <td className="py-2 pr-3 font-bold">{row.fuelType}</td>
                    <td className="py-2 pr-3 text-right font-mono">
                      {row.volume} {row.fuelType === "CNG" ? "kg" : "L"}
                    </td>
                    <td className="py-2 pr-3 text-right">{row.bookings}</td>
                    <td className="py-2 text-right font-mono">{formatINR(row.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
