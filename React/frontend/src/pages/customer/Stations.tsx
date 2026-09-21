import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Layout from "@/components/layout/Layout";
import EmptyState from "@/components/common/EmptyState";
import Loader from "@/components/common/Loader";
import ErrorMessage from "@/components/common/ErrorMessage";
import StationCard from "@/components/station/StationCard";
import FuelIcon from "@/components/station/FuelIcon";
import StationsMap from "@/components/maps/StationsMap";
import { useStationStore } from "@/store/stationStore";
import { useWatchStations } from "@/hooks/useSocket";
import { getLastKnownUserCoords } from "@/utils/geo";
import { queueLevelOf } from "@/utils/format";

// Each fuel has its own icon (components/station/FuelIcon.tsx).
const FILTERS = [
  ["all", "All Stations"],
  ["petrol", "Petrol"],
  ["diesel", "Diesel"],
  ["cng", "CNG"],
] as const;

const FUEL_NAME = { petrol: "Petrol", diesel: "Diesel", cng: "CNG" } as const;

const SORTS = [
  ["distance", "Nearest first"],
  ["wait", "Shortest wait"],
  ["price", "Lowest price"],
] as const;
type SortKey = (typeof SORTS)[number][0];

/**
 * Find stations: a list beside a map, the pattern people already know from
 * maps and ride apps.
 *
 * The fuel filter semantics are the Vanilla ones exactly ("cng" keeps
 * stations whose fuelTypes include CNG, "petrol" those including Petrol),
 * filtered client-side so switching stays instant. The search box in the top
 * bar narrows the same list by name or address through ?q=, and the sort only
 * re-orders what is already loaded.
 *
 * The map reads the SAME filtered array as the list, so a marker and a card
 * can never disagree about what is being shown.
 */
