import { useCallback, useEffect, useState } from "react";
import { useAuthStore } from "@/store/authStore";
import { useLocationStore } from "@/store/locationStore";
import { getFreshUserCoords } from "@/utils/geo";
import { fetchNearbyStations } from "@/services/api/stationApi";
import PlaceSearchPanel from "./PlaceSearchPanel";
import type { PlaceMatch } from "@/services/api/stationApi";
import type { FuelKey } from "@/utils/fuelPumps";

/**
 * What happens between signing in and seeing pumps.
 *
 *   1. "Login successful"      — said, then it gets out of the way
 *   2. (a pause)               — the location ask is not thrown at the
 *                                customer the instant the page paints
 *   3. "Share your location"   — the device's own permission prompt
 *   4. "What do you want?"     — Petrol / Diesel / CNG
 *   5. the dashboard           — real stations near the real point
 *
 * WHERE THE DATA COMES FROM
 *
 * The position is the device's (utils/geo getFreshUserCoords) or a place the
 * customer searched for; the stations are the backend's, from the database,
 * for that point and that fuel (GET /api/stations/nearby). Nothing in this
 * component knows a station, a coordinate or a price.
 *
 * WHEN IT DOES NOT RUN
 *
 * Only after a sign-in (locationStore.askLocation), once per session, and
 * never for a customer who already has a location this session. Answering it
 * any way at all — allow, refuse, skip — ends it, so it cannot nag.
 */

/** How long the confirmation is shown before the location ask. */
const ASK_DELAY_MS = Number(import.meta.env.VITE_LOCATION_ASK_DELAY_MS ?? 20_000);

type Stage = "success" | "asking" | "manual" | "fuel";

const FUELS: { key: FuelKey; label: string; icon: string; hint: string }[] = [
  { key: "Petrol", label: "Petrol", icon: "fa-gas-pump", hint: "Cars, bikes and scooters" },
  { key: "Diesel", label: "Diesel", icon: "fa-truck", hint: "Trucks, SUVs and generators" },
  { key: "CNG", label: "CNG", icon: "fa-fire", hint: "CNG cars, autos and vans" },
];

