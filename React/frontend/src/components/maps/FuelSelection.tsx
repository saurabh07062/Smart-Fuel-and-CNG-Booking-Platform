import { useNavigate } from "react-router-dom";
import { useLocationStore } from "@/store/locationStore";
import { pushToast } from "@/store/toastStore";
import { fetchNearbyStations } from "@/services/api/stationApi";
import { toApiError } from "@/services/api/apiClient";

/**
 * Port of renderFuelSelection() + searchNearestPumpAndNavigate() in
 * js/pages/dashboard.js.
 *
 * The division of responsibility is preserved exactly, and it matters: this
 * panel collects location + fuel type, shows progress IN PLACE, and navigates
 * once the search succeeds. It must NOT render the predicted station -- that
 * is the nearest-pump page's job. Loading here, result there, never both in
 * the same place.
 *
 * Only Petrol and CNG are offered, as in the original. The backend accepts
 * DIESEL too, but adding a third button would be a UI change.
 */
export default function FuelSelection() {
  const navigate = useNavigate();
  const coords = useLocationStore((s) => s.coords);
  const fuelType = useLocationStore((s) => s.fuelType);
  const searching = useLocationStore((s) => s.searching);
  const setFuelType = useLocationStore((s) => s.setFuelType);
  const setSearching = useLocationStore((s) => s.setSearching);
  const setResult = useLocationStore((s) => s.setResult);

  if (!coords) return null;

  const search = async (fuel: "PETROL" | "CNG") => {
    // Guards a double-click firing two searches (and so two navigations)
    // while the first request is still in flight.
    if (searching) return;

    setFuelType(fuel);
    setSearching(true);
    try {
      const data = await fetchNearbyStations(coords.lat, coords.lng, fuel);
      if (!data.success) {
        pushToast(data.msg || data.message || "Could not search nearby stations.", "error");
        return;
      }

      const result = {
        stations: data.stations ?? [],
        fuelType: fuel,
        origin: coords,
        searchedAt: Date.now(),
      };

      if (result.stations.length === 0) {
        pushToast(`No nearby ${fuel} stations found.`, "warning");
        // Leave the buttons up so they can try the other fuel type.
        setFuelType(null);
        return;
      }

      setResult(result);
      navigate("/nearest-pump");
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setSearching(false);
    }
  };

  const btnStyle = (isSel: boolean) =>
    isSel
      ? {
          background: "var(--primary)",
          color: "#fff",
          borderColor: "var(--primary)",
          boxShadow: "0 4px 12px -2px rgba(226,55,68,0.35)",
        }
      : { background: "var(--card)", color: "var(--text)", borderColor: "var(--border)" };

  return (
    <div
      className="text-xs font-semibold mt-3 p-3 rounded-xl text-center"
      style={{ background: "var(--secondary-light)", border: "1px solid var(--secondary)" }}
    >
      {searching ? (
        <div className="flex items-center justify-center gap-2 py-2">
          <i className="fas fa-circle-notch fa-spin" style={{ color: "var(--primary)" }} aria-hidden />
          <span className="text-sm font-medium">Finding the nearest {fuelType} station…</span>
        </div>
      ) : (
        <>
          <div
            className="flex items-center justify-center gap-2 mb-3 font-semibold"
            style={{ color: "var(--secondary)" }}
          >
            <i className="fas fa-circle-check" aria-hidden /> Location set:{" "}
            {coords.lat.toFixed(4)}°, {coords.lng.toFixed(4)}°
          </div>
          <div className="pt-3" style={{ borderTop: "1px solid var(--border)" }}>
            <p
              className="text-xs font-semibold mb-3 uppercase tracking-wider text-center"
              style={{ color: "var(--muted)" }}
            >
              What do you need?
            </p>
            <div className="flex gap-3 justify-center">
              <button
                className="btn flex-1"
                style={{ border: "1.5px solid var(--border)", ...btnStyle(fuelType === "PETROL") }}
                onClick={() => search("PETROL")}
              >
                <i className="fas fa-gas-pump" aria-hidden /> Petrol
                {fuelType === "PETROL" && <i className="fas fa-check ml-1" aria-hidden />}
              </button>
              <button
                className="btn flex-1"
                style={{ border: "1.5px solid var(--border)", ...btnStyle(fuelType === "CNG") }}
                onClick={() => search("CNG")}
              >
                <i className="fas fa-fire" aria-hidden /> CNG
                {fuelType === "CNG" && <i className="fas fa-check ml-1" aria-hidden />}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
