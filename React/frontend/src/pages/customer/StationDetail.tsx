import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { UiStation } from "@/types";
import Layout from "@/components/layout/Layout";
import Loader from "@/components/common/Loader";
import ErrorMessage from "@/components/common/ErrorMessage";
import StationsMap from "@/components/maps/StationsMap";
import { useStationStore } from "@/store/stationStore";
import { useWatchStation } from "@/hooks/useSocket";
import { fetchStationById } from "@/services/api/stationApi";
import { queueLevelOf } from "@/utils/format";
import { directionsUrl } from "@/utils/navigation";
import { distanceNote } from "@/utils/distanceNote";

const AMENITY_ICONS: Record<string, string> = {
  ATM: "credit-card",
  "Air Fill": "wind",
  Restroom: "restroom",
  Cafe: "coffee",
  "Car Wash": "car",
  Water: "tint",
  Dhaba: "utensils",
};

const FUEL_ICON: Record<string, string> = { CNG: "fire", Diesel: "oil-can", Petrol: "droplet" };
const FUEL_TONE: Record<string, string> = { CNG: "cx-tone-green", Diesel: "cx-tone-amber", Petrol: "cx-tone-blue" };

/**
 * One station: who it is, how busy it is right now, what it costs, and the
 * way to book or get there.
 *
 * The id comes from the URL and the station is fetched when the list has not
 * been loaded yet, so /stations/:id is a real, shareable address.
 *
 * useWatchStation joins this station's socket room while the page is open, so
 * a price or queue change from the vendor lands here live.
 *
 * Tapping a fuel price books that fuel directly; the booking page already
 * accepts ?fuelType=, so this skips a step without changing the flow.
 */