export default function Stations() {
  const stations = useStationStore((s) => s.stations);
  const loading = useStationStore((s) => s.loading);
  const error = useStationStore((s) => s.error);
  const filter = useStationStore((s) => s.filter);
  const setFilter = useStationStore((s) => s.setFilter);
  const load = useStationStore((s) => s.load);

  const [params, setParams] = useSearchParams();
  const rawQuery = params.get("q") ?? "";
  const query = rawQuery.trim().toLowerCase();
  const [sort, setSort] = useState<SortKey>("distance");
  // Toggles on top of the fuel filter: only open stations, only short queues.
  const [openOnly, setOpenOnly] = useState(false);
  const [lowQueueOnly, setLowQueueOnly] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    let list = stations;
    if (filter !== "all") {
      const want = FUEL_NAME[filter];
      list = list.filter((s) => s.fuelTypes.includes(want));
    }
    if (openOnly) list = list.filter((s) => s.open);
    if (lowQueueOnly) list = list.filter((s) => queueLevelOf(s.queueStatus) === "low");
    if (query) {
      list = list.filter((s) => `${s.name} ${s.address} ${s.city ?? ""}`.toLowerCase().includes(query));
    }

    const priceKey = filter === "all" ? "Petrol" : FUEL_NAME[filter];
    const sorted = [...list];
    if (sort === "distance") {
      sorted.sort(
        (a, b) => (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY),
      );
    } else if (sort === "wait") {
      sorted.sort((a, b) => a.waitTime - b.waitTime);
    } else {
      // Unpriced stations sort last, not first.
      sorted.sort((a, b) => (a.uiPrices[priceKey] ?? Infinity) - (b.uiPrices[priceKey] ?? Infinity));
    }
    return sorted;
  }, [stations, filter, query, sort, openOnly, lowQueueOnly]);

  // Join every listed station's room, so a vendor's price change updates
  // these cards live. Watching the full list rather than the filtered one
  // keeps a card correct the moment a filter brings it back into view.
  useWatchStations(useMemo(() => stations.map((s) => s.id), [stations]));

  const openCount = visible.filter((s) => s.open).length;
  const hasDistance = stations.some((s) => s.distance != null);
  const clearSearch = () => setParams({}, { replace: true });

  return (
    <Layout>
      <div className="cx-page-head">
        <div className="min-w-0">
          <h1 className="cx-title">Find fuel stations</h1>
          <p className="cx-subtitle">
            {visible.length} of {stations.length} stations · {openCount} open now
            <span className="cx-live">Live queues</span>
          </p>
        </div>
      </div>

      <div className="cx-toolbar">
        <div className="flex gap-2 overflow-x-auto pb-0.5" role="group" aria-label="Fuel type">
          {FILTERS.map(([val, label]) => (
            <button
              key={val}
              type="button"
              className={`cx-chip cx-fuel-chip ${filter === val ? "is-on" : ""}`}
              aria-pressed={filter === val}
              onClick={() => setFilter(val)}
            >
              <span className={`cx-fuel-ico is-${val}`} aria-hidden>
                <FuelIcon kind={val} size={val === "cng" ? 26 : 24} />
              </span>
              {label}
            </button>
          ))}
          <span className="w-px self-stretch" style={{ background: "var(--border)" }} aria-hidden />
          <button
            type="button"
            className={`cx-chip ${openOnly ? "is-on" : ""}`}
            aria-pressed={openOnly}
            onClick={() => setOpenOnly((v) => !v)}
          >
            <i className="fas fa-door-open" aria-hidden /> Open now
          </button>
          <button
            type="button"
            className={`cx-chip ${lowQueueOnly ? "is-on" : ""}`}
            aria-pressed={lowQueueOnly}
            onClick={() => setLowQueueOnly((v) => !v)}
          >
            <i className="fas fa-person-walking" aria-hidden /> Low queue
          </button>
        </div>

        {query && (
          <span className="cx-chip is-on">
            <i className="fas fa-magnifying-glass" aria-hidden /> “{rawQuery.trim()}”
            <button type="button" onClick={clearSearch} aria-label="Clear search">
              <i className="fas fa-xmark" aria-hidden />
            </button>
          </span>
        )}

        <label className="ml-auto flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
          Sort
          <select className="cx-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {SORTS.map(([val, label]) => (
              <option key={val} value={val}>
                {val === "distance" && !hasDistance ? `${label} (set location)` : label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorMessage message={error} onRetry={() => void load()} />
        </div>
      )}

      <div className="grid gap-5 items-start lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.85fr)]">
        <div className="order-2 lg:order-1 space-y-3 min-w-0">
          {loading && stations.length === 0 ? (
            <section className="cx-panel">
              <Loader label="Loading stations…" />
            </section>
          ) : visible.length === 0 ? (
            <section className="cx-panel">
              <EmptyState
                icon="fa-map-location-dot"
                title={query ? `No stations match “${rawQuery.trim()}”` : "No stations match this filter"}
                subtitle={query ? "Try another name or area." : "Try a different fuel type or check all stations."}
                action={
                  query ? (
                    <button className="btn btn-outline btn-sm" onClick={clearSearch}>
                      Clear search
                    </button>
                  ) : (
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => {
                        setFilter("all");
                        setOpenOnly(false);
                        setLowQueueOnly(false);
                      }}
                    >
                      Show All Stations
                    </button>
                  )
                }
              />
            </section>
          ) : (
            visible.map((s, i) => <StationCard key={s.id} station={s} index={i} />)
          )}
        </div>

        <div className="order-1 lg:order-2 lg:sticky lg:top-[88px]">
          <StationsMap
            stations={visible}
            className="h-[240px] sm:h-[300px] lg:h-[calc(100vh-140px)] lg:min-h-[420px]"
            userCoords={getLastKnownUserCoords()}
          />
          <p className="text-[11px] mt-2 hidden lg:flex items-center gap-1.5" style={{ color: "var(--muted)" }}>
            <i className="fas fa-circle-info" aria-hidden /> Red pins are open, grey are closed. Select a pin
            for station details.
          </p>
        </div>
      </div>
    </Layout>
  );
}
