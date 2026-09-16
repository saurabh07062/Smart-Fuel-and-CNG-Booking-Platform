import { useEffect, useRef, useState, type ReactNode } from "react";
import L from "leaflet";
import { useLeafletMap } from "@/hooks/useLeafletMap";
import { useLocationStore } from "@/store/locationStore";
import { pushToast } from "@/store/toastStore";
import { getFreshUserCoords } from "@/utils/geo";

/**
 * Port of initDashboardMap() / setDashboardMarker() in js/pages/dashboard.js.
 *
 * Same three ways to set a point -- click the map, drag the pin, or press
 * "Use my location" -- the same 📍 divIcon, and the same behaviour of zooming
 * to 14 only for a device fix (a click keeps the current zoom, because the
 * user is already looking at where they want).
 */
export default function LocationPicker({ children }: { children?: ReactNode }) {
  const coords = useLocationStore((s) => s.coords);
  const setCoords = useLocationStore((s) => s.setCoords);
  const [locating, setLocating] = useState(false);

  // The map opens on a known point when there is one, so a returning user is
  // not sent back to the city centre.
  const { containerRef, mapRef, ready } = useLeafletMap(
    coords ? { center: [coords.lat, coords.lng], zoom: 14 } : {},
  );
  const markerRef = useRef<L.Marker | null>(null);

  // setCoords in a ref so the map's click handler is bound once, and cannot
  // capture a stale copy of it.
  const setCoordsRef = useRef(setCoords);
  setCoordsRef.current = setCoords;

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;

    const onClick = (e: L.LeafletMouseEvent) =>
      setCoordsRef.current(e.latlng.lat, e.latlng.lng);

    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [ready, mapRef]);

  // Reflect the stored point onto the map: move the pin if it exists, create
  // it if it does not. Creating a second marker per change is what left a
  // trail of pins behind in an earlier attempt.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;

    if (!coords) {
      if (markerRef.current) {
        map.removeLayer(markerRef.current);
        markerRef.current = null;
      }
      return;
    }

    if (markerRef.current) {
      markerRef.current.setLatLng([coords.lat, coords.lng]);
      return;
    }

    const icon = L.divIcon({
      html: '<div class="text-2xl">📍</div>',
      className: "bg-transparent border-none",
      iconSize: [24, 24],
      iconAnchor: [12, 24],
    });

    const marker = L.marker([coords.lat, coords.lng], { draggable: true, icon }).addTo(map);
    marker.on("dragend", (ev) => {
      const p = (ev.target as L.Marker).getLatLng();
      setCoordsRef.current(p.lat, p.lng);
    });
    markerRef.current = marker;
  }, [coords, ready, mapRef]);

  const useMyLocation = async () => {
    if (!navigator.geolocation) {
      pushToast("Geolocation not available", "error");
      return;
    }
    setLocating(true);
    const fix = await getFreshUserCoords();
    setLocating(false);

    if (!fix) {
      pushToast("Please allow location access to find nearby fuel stations.", "error");
      return;
    }
    setCoords(fix.lat, fix.lng);
    mapRef.current?.setView([fix.lat, fix.lng], 14);
    pushToast("Location found!", "success");
  };

  return (
    <div className="card p-4">
      <div
        ref={containerRef}
        className="h-48 border border-[var(--border)] rounded-lg mb-3 z-0 relative"
        style={{ background: "var(--bg2)" }}
      />
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <span className="text-xs text-[var(--muted)]">Tip: Click on map to set location</span>
        <button
          type="button"
          className="btn btn-outline btn-sm text-xs border-[var(--border)]"
          onClick={useMyLocation}
          disabled={locating}
        >
          <i className={`fas ${locating ? "fa-spinner fa-spin" : "fa-crosshairs"} mr-1`} aria-hidden />
          {locating ? "Locating..." : "Use my location"}
        </button>
      </div>
      {children}
    </div>
  );
}
