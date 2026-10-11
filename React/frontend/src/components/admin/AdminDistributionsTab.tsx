import { useCallback, useEffect, useState } from "react";
import { fetchDistributions, type Distributions } from "@/services/api/adminApi";
import { toApiError } from "@/services/api/apiClient";
import { ChartCard, Heatmap, Histogram } from "./charts/Charts";
import Loader from "@/components/common/Loader";
import StatCard from "@/components/common/StatCard";

/**
 * Distributions: the three questions a total cannot answer.
 *
 *   "The average wait is 6 minutes"   — but is that everyone, or most people
 *                                       waiting two and a few waiting twenty?
 *   "We sold 4,200 litres"            — in what size of fill?
 *   "We take 300 bookings a week"     — when?
 *
 * Each panel is a count of real booking rows, and each refuses to draw a
 * shape from too few of them. A histogram of nine readings looks exactly as
 * confident as one of nine thousand, and acting on the first is how a
 * dashboard does harm.
 *
 * Every figure comes from GET /api/v1/admin/distributions.
 */

const PERIODS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

/** 14 -> "2p", 9 -> "9a". Short enough for a 22px heatmap column. */
const shortHour = (hour: number) => {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${hour < 12 ? "a" : "p"}`;
};

export default function AdminDistributionsTab({
  load: loader = fetchDistributions,
  scopeNote,
}: {
  /**
   * Where the figures come from. Defaults to the admin endpoint; the vendor
   * console passes its own, which returns the identical shape scoped to that
   * vendor's stations. One screen, two audiences -- rather than a second
   * copy that drifts.
   */
  load?: (days: number) => Promise<Distributions>;
  /** One line saying whose data this is. */
  scopeNote?: string;
} = {}) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Distributions | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (period: number) => {
    setState("loading");
    try {
      setData(await loader(period));
      setState("ready");
    } catch (err) {
      setError(toApiError(err).msg || "Could not load the distributions.");
      setState("error");
    }
  }, [loader]);

  useEffect(() => {
    void load(days);
  }, [load, days]);

  if (state === "loading") return <Loader label="Reading the bookings…" />;

  if (state === "error" || !data) {
    return (
      <div className="py-8">
        <p className="text-sm vm-text-muted mb-3" role="alert">
          <i className="fas fa-triangle-exclamation mr-2" aria-hidden /> {error}
        </p>
        <button type="button" className="vm-btn vm-btn-primary" onClick={() => void load(days)}>
          Try again
        </button>
      </div>
    );
  }

  const { waiting, quantities, demand } = data;

  return (
    <>
      <div className="flex items-start justify-between gap-4 mb-2 flex-wrap">
        <h2 className="text-2xl font-bold">Distributions</h2>
        <div className="flex gap-1" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p.days}
              type="button"
              className={`vm-btn ${days === p.days ? "vm-btn-primary" : "vm-btn-ghost"}`}
              onClick={() => setDays(p.days)}
              aria-pressed={days === p.days}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs vm-text-muted mb-6">
        {scopeNote ?? "What the averages hide."} Every bar is a count of real bookings over the last {data.days}{" "}
        days.
      </p>

      {/* ---- waiting time ---- */}
      {waiting.total > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          <StatCard label="Median wait" value={`${waiting.median} min`} icon="fa-hourglass-half" tone="primary" hint="half of customers waited less" />
          <StatCard
            label="9 in 10 waited under"
            value={`${waiting.p90} min`}
            icon="fa-user-clock"
            tone={(waiting.p90 ?? 0) > 15 ? "warn" : "good"}
            hint="the experience at the tail, not the average"
          />
          <StatCard label="Longest wait" value={`${waiting.longest} min`} icon="fa-triangle-exclamation" tone="warn" hint="one customer's worst visit" />
        </div>
      )}

      <div className="mb-4">
        <ChartCard
          title="How long people waited at the pump"
          icon="fa-hourglass-half"
          subtitle="From check-in to the nozzle starting — measured, not estimated."
          testId="dist-waiting"
        >
          <Histogram
            buckets={waiting.buckets}
            total={waiting.total}
            unitLabel="waits"
            colour="var(--chart-1)"
            ariaLabel="Waiting time distribution"
          />
        </ChartCard>
      </div>

      {/* ---- fill sizes ---- */}
      {quantities.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          {quantities.map((q) => (
            <ChartCard
              key={q.fuel}
              title={`${q.fuel}: how much people buy`}
              icon="fa-gas-pump"
              subtitle={`Completed fills, in ${q.unit}. Average ${q.average} ${q.unit}.`}
              testId={`dist-quantity-${q.fuel.toLowerCase()}`}
            >
              <Histogram
                buckets={q.buckets}
                total={q.total}
                unitLabel="fills"
                colour={
                  q.fuel.toLowerCase() === "cng"
                    ? "var(--fuel-cng)"
                    : q.fuel.toLowerCase() === "diesel"
                      ? "var(--fuel-diesel)"
                      : "var(--fuel-petrol)"
                }
                ariaLabel={`${q.fuel} fill size distribution`}
              />
            </ChartCard>
          ))}
        </div>
      )}

      {/* ---- when they book ---- */}
      <ChartCard
        title="When people book"
        icon="fa-calendar-week"
        subtitle="Bookings by day and hour, in India time."
        note={demand.busiest ? `Busiest: ${demand.busiest.day} ${shortHour(demand.busiest.hour)}` : undefined}
        testId="dist-demand"
      >
        <Heatmap
          cells={demand.cells.map((c) => ({ row: c.day, column: c.hour, count: c.count }))}
          rows={demand.days}
          columns={demand.hours}
          formatColumn={shortHour}
          ariaLabel="Bookings by day of week and hour of day"
          emptyNote="No bookings in this period yet."
        />
      </ChartCard>
    </>
  );
}
