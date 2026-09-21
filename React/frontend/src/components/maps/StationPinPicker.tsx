import { useEffect, useRef } from "react";
import L from "leaflet";
import { useLeafletMap, PUNE } from "@/hooks/useLeafletMap";
import { isValidCoordinate } from "@/utils/geo";
import { MapLayerSwitch, pinIcon, useBaseLayer } from "./mapTheme";

/**
 * Pick a station's exact location: click the map or drag the pin (Leaflet,
 * keyless tiles: OpenStreetMap street map, Esri satellite imagery -- see mapTheme.tsx).
 *
 * Two-way: the pin follows `lat`/`lng` when they change from outside (typed
 * inputs, "use my location", a pre-filled registration pin) and reports every
 * click or drag through `onChange`. This point is what customer navigation and
 * nearest-station search use, so it is set visually, not only typed.
 *
 * Shared by the admin station form and the vendor "Add station" form.
 */
export default function StationPinPicker({
  lat,
  lng,
  onChange,
  followPin = false,
  id,
  className = "fm-picker-map",
}: {
  lat: string;
  lng: string;
  onChange: (lat: number, lng: number) => void;
  /** Bring the map to the pin when it moves off screen from outside the map. */
  followPin?: boolean;
  id?: string;
  className?: string;
}) {
  const parsed = { lat: parseFloat(lat), lng: parseFloat(lng) };
  const hasCoords = isValidCoordinate(parsed.lat, parsed.lng);

  const { containerRef, mapRef, ready } = useLeafletMap({
    ...(hasCoords ? { center: [parsed.lat, parsed.lng] as [number, number], zoom: 16 } : { center: PUNE, zoom: 12 }),
    baseTiles: false,
  });
  const markerRef = useRef<L.Marker | null>(null);
  const { layer, setLayer } = useBaseLayer(mapRef.current, ready);

  // Held in a ref so the map click handler binds once and cannot capture a
  // stale callback.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // The last point this map reported itself (a click or a drag). A pin that
  // arrives as anything else -- typed latitude/longitude, "use my location" --
  // came from outside, and the map moves to it.
  const lastReportedRef = useRef<{ lat: number; lng: number } | null>(null);
  const report = (la: number, ln: number) => {
    lastReportedRef.current = { lat: la, lng: ln };
    onChangeRef.current(la, ln);
  };
  const reportRef = useRef(report);
  reportRef.current = report;

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const handler = (e: L.LeafletMouseEvent) => reportRef.current(e.latlng.lat, e.latlng.lng);
    map.on("click", handler);
    return () => {
      map.off("click", handler);
    };
  }, [ready, mapRef]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;

    if (!hasCoords) {
      if (markerRef.current) {
        map.removeLayer(markerRef.current);
        markerRef.current = null;
      }
      return;
    }

    if (markerRef.current) {
      markerRef.current.setLatLng([parsed.lat, parsed.lng]);
    } else {
      const marker = L.marker([parsed.lat, parsed.lng], {
        draggable: true,
        autoPan: true,
        keyboard: true,
        title: "Station location -- drag to adjust",
        icon: pinIcon({ pulse: true }),
      }).addTo(map);

      marker.on("dragend", (ev) => {
        const p = (ev.target as L.Marker).getLatLng();
        reportRef.current(p.lat, p.lng);
      });
      markerRef.current = marker;
    }

    if (followPin) {
      // Rounded when stored (toFixed(6)), so compare to within that precision.
      const last = lastReportedRef.current;
      const fromThisMap =
        last && Math.abs(last.lat - parsed.lat) < 1e-6 && Math.abs(last.lng - parsed.lng) < 1e-6;
      // Typed or located: centre on it. Clicked or dragged: the vendor is
      // already looking there; only follow if it somehow left the screen.
      if (!fromThisMap || !map.getBounds().contains([parsed.lat, parsed.lng])) {
        // Close enough to see the forecourt itself, so a pin a few hundred
        // metres off is obvious before saving.
        map.setView([parsed.lat, parsed.lng], Math.max(map.getZoom(), 17));
      }
    }
  }, [ready, mapRef, hasCoords, parsed.lat, parsed.lng, followPin]);

  const coordText = hasCoords ? `${parsed.lat.toFixed(6)}, ${parsed.lng.toFixed(6)}` : null;

  return (
    <div className="fm-picker">
      <div ref={containerRef} id={id} className={className} />

      <MapLayerSwitch layer={layer} onChange={setLayer} />

      <div className="fm-picker-overlay fm-picker-chip" aria-live="polite">
        <div>
          <span className={`fm-dot ${coordText ? "is-set" : ""}`} aria-hidden />
          {coordText ? (
            <>
              <code>{coordText}</code>
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${parsed.lat},${parsed.lng}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Check in Google Maps ↗
              </a>
            </>
          ) : (
            <span>Click the map to drop the pin on the pump</span>
          )}
        </div>
      </div>
    </div>
  );
}
