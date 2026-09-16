import { useEffect, useRef } from "react";
import L from "leaflet";
import { useNavigate } from "react-router-dom";
import type { UiStation } from "@/types";
import { useLeafletMap, PUNE } from "@/hooks/useLeafletMap";
import { isValidCoordinate } from "@/utils/geo";

interface Props {
  stations: UiStation[];
  /** Container classes, including its height. Defaults to the original map box. */
  className?: string;
}

/**
 * Port of initMap() in js/app.js -- the map above the stations list.
 *
 * Identical behaviour: a circleMarker per station (blue open / slate closed),
 * a tooltip showing the short name and live queue, click opens the station,
 * and fitBounds to the visible markers with a Pune fallback when none have
 * usable coordinates.
 *
 * Markers are rebuilt when the station list or filter changes -- the same
 * thing the Vanilla code did on every re-render, except the previous layers
 * are removed here instead of accumulating.
 */
export default function StationsMap({ stations, className = "map-container mb-6 relative" }: Props) {
  const navigate = useNavigate();
  const { containerRef, mapRef, ready } = useLeafletMap({
    zoomControl: false,
    zoomControlPosition: "bottomright",
  });
  const markersRef = useRef<L.CircleMarker[]>([]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;

    // Clear the previous set before drawing the new one. Skipping this is how
    // the marker layer silently doubles every time a filter is toggled.
    markersRef.current.forEach((m) => map.removeLayer(m));
    markersRef.current = [];

    // parseFloat first: the backend can send coordinates as numeric strings,
    // and Leaflet takes "18.53" as NaN once it does arithmetic on it.
    const valid = stations
      .map((s) => ({ ...s, lat: parseFloat(String(s.lat)), lng: parseFloat(String(s.lng)) }))
      .filter((s) => isValidCoordinate(s.lat, s.lng));

    valid.forEach((s) => {
      const marker = L.circleMarker([s.lat, s.lng], {
        radius: 8,
        fillColor: s.open ? "#E23744" : "#64748B",
        color: "#FFFFFF",
        weight: 2,
        opacity: 1,
        fillOpacity: 1,
      }).addTo(map);

      // Leaflet builds this node itself, so the values are inserted as text
      // rather than concatenated into an HTML string -- no escapeHtml() call
      // to remember, and no way for a station name to inject markup.
      const tip = document.createElement("div");
      tip.style.padding = "2px";
      const name = document.createElement("strong");
      name.style.cssText = "display:block;margin-bottom:2px;color:#0F172A";
      name.textContent = s.name.split(" - ")[1] || s.name;
      const meta = document.createElement("span");
      meta.style.cssText = "font-size:11px;color:#475569";
      meta.textContent = `Queue: ${s.queue} vehicles (${s.waitTime}m)`;
      tip.append(name, meta);

      marker.bindTooltip(tip, { direction: "top", offset: [0, -10] });
      marker.on("click", () => navigate(`/stations/${s.id}`));

      markersRef.current.push(marker);
    });

    if (valid.length > 0) {
      map.fitBounds(
        L.latLngBounds(valid.map((s) => [s.lat, s.lng] as [number, number])),
        { padding: [40, 40], maxZoom: 15 },
      );
    } else {
      map.setView(PUNE, 12);
    }

    // Not returned as cleanup: the next run clears them, and on unmount the
    // map itself is removed, which takes its layers with it.
  }, [stations, ready, mapRef, navigate]);

  return (
    <div className={className}>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
