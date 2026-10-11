import { useState } from "react";
import { useLocationStore } from "@/store/locationStore";
import { fetchNearbyStations } from "@/services/api/stationApi";
import { getFreshUserCoords } from "@/utils/geo";
import { pushToast } from "@/store/toastStore";

/**
 * The first thing a customer sees after signing in: one ask for location, so
 * the dashboard can open on real nearby pumps instead of an empty map.
 *
 * Login -> this modal -> Allow -> device fix -> nearest pump -> dashboard.
 *
 * It only ASKS. The location itself still lands in locationStore exactly as
 * "Use my location" on the map does (source "gps", so the fuel question
 * unlocks), and the map remains the way to correct a bad fix. Skipping is
 * allowed -- a customer who will not share GPS can still tap the map -- but
 * the ask is not repeated for the rest of the session, and `located` stays
 * false so nothing downstream mistakes a skip for a known position.
 */
export default function LocationPermissionModal({ onDone }: { onDone: () => void }) {
  const setCoords = useLocationStore((s) => s.setCoords);
  const markGpsFailed = useLocationStore((s) => s.markGpsFailed);
  const [busy, setBusy] = useState<null | "locating" | "searching">(null);
  /** Set once a pump is found, so the customer sees what the location bought them. */
  const [nearest, setNearest] = useState<{ name: string; distance: number | null } | null>(null);

  const allow = async () => {
    setBusy("locating");
    const fix = await getFreshUserCoords();
    if (!fix) {
      setBusy(null);
      markGpsFailed();
      pushToast("Could not get your location. Allow location access, or tap the map to set it.", "error");
      onDone();
      return;
    }
    setCoords(fix.lat, fix.lng, "gps");

    // The nearest pump is looked up here so the dashboard opens with an
    // answer, not a spinner. A failed lookup is not a failed login: the
    // location is already set, and the dashboard will search again.
    setBusy("searching");
    try {
      const data = await fetchNearbyStations(fix.lat, fix.lng, "PETROL");
      const first = data.success ? data.stations?.[0] : null;
      if (first) {
        setNearest({ name: first.stationName, distance: first.distance ?? null });
        setBusy(null);
        return; // the customer reads the result and continues
      }
    } catch {
      /* the dashboard's own nearby list reports this */
    }
    setBusy(null);
    onDone();
  };

  const skip = () => {
    markGpsFailed();
    onDone();
  };

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.55)" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="loc-ask-title"
      data-testid="location-permission-modal"
    >
      <div
        className="w-full rounded-2xl border p-6 text-center"
        style={{ maxWidth: 400, background: "var(--card)", borderColor: "var(--border)" }}
      >
        <div
          className="mx-auto mb-4 flex items-center justify-center rounded-full text-3xl"
          style={{ width: 64, height: 64, background: "color-mix(in srgb, var(--primary) 12%, transparent)" }}
          aria-hidden
        >
          📍
        </div>

        {nearest ? (
          <>
            <h2 id="loc-ask-title" className="text-lg font-bold mb-2" style={{ color: "var(--text)" }}>
              Nearest petrol pump found
            </h2>
            <p className="text-sm mb-1 font-semibold" style={{ color: "var(--text)" }}>
              {nearest.name}
            </p>
            <p className="text-sm mb-5" style={{ color: "var(--muted)" }}>
              {nearest.distance != null ? `${nearest.distance.toFixed(1)} km away` : "Close by"}
            </p>
            <button
              onClick={onDone}
              className="w-full rounded-xl py-3 font-bold"
              style={{ background: "var(--primary)", color: "#fff" }}
            >
              Continue to dashboard
            </button>
          </>
        ) : (
          <>
            <h2 id="loc-ask-title" className="text-lg font-bold mb-2" style={{ color: "var(--text)" }}>
              Find Fuel Stations Near You
            </h2>
            <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>
              Allow location access to automatically find the nearest petrol pump, check fuel availability, prices and
              waiting time.
            </p>
            <button
              onClick={() => void allow()}
              disabled={busy !== null}
              className="w-full rounded-xl py-3 font-bold mb-2"
              style={{ background: "var(--primary)", color: "#fff", opacity: busy ? 0.7 : 1 }}
            >
              {busy === "locating"
                ? "Detecting your location…"
                : busy === "searching"
                  ? "Finding the nearest pump…"
                  : "Allow location access"}
            </button>
            <button
              onClick={skip}
              disabled={busy !== null}
              className="w-full rounded-xl py-2.5 text-sm font-semibold"
              style={{ background: "transparent", color: "var(--muted)" }}
            >
              Not now — I&apos;ll pick it on the map
            </button>
          </>
        )}
      </div>
    </div>
  );
}
