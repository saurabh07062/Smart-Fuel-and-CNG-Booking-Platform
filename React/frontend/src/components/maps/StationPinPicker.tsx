import { useEffect, useRef } from "react";
import L from "leaflet";
import { useLeafletMap, PUNE } from "@/hooks/useLeafletMap";
import { isValidCoordinate } from "@/utils/geo";

/**
 * Pick a station's exact location: click the map or drag the pin
 * (Leaflet + OpenStreetMap tiles, no API key).
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
  className = "w-full h-56 rounded-xl overflow-hidden",
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

  const { containerRef, mapRef, ready } = useLeafletMap(
    hasCoords ? { center: [parsed.lat, parsed.lng], zoom: 15 } : { center: PUNE, zoom: 12 },
  );
  const markerRef = useRef<L.Marker | null>(null);

  // Held in a ref so the map click handler binds once and cannot capture a
  // stale callback.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const handler = (e: L.LeafletMouseEvent) => onChangeRef.current(e.latlng.lat, e.latlng.lng);
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
        icon: L.divIcon({
          html: '<div class="text-2xl">📍</div>',
          className: "bg-transparent border-none",
          iconSize: [24, 24],
          iconAnchor: [12, 24],
        }),
      }).addTo(map);

      marker.on("dragend", (ev) => {
        const p = (ev.target as L.Marker).getLatLng();
        onChangeRef.current(p.lat, p.lng);
      });
      markerRef.current = marker;
    }

    if (followPin && !map.getBounds().contains([parsed.lat, parsed.lng])) {
      map.setView([parsed.lat, parsed.lng], Math.max(map.getZoom(), 15));
    }
  }, [ready, mapRef, hasCoords, parsed.lat, parsed.lng, followPin]);

  return <div ref={containerRef} id={id} className={className} style={{ border: "1px solid var(--z-line)" }} />;
}
