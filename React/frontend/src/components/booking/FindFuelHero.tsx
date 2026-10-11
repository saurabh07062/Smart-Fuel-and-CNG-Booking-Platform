import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useBookingMode } from "@/hooks/useBookingMode";
import type { UiStation } from "@/types";
import LocationPicker from "@/components/maps/LocationPicker";
import { useLocationStore } from "@/store/locationStore";
import { pushToast } from "@/store/toastStore";
import { fetchPlaceName } from "@/services/api/stationApi";
import { directionsUrl } from "@/utils/navigation";
import { getFreshUserCoords } from "@/utils/geo";
import { pumpsFor, type FuelKey } from "@/utils/fuelPumps";

export const FUEL_LOOK: Record<FuelKey, { icon: string; tint: string; unit: string }> = {
  Petrol: { icon: "fa-gas-pump", tint: "#22c55e", unit: "/L" },
  Diesel: { icon: "fa-oil-can", tint: "#3b82f6", unit: "/L" },
  CNG: { icon: "fa-fire-flame-simple", tint: "#a855f7", unit: "/kg" },
};

interface Props {
  /** The fuel the dashboard is currently showing pumps for. */
  fuel: FuelKey;
  onFuel: (fuel: FuelKey) => void;
  /** Stations with a distance from the customer, nearest first. */
  stations: UiStation[];
}

/**
 * The top of the customer dashboard: where you are, and what you are filling.
 *
 * Two plain steps, in the order a customer takes them -- set the location
 * once, then pick the fuel -- with the answer to each shown next to it: the
 * detected place, the nearest station it found, and each fuel's live price.
 * Everything below the fold (the station list) reacts to the fuel chosen
 * here, so there is one selection on the page rather than one per card.
 */
