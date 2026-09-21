import { useEffect, useRef } from "react";
import L from "leaflet";
import { useNavigate } from "react-router-dom";
import type { UiStation } from "@/types";
import { useLeafletMap, PUNE } from "@/hooks/useLeafletMap";
import { isValidCoordinate } from "@/utils/geo";
import { MapLayerSwitch, PIN_SLATE, pinIcon, useAccentColor, useBaseLayer, userLocationIcon } from "./mapTheme";

interface Props {
  stations: UiStation[];
  /** Frame classes, including its height. */
  className?: string;
  /** The customer's position, drawn as a blue "you are here" dot and kept in view. */
  userCoords?: { lat: number; lng: number } | null;
}

/**
 * The customer station map (Stations page, station detail, dashboard).
 *
 * One fuel-pump pin per station with real coordinates -- red when open, slate
 * when closed -- a tooltip with the name, live queue and status, click to open
 * the station, and fitBounds over the pins (and the customer, when known) with
 * a Pune fallback. Same look as the vendor pin picker (components/maps/mapTheme):
 * Map / Satellite switch, styled controls, scale bar.
 *
 * Pins are rebuilt when the station list changes; the previous ones are
 * removed first so they never accumulate.
 */
export default function StationsMap({ stations, className = "h-[320px]", userCoords = null }: Props) {
  // Open-station pins follow the app colour (red or green); closed stay slate.
  const pinColor = useAccentColor();
  const navigate = useNavigate();
  const { containerRef, mapRef, ready } = useLeafletMap({
    zoomControl: false,
    zoomControlPosition: "bottomright",
    baseTiles: false,
  });
  const { layer, setLayer } = useBaseLayer(mapRef.current, ready);
  const markersRef = useRef<L.Marker[]>([]);
  const userMarkerRef = useRef<L.Marker | null>(null);

  const userLat = userCoords?.lat;
  const userLng = userCoords?.lng;

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;

    // Clear the previous set before drawing the new one. Skipping this is how
    // the marker layer silently doubles every time a filter is toggled.
    markersRef.current.forEach((m) => map.removeLayer(m));
    markersRef.current = [];
    if (userMarkerRef.current) {
      map.removeLayer(userMarkerRef.current);
      userMarkerRef.current = null;
    }

    // parseFloat first: the backend can send coordinates as numeric strings,
    // and Leaflet takes "18.53" as NaN once it does arithmetic on it.
    const valid = stations
      .map((s) => ({ ...s, lat: parseFloat(String(s.lat)), lng: parseFloat(String(s.lng)) }))
      .filter((s) => isValidCoordinate(s.lat, s.lng));

    valid.forEach((s) => {
      const marker = L.marker([s.lat, s.lng], {
        icon: pinIcon({ color: s.open ? pinColor : PIN_SLATE, size: 30 }),
        title: s.name,
        riseOnHover: true,
      }).addTo(map);

      // Leaflet builds this node itself, so the values are inserted as text
      // rather than concatenated into an HTML string -- a station name cannot
      // inject markup.
      const tip = document.createElement("div");
      const name = document.createElement("span");
      name.className = "fm-tip-name";
      name.textContent = s.name.split(" - ")[1] || s.name;
      const status = document.createElement("span");
      status.className = `fm-tip-status ${s.open ? "" : "is-closed"}`;
      status.textContent = s.open ? "Open" : "Closed";
      name.append(status);
      const meta = document.createElement("span");
      meta.className = "fm-tip-meta";
      meta.textContent = `Queue: ${s.queue} vehicle${s.queue === 1 ? "" : "s"} · ${s.waitTime} min wait${s.distance != null ? ` · ${s.distance} km` : ""}`;
      tip.append(name, meta);

      marker.bindTooltip(tip, { direction: "top" });
      marker.on("click", () => navigate(`/stations/${s.id}`));
      markersRef.current.push(marker);
    });

    const points = valid.map((s) => [s.lat, s.lng] as [number, number]);
    if (userLat !== undefined && userLng !== undefined && isValidCoordinate(userLat, userLng)) {
      userMarkerRef.current = L.marker([userLat, userLng], {
        icon: userLocationIcon(),
        title: "You are here",
        keyboard: false,
        interactive: false,
      }).addTo(map);
      points.push([userLat, userLng]);
    }

    if (points.length > 1) {
      map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 15 });
    } else if (points.length === 1) {
      map.setView(points[0], 15);
    } else {
      map.setView(PUNE, 12);
    }

    // Not returned as cleanup: the next run clears them, and on unmount the
    // map itself is removed, which takes its layers with it.
  }, [stations, ready, mapRef, navigate, userLat, userLng, pinColor]);

  const anyClosed = stations.some((s) => !s.open);

  return (
    <div className={`fm-picker fm-stations-map ${className}`}>
      <div ref={containerRef} className="w-full h-full" />
      <MapLayerSwitch layer={layer} onChange={setLayer} />
      <div className="fm-picker-overlay fm-legend" aria-hidden>
        <div>
          <span>
            <i style={{ background: pinColor }} /> Open
          </span>
          {anyClosed && (
            <span>
              <i style={{ background: PIN_SLATE }} /> Closed
            </span>
          )}
          {userCoords && (
            <span>
              <i style={{ background: "#2f80ed" }} /> You
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