export default function StationDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const fromStore = useStationStore((s) => s.stations.find((x) => x.id === id));
  const [fetched, setFetched] = useState<UiStation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useWatchStation(id);

  // Always ask the server when the page opens -- even when the station is
  // already in the list store, which may have been loaded earlier. The result
  // goes INTO the store, so this page, the list and the dashboard all show the
  // same, current station, and later socket events keep patching it.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchStationById(id)
      .then((fresh) => {
        if (cancelled || !fresh) return;
        const store = useStationStore.getState();
        if (store.stations.some((x) => x.id === fresh.id)) store.patchStation(fresh);
        else if (!store.addStation(fresh as unknown as Parameters<typeof store.addStation>[0])) setFetched(fresh);
      })
      .catch(() => {
        // A station already on screen stays; only a page with nothing to show errors.
        if (!cancelled && !useStationStore.getState().stations.some((x) => x.id === id)) {
          setError("Could not load this station.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const s = fromStore ?? fetched;

  if (error) {
    return (
      <Layout>
        <div className="max-w-xl mx-auto pt-6">
          <ErrorMessage message={error} onRetry={() => navigate("/stations")} />
        </div>
      </Layout>
    );
  }
  if (!s) {
    return (
      <Layout>
        <Loader label="Loading station…" />
      </Layout>
    );
  }

  const level = queueLevelOf(s.queueStatus);
  const queueText = level === "high" ? "High" : level === "medium" ? "Moderate" : "Low";
  const token = level === "low" ? "good" : level === "medium" ? "warn" : "bad";
  const directions = directionsUrl(s.lat, s.lng);
  const book = (fuel?: string) =>
    navigate(`/booking?stationId=${s.id}${fuel ? `&fuelType=${encodeURIComponent(fuel)}` : ""}`);
  const amenities = s.amenities ?? [];

  return (
    <Layout>
      <button type="button" className="cx-back" onClick={() => navigate("/stations")}>
        <i className="fas fa-arrow-left" aria-hidden /> Back to stations
      </button>

      <section className="cx-panel mb-5">
        <div
          className={`cx-detail-cover ${s.image ? "has-image" : ""} ${s.open ? "" : "is-closed"}`}
          style={s.image ? { backgroundImage: `url('${s.image}')` } : undefined}
        />
        <div className="cx-panel-body flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <div
              className={`cx-thumb ${s.open ? "" : "is-closed"}`}
              style={{ width: 72, height: 72, marginTop: 0, border: "4px solid var(--card)", background: "var(--card)" }}
            >
              <span className="cx-stat-icon cx-tone-blue" style={{ width: "100%", height: "100%", borderRadius: 8, fontSize: 22 }}>
                <i className="fas fa-gas-pump" aria-hidden />
              </span>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="cx-title">{s.name}</h1>
                <span className={`cx-tag ${s.open ? "is-green" : "is-red"}`}>{s.open ? "Open now" : "Closed"}</span>
              </div>
              <p className="cx-subtitle">
                <i className="fas fa-location-dot" aria-hidden /> {s.address}
              </p>
              <div className="cx-meta mt-2">
                <span>
                  <i className="fas fa-clock" aria-hidden /> {s.hours}
                </span>
                <span className="cx-live">Live</span>
              </div>
            </div>
          </div>
          <div className="cx-actions">
            {directions && (
              <a className="btn btn-outline" href={directions} target="_blank" rel="noopener noreferrer">
                <i className="fas fa-diamond-turn-right" aria-hidden /> Directions
              </a>
            )}
            <button type="button" className="btn btn-primary" onClick={() => book()} disabled={!s.open}>
              <i className="fas fa-calendar-check" aria-hidden /> {s.open ? "Book Fuel Slot" : "Station Closed"}
            </button>
          </div>
        </div>
      </section>

      <div className="grid gap-5 items-start lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5 min-w-0">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div className="cx-metric">
              <p className="cx-metric-label">
                <i className="fas fa-route" aria-hidden /> Distance
              </p>
              <p className="cx-metric-value">
                {s.distance != null ? (
                  <>
                    {s.distance}
                    <small>km</small>
                    {distanceNote(s) && <span className="block text-[11px] text-[var(--muted)] font-normal">{distanceNote(s)}</span>}
                  </>
                ) : (
                  "—"
                )}
              </p>
            </div>
            <div className="cx-metric">
              <p className="cx-metric-label">
                <i className="fas fa-users" aria-hidden /> Live queue
              </p>
              <p className="cx-metric-value">
                {s.queue}
                <small>vehicles</small>
              </p>
            </div>
            <div className="cx-metric">
              <p className="cx-metric-label">
                <i className="fas fa-hourglass-half" aria-hidden /> Est. wait
              </p>
              <p className="cx-metric-value" style={{ color: `var(--status-${token})` }}>
                {s.waitTime}
                <small>min</small>
              </p>
            </div>
          </div>

          <section className="cx-panel">
            <div className="cx-panel-head">
              <h2 className="cx-panel-title">
                <i className="fas fa-tags" aria-hidden /> Fuel prices
              </h2>
              {s.open && (
                <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                  Select a fuel to book it
                </span>
              )}
            </div>
            <div
              className="cx-panel-body grid gap-3"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}
            >
              {s.fuelTypes.map((f) => (
                <button
                  key={f}
                  type="button"
                  className="cx-option flex items-center gap-3 text-left"
                  onClick={() => book(f)}
                  disabled={!s.open}
                  aria-label={`Book ${f}`}
                >
                  <span className={`cx-stat-icon ${FUEL_TONE[f] ?? "cx-tone-blue"}`}>
                    <i className={`fas fa-${FUEL_ICON[f] ?? "droplet"}`} aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="cx-option-sub block">{f}</span>
                    <span className="cx-row-name block" style={{ fontSize: 17 }}>
                      ₹{s.uiPrices[f as keyof typeof s.uiPrices] ?? "—"}
                    </span>
                    <span className="cx-option-sub block">per {f === "CNG" ? "kg" : "litre"}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="cx-panel">
            <div className="cx-panel-head">
              <h2 className="cx-panel-title">
                <i className="fas fa-bell-concierge" aria-hidden /> Amenities
              </h2>
            </div>
            <div className="cx-panel-body flex flex-wrap gap-2">
              {amenities.length === 0 ? (
                <p className="text-sm" style={{ color: "var(--muted)" }}>
                  No amenities listed.
                </p>
              ) : (
                amenities.map((a) => (
                  <span className="cx-chip" key={a} style={{ cursor: "default" }}>
                    <i className={`fas fa-${AMENITY_ICONS[a] ?? "parking"}`} style={{ color: "var(--primary)" }} aria-hidden />
                    {a}
                  </span>
                ))
              )}
            </div>
          </section>

          {directions && (
            <section className="cx-panel">
              <div className="cx-panel-head">
                <h2 className="cx-panel-title">
                  <i className="fas fa-map-pin" aria-hidden /> Location
                </h2>
                {directions && (
                  <a className="cx-link" href={directions} target="_blank" rel="noopener noreferrer">
                    Open in Google Maps <i className="fas fa-arrow-up-right-from-square" aria-hidden />
                  </a>
                )}
              </div>
              <StationsMap stations={[s]} className="relative h-[260px]" />
            </section>
          )}
        </div>

        <aside className="cx-panel lg:sticky lg:top-[88px]" aria-label="Reserve a slot">
          <div className="cx-panel-head">
            <h2 className="cx-panel-title">
              <i className="fas fa-calendar-check" aria-hidden /> Reserve your slot
            </h2>
          </div>
          <div className="cx-panel-body">
            <div className={`cx-status-banner t-${token}`}>
              <span className="cx-stat-icon">
                <i className="fas fa-users" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="cx-status-title">{queueText} queue right now</p>
                <p className="cx-status-sub">
                  {s.queue} vehicle{s.queue === 1 ? "" : "s"} ahead · about {s.waitTime} min
                </p>
              </div>
            </div>

            <dl className="cx-facts mt-4">
              <div className="cx-fact">
                <dt>Hours</dt>
                <dd>{s.hours}</dd>
              </div>
              <div className="cx-fact">
                <dt>Fuels</dt>
                <dd>{s.fuelTypes.join(", ")}</dd>
              </div>
              <div className="cx-fact">
                <dt>Distance</dt>
                <dd className={s.distance != null ? "" : "is-empty"}>
                  {s.distance != null ? `${s.distance} km${distanceNote(s) ? ` (${distanceNote(s)})` : ""}` : "Set your location"}
                </dd>
              </div>
            </dl>
            <hr className="cx-split" />

            <div className="space-y-2">
              <button type="button" className="btn btn-primary btn-block btn-lg" onClick={() => book()} disabled={!s.open}>
                <i className="fas fa-calendar-check" aria-hidden /> {s.open ? "Book Fuel Slot" : "Station Closed"}
              </button>
              {directions && (
                <a className="btn btn-outline btn-block" href={directions} target="_blank" rel="noopener noreferrer">
                  <i className="fas fa-diamond-turn-right" aria-hidden /> Get Directions
                </a>
              )}
            </div>
            <p className="text-[11px] mt-3" style={{ color: "var(--muted)" }}>
              Booking reserves the nozzle for your slot. Pay online or at the pump.
            </p>
          </div>
        </aside>
      </div>
    </Layout>
  );
}
