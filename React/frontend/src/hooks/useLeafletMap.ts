import { useEffect, useRef, useState } from "react";
import L from "leaflet";

/** Pune city centre -- the Vanilla default view for both maps. */
export const PUNE: [number, number] = [18.5204, 73.8567];

interface Options {
  center?: [number, number];
  zoom?: number;
  /** The stations map hides the default control and adds one bottom-right. */
  zoomControl?: boolean;
  zoomControlPosition?: L.ControlPosition;
  /** false: add no base tiles -- the caller manages its own layers (the pin picker's Map/Satellite switch). */
  baseTiles?: boolean;
}

/**
 * Create and own one Leaflet map for the lifetime of a component.
 *
 * Raw Leaflet rather than react-leaflet, deliberately. The Vanilla maps are
 * imperative (circleMarkers rebuilt on filter change, fitBounds, a draggable
 * marker, invalidateSize after layout settles), and react-leaflet would mean
 * re-expressing all of that declaratively -- which is a rewrite, not a port,
 * and the one place a "same behaviour" guarantee would quietly break.
 *
 * What this hook adds over the Vanilla version is real teardown. The old code
 * carried module-level `mapInstance`/`dashboardMap` globals plus defensive
 * `delete el._leaflet_id` hacks, because a re-render replaced the container
 * under a map that was still alive -- the "Map container is already
 * initialized" error. Here the map is created and removed with the component,
 * so a detached container can never be reused and React 18 StrictMode's
 * double-mount is handled by the cleanup rather than worked around.
 */
export function useLeafletMap(options: Options = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const [ready, setReady] = useState(false);

  const {
    center = PUNE,
    zoom = 12,
    zoomControl = true,
    zoomControlPosition,
    baseTiles = true,
  } = options;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const map = L.map(el, {
      zoomControl: zoomControl && !zoomControlPosition,
      attributionControl: true,
    }).setView(center, zoom);

    if (zoomControlPosition) {
      L.control.zoom({ position: zoomControlPosition }).addTo(map);
    }

    if (baseTiles) {
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors",
        maxZoom: 19,
      }).addTo(map);
    }

    mapRef.current = map;
    setReady(true);

    // The container is often still being laid out (a card that just mounted,
    // a grid that has not settled) when the map initialises, and Leaflet
    // caches the size it sees. Without this the tiles render into a
    // zero-height box -- the "grey map" bug. Same 200ms the Vanilla code used.
    const t = window.setTimeout(() => {
      if (mapRef.current) mapRef.current.invalidateSize();
    }, 200);

    return () => {
      window.clearTimeout(t);
      setReady(false);
      mapRef.current = null;
      map.remove();
    };
    // Created once. Re-centring later is done by callers via mapRef, not by
    // rebuilding the map -- rebuilding would drop the user's pan/zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { containerRef, mapRef, ready };
}
