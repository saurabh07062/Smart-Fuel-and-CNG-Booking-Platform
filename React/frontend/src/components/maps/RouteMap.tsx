import { useEffect } from "react";
import L from "leaflet";
import type { Coordinates } from "@/types";
import { useLeafletMap } from "@/hooks/useLeafletMap";

interface Props {
  from: Coordinates;
  to: Coordinates;
  stationName: string;
}

const marker = (bg: string, icon: string, shadow: string) =>
  L.divIcon({
    html: `<div style="background:${bg};color:white;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid white;box-shadow:0 0 10px ${shadow}"><i class="fas ${icon}" style="font-size:12px"></i></div>`,
    className: "",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

/**
 * Port of initConfirmationRouteMap() in js/pages/booking.js -- the mini-map on
 * the confirmation page: a car pin at the user, a pump pin at the station, a
 * dashed blue line between them, fitted to both.
 *
 * The caller only renders this when BOTH ends are real coordinates
 * (hasValidRoute), so a route is never drawn from a guessed or defaulted
 * point. That was the whole reason the Vanilla version carried its own
 * defence-in-depth check.
 */
export default function RouteMap({ from, to, stationName }: Props) {
  const { containerRef, mapRef, ready } = useLeafletMap({
    center: [from.lat, from.lng],
    zoom: 14,
    zoomControl: false,
  });

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;

    const userMarker = L.marker([from.lat, from.lng], {
      icon: marker("var(--secondary)", "fa-car", "rgba(16,185,129,0.5)"),
    })
      .addTo(map)
      .bindTooltip("Your Location");

    const pumpMarker = L.marker([to.lat, to.lng], {
      icon: marker("var(--accent)", "fa-gas-pump", "rgba(249,115,22,0.5)"),
    })
      .addTo(map)
      .bindTooltip(stationName || "Station");

    const line = L.polyline(
      [
        [from.lat, from.lng],
        [to.lat, to.lng],
      ],
      { color: "#e23744", weight: 4, dashArray: "8, 8", opacity: 0.85 },
    ).addTo(map);

    map.fitBounds(line.getBounds(), { padding: [30, 30] });

    return () => {
      map.removeLayer(userMarker);
      map.removeLayer(pumpMarker);
      map.removeLayer(line);
    };
  }, [ready, mapRef, from.lat, from.lng, to.lat, to.lng, stationName]);

  return (
    <div className="mt-4 mb-3">
      <div
        ref={containerRef}
        className="w-full h-44 rounded-xl overflow-hidden"
        style={{ minHeight: 175, border: "1px solid var(--border)" }}
      />
    </div>
  );
}