export default function PostLoginFlow({
  onFuelChosen,
  onDone,
}: {
  /** The fuel the customer picked, for the dashboard's own list. */
  onFuelChosen: (fuel: FuelKey) => void;
  /** The flow is over, whatever the customer answered. */
  onDone: () => void;
}) {
  const name = useAuthStore((s) => s.user?.name || "");
  const signedInAt = useLocationStore((s) => s.signedInAt);
  const setCoords = useLocationStore((s) => s.setCoords);
  const markGpsFailed = useLocationStore((s) => s.markGpsFailed);
  const setFuelType = useLocationStore((s) => s.setFuelType);

  const [stage, setStage] = useState<Stage>("success");
  const [secondsLeft, setSecondsLeft] = useState(() => secondsUntilAsk(signedInAt));
  const [busy, setBusy] = useState<null | "locating" | "searching">(null);
  const [placeName, setPlaceName] = useState<string | null>(null);
  const [nearbyCount, setNearbyCount] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /** The countdown, driven by the sign-in time so a remount does not restart it. */
  useEffect(() => {
    if (stage !== "success") return;
    const tick = () => {
      const left = secondsUntilAsk(signedInAt);
      setSecondsLeft(left);
      if (left <= 0) setStage("asking");
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [stage, signedInAt]);

  /**
   * Ask the device, then ask the backend what is near the answer.
   *
   * Every outcome is handled: a refusal or a failed fix moves to the manual
   * search rather than leaving the customer on a dead prompt, and a failed
   * lookup still keeps the location (the dashboard list retries on its own).
   */
  const askDevice = useCallback(async () => {
    setProblem(null);
    setBusy("locating");
    const fix = await getFreshUserCoords();
    if (!fix) {
      setBusy(null);
      markGpsFailed();
      setProblem("We could not get your location from this device. Search for your area instead.");
      setStage("manual");
      return;
    }

    setCoords(fix.lat, fix.lng, "gps");
    setBusy("searching");
    try {
      // The real database answer for the real point, before the fuel is even
      // chosen -- so the next screen can say whether there is anything here.
      const data = await fetchNearbyStations(fix.lat, fix.lng, "PETROL");
      setNearbyCount(data.success ? (data.stations?.length ?? 0) : null);
    } catch {
      // Not fatal: the location is set and the dashboard searches again.
      setNearbyCount(null);
    }
    setBusy(null);
    setStage("fuel");
  }, [markGpsFailed, setCoords]);

  useEffect(() => {
    if (stage === "asking" && !busy) void askDevice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const pickPlace = async (place: PlaceMatch) => {
    // A searched place is a place the customer chose, not a measured fix:
    // recorded as "map", the same as dropping a pin.
    setCoords(place.lat, place.lng, "map");
    setPlaceName(place.name || place.label);
    setBusy("searching");
    try {
      const data = await fetchNearbyStations(place.lat, place.lng, "PETROL");
      setNearbyCount(data.success ? (data.stations?.length ?? 0) : null);
    } catch {
      setNearbyCount(null);
    }
    setBusy(null);
    setStage("fuel");
  };

  const chooseFuel = (fuel: FuelKey) => {
    setFuelType(fuel);
    onFuelChosen(fuel);
    onDone();
  };

  const skip = () => {
    markGpsFailed();
    onDone();
  };

  return (
    <div className="cx-flow-overlay" role="presentation">
      <div
        className="cx-flow-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="post-login-title"
        data-testid="post-login-flow"
      >
        {/* ---------- 1. login confirmed ---------- */}
        {stage === "success" && (
          <>
            <span className="cx-flow-badge cx-flow-badge-ok" aria-hidden>
              <i className="fas fa-circle-check" />
            </span>
            <h2 id="post-login-title" className="cx-flow-title">
              Login successful
            </h2>
            <p className="cx-flow-text">
              {name ? `Welcome back, ${name.split(" ")[0]}.` : "Welcome back."} We will ask for your location in{" "}
              <strong data-testid="ask-countdown">{secondsLeft}s</strong> so we can show pumps near you.
            </p>
            <div className="cx-flow-actions">
              <button type="button" className="cx-flow-btn cx-flow-btn-primary" onClick={() => setStage("asking")}>
                <i className="fas fa-location-crosshairs" aria-hidden /> Share location now
              </button>
              <button type="button" className="cx-flow-btn" onClick={() => setStage("manual")}>
                Enter it myself
              </button>
            </div>
            <button type="button" className="cx-flow-skip" onClick={skip}>
              Skip for now
            </button>
          </>
        )}

        {/* ---------- 2. the device is being asked ---------- */}
        {stage === "asking" && (
          <>
            <span className="cx-flow-badge" aria-hidden>
              <i className={`fas ${busy === "searching" ? "fa-magnifying-glass-location" : "fa-location-crosshairs"}`} />
            </span>
            <h2 id="post-login-title" className="cx-flow-title">
              {busy === "searching" ? "Finding pumps near you…" : "Allow location access"}
            </h2>
            <p className="cx-flow-text">
              {busy === "searching"
                ? "Checking which stations are closest to where you are."
                : "Your browser will ask for permission. We use the point only to find nearby pumps."}
            </p>
            <div className="cx-flow-spinner" aria-hidden>
              <i className="fas fa-spinner fa-spin" />
            </div>
            <button type="button" className="cx-flow-skip" onClick={() => setStage("manual")}>
              Enter my location instead
            </button>
          </>
        )}

        {/* ---------- 3. manual: type a place ---------- */}
        {stage === "manual" && (
          <>
            <span className="cx-flow-badge" aria-hidden>
              <i className="fas fa-map-location-dot" />
            </span>
            <h2 id="post-login-title" className="cx-flow-title">
              Where are you?
            </h2>
            {problem ? (
              <p className="cx-flow-text cx-flow-warn" role="alert">
                {problem}
              </p>
            ) : (
              <p className="cx-flow-text">Search for your area and we will look for pumps around it.</p>
            )}

            <PlaceSearchPanel autoFocus onPicked={(place) => void pickPlace(place)} />

            <div className="cx-flow-actions">
              <button type="button" className="cx-flow-btn" onClick={() => setStage("asking")}>
                <i className="fas fa-location-crosshairs" aria-hidden /> Try my device again
              </button>
            </div>
            <button type="button" className="cx-flow-skip" onClick={skip}>
              Skip — I will set it on the map
            </button>
          </>
        )}

        {/* ---------- 4. what do you want? ---------- */}
        {stage === "fuel" && (
          <>
            <span className="cx-flow-badge cx-flow-badge-ok" aria-hidden>
              <i className="fas fa-location-dot" />
            </span>
            <h2 id="post-login-title" className="cx-flow-title">
              What do you want?
            </h2>
            <p className="cx-flow-text">
              {placeName ? `Looking around ${placeName}. ` : "Location set. "}
              {nearbyCount === null
                ? "Choose a fuel and we will list the stations."
                : nearbyCount === 0
                  ? "No station is listed around you yet — choose a fuel and we will widen the search."
                  : `${nearbyCount} station${nearbyCount === 1 ? "" : "s"} nearby. Which fuel?`}
            </p>

            <div className="cx-flow-fuels">
              {FUELS.map((fuel) => (
                <button
                  key={fuel.key}
                  type="button"
                  className="cx-flow-fuel"
                  onClick={() => chooseFuel(fuel.key)}
                  data-testid={`choose-fuel-${fuel.key.toLowerCase()}`}
                >
                  <i className={`fas ${fuel.icon}`} aria-hidden />
                  <span>
                    <strong>{fuel.label}</strong>
                    <small>{fuel.hint}</small>
                  </span>
                </button>
              ))}
            </div>
            <button type="button" className="cx-flow-skip" onClick={onDone}>
              Not now
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Whole seconds until the location ask, from the sign-in time. */
function secondsUntilAsk(signedInAt: number | null): number {
  if (!signedInAt) return 0;
  return Math.max(0, Math.ceil((signedInAt + ASK_DELAY_MS - Date.now()) / 1000));
}