export default function FindFuelHero({ fuel, onFuel, stations }: Props) {
  const navigate = useNavigate();
  const { ask, sheet } = useBookingMode();
  const coords = useLocationStore((s) => s.coords);
  const located = useLocationStore((s) => s.located);
  const source = useLocationStore((s) => s.source);
  const setCoords = useLocationStore((s) => s.setCoords);
  const markGpsFailed = useLocationStore((s) => s.markGpsFailed);

  const [locating, setLocating] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);

  /** The nearest open station selling this fuel at a published price. */
  const nearest = useMemo(() => pumpsFor(fuel, stations)[0] ?? null, [stations, fuel]);

  /**
   * The point's real name ("Wagholi, Pune"), from the backend's cached
   * reverse geocoder. Coordinates are only the fallback: they are what the
   * page shows while the name is on its way, and if it cannot be resolved.
   */
  const [placeName, setPlaceName] = useState<string | null>(null);
  // Rounded to ~10 m: a few metres of drift is the same place, and the
  // server caches on the same grid, so this is what the effect watches.
  const gridLat = coords ? coords.lat.toFixed(4) : null;
  const gridLng = coords ? coords.lng.toFixed(4) : null;
  useEffect(() => {
    if (!coords) {
      setPlaceName(null);
      return;
    }
    let live = true;
    void fetchPlaceName(coords.lat, coords.lng).then((name) => {
      // The pin may have moved again while this was in flight.
      if (live) setPlaceName(name);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridLat, gridLng]);

  const placeLabel = useMemo(() => {
    if (!coords) return "Not set";
    if (placeName) return placeName;
    // Not named (yet): the nearest station's city is a decent stand-in when
    // it is genuinely close, otherwise the coordinates themselves.
    const near = stations[0];
    if (near?.city && near.distance != null && near.distance <= 25) return near.city;
    return `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`;
  }, [placeName, stations, coords]);

  const detectMyLocation = async () => {
    setLocating(true);
    const fix = await getFreshUserCoords();
    setLocating(false);
    if (!fix) {
      markGpsFailed();
      setMapOpen(true); // open the fallback rather than only describing it
      pushToast("Could not get your location. Set it on the map instead.", "error");
      return;
    }
    setCoords(fix.lat, fix.lng, "gps");
  };

  /** The best (nearest) published price for a fuel, for its chip. */
  const priceOf = (f: FuelKey) => pumpsFor(f, stations)[0]?.uiPrices?.[f] ?? null;
  const nearestPrice = nearest?.uiPrices?.[fuel] ?? null;

  return (
    <>
      {sheet}
    <>
      <section
        className="cx-panel mb-4 overflow-hidden"
        data-testid="find-fuel-hero"
        style={{
          backgroundImage:
            "radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--primary) 16%, transparent) 0%, transparent 55%)",
        }}
      >
        <div className="p-4 sm:p-5">
          {/* Line one: where we are searching from, and how to change it. */}
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12.5px] font-bold"
              style={{ background: "color-mix(in srgb, var(--primary) 14%, transparent)", color: "var(--text)" }}
            >
              <i className="fas fa-location-dot" style={{ color: "var(--primary)" }} aria-hidden />
              {located ? placeLabel : "Location not set"}
              {/* Where the point came from, so a customer who moved the pin
                  can see that the page is using THEIR point, not the GPS. */}
              {located && (
                <span className="cx-tag is-green">{source === "map" ? "Pinned on map" : "Detected"}</span>
              )}
            </span>

            <div className="ml-auto flex gap-2">
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => void detectMyLocation()}
                disabled={locating}
              >
                <i className="fas fa-location-crosshairs" aria-hidden /> {locating ? "Locating…" : located ? "Update" : "Use my location"}
              </button>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => setMapOpen((v) => !v)}
                aria-expanded={mapOpen}
              >
                <i className="fas fa-map-pin" aria-hidden /> {mapOpen ? "Hide map" : "Map"}
              </button>
            </div>
          </div>

          {/* Line two: the answer -- the pump you would be sent to. */}
          {nearest ? (
            <div className="mt-4 flex flex-wrap items-center gap-4">
              <div className="flex min-w-0 items-center gap-3" style={{ flex: "1 1 260px" }}>
                <span
                  className="flex items-center justify-center overflow-hidden rounded-2xl"
                  style={{ width: 64, height: 64, background: "var(--bg)", flex: "0 0 auto" }}
                >
                  {nearest.image ? (
                    <img src={nearest.image} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <i className="fas fa-gas-pump text-xl" style={{ color: "var(--primary)" }} aria-hidden />
                  )}
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
                    Nearest {fuel} pump
                  </p>
                  <h2 className="text-lg font-bold leading-snug truncate" style={{ color: "var(--text)" }} title={nearest.name}>
                    {nearest.name}
                  </h2>
                  <p className="text-[12px] mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1" style={{ color: "var(--muted)" }}>
                    {nearest.distance != null && (
                      <span>
                        <i className="fas fa-route mr-1" aria-hidden /> {nearest.distance.toFixed(1)} km
                      </span>
                    )}
                    <span>
                      <i className="fas fa-clock mr-1" aria-hidden /> ~{Math.max(0, Math.round(nearest.waitTime || 0))} min wait
                    </span>
                    <span>
                      <i className="fas fa-car mr-1" aria-hidden /> {nearest.queue} in queue
                    </span>
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 ml-auto">
                {nearestPrice != null && (
                  <div className="text-right">
                    <p className="text-xl font-extrabold leading-none" style={{ color: "var(--text)" }}>
                      ₹{nearestPrice.toFixed(2)}
                    </p>
                    <p className="text-[11px]" style={{ color: "var(--muted)" }}>
                      per {fuel === "CNG" ? "kg" : "litre"}
                    </p>
                  </div>
                )}
                {nearest.lat != null && nearest.lng != null && (
                  <a
                    className="cx-icon-btn"
                    href={directionsUrl(nearest.lat, nearest.lng) ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Navigate to ${nearest.name}`}
                    title="Navigate"
                  >
                    <i className="fas fa-paper-plane" aria-hidden />
                  </a>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => ask({ stationId: nearest.id, stationName: nearest.name, singleQuery: `fuelType=${fuel}`, fuelType: fuel })}
                >
                  <i className="fas fa-bolt" aria-hidden /> Book here
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <div className="min-w-0" style={{ flex: "1 1 240px" }}>
                <h2 className="text-lg font-bold" style={{ color: "var(--text)" }}>
                  Find a {fuel} pump near you
                </h2>
                <p className="text-[12.5px] mt-1" style={{ color: "var(--muted)" }}>
                  {located
                    ? `No open pump near you has published a ${fuel} price yet. Try another fuel, or browse every station.`
                    : "Share your location once and we rank every pump by distance, live queue and price."}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => (located ? navigate("/stations") : void detectMyLocation())}
                disabled={locating}
              >
                <i className={`fas ${located ? "fa-list" : "fa-location-crosshairs"}`} aria-hidden />{" "}
                {located ? "Browse all stations" : locating ? "Locating…" : "Use my location"}
              </button>
            </div>
          )}

          {mapOpen && (
            <div className="mt-4" data-testid="hero-map">
              <LocationPicker />
              <p className="mt-2 text-[11px]" style={{ color: "var(--muted)" }}>
                Tap the map or drag the pin if the detected spot is wrong.
              </p>
            </div>
          )}
        </div>
      </section>


      <section className="mb-4">
        <h2 className="text-[15px] font-bold" style={{ color: "var(--text)" }}>
          Select Fuel Type
        </h2>
        <p className="text-[12px] mb-3 mt-0.5" style={{ color: "var(--muted)" }}>
          Choose your fuel type to see nearby stations and current prices.
        </p>

        <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Fuel type">
          {(Object.keys(FUEL_LOOK) as FuelKey[]).map((f) => {
            const look = FUEL_LOOK[f];
            const on = fuel === f;
            const price = priceOf(f);
            return (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onFuel(f)}
                className="cx-panel flex items-center gap-3 px-4 py-3.5 text-left"
                style={{ borderColor: on ? look.tint : undefined, background: on ? `${look.tint}14` : undefined }}
              >
                <span
                  className="flex items-center justify-center rounded-full"
                  style={{ width: 44, height: 44, background: look.tint, color: "#fff", flex: "0 0 auto" }}
                  aria-hidden
                >
                  <i className={`fas ${look.icon}`} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold" style={{ color: "var(--text)" }}>
                    {f}
                  </span>
                  <span className="block text-[12px]" style={{ color: "var(--muted)" }}>
                    {price != null ? `₹${price.toFixed(2)}${look.unit}` : "No price nearby"}
                  </span>
                </span>
                <i
                  className={`fas ${on ? "fa-circle-check" : "fa-chevron-right"}`}
                  style={{ color: on ? look.tint : "var(--muted)" }}
                  aria-hidden
                />
              </button>
            );
          })}
        </div>
      </section>

      {/* Nothing nearby sells the chosen fuel: say so where the list would be. */}
      {located && !nearest && (
        <p className="mb-4 text-[12px]" style={{ color: "var(--muted)" }}>
          No open pump near you has published a {fuel} price.{" "}
          <button type="button" className="cx-link" onClick={() => navigate("/stations")}>
            Browse all stations
          </button>
        </p>
      )}
    </>
    </>
  );
}
