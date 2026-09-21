import { useEffect, useState } from "react";
import L from "leaflet";
import "@/styles/pinPicker.css";
import { useUiStore } from "@/store/uiStore";

/**
 * The look shared by FuelMart's maps (styles/pinPicker.css): keyless tiles
 * with a Map / Satellite switch, the fuel-pump pin, styled controls.
 * Used by the station pin picker and the customer station maps.
 */

export type BaseLayer = "map" | "satellite";

/**
 * Tile sources that need no API key; attribution is shown as their terms require.
 *
 * CARTO basemaps were used here first, but CARTO now stamps "API KEY REQUIRED"
 * across tiles requested without a key. Street map: OpenStreetMap's standard
 * tiles. Satellite: Esri World Imagery with Esri's road and place-name layers
 * over it, so a pump can still be found by street.
 */
export const BASE_LAYERS: Record<BaseLayer, Array<{ url: string; options: L.TileLayerOptions }>> = {
  map: [
    {
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
  ],
  satellite: [
    {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      options: { maxZoom: 19, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" },
    },
    {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
      options: { maxZoom: 19, pane: "overlayPane" },
    },
    {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      options: { maxZoom: 19, pane: "overlayPane" },
    },
  ],
};

export const PIN_RED = "#e23744";
export const PIN_GREEN = "#1a8f4a";

/** The pin / route colour for the customer's chosen app colour (uiStore accent). */
export function useAccentColor(): string {
  return useUiStore((s) => s.accent) === "green" ? PIN_GREEN : PIN_RED;
}
export const PIN_SLATE = "#64748b";

/** The fuel-pump map pin as a Leaflet icon. SVG: crisp at any zoom, no icon font. */
export function pinIcon({ color = PIN_RED, size = 36, pulse = false }: { color?: string; size?: number; pulse?: boolean } = {}) {
  const w = size;
  const h = Math.round(size * (46 / 36));
  const html = `
    <div class="fm-pin-body" style="width:${w}px;height:${h}px">
      ${pulse ? '<span class="fm-pin-pulse"></span>' : ""}
      <svg width="${w}" height="${h}" viewBox="0 0 36 46" aria-hidden="true">
        <path d="M18 1C8.6 1 1 8.4 1 17.6 1 29.8 18 45 18 45s17-15.2 17-27.4C35 8.4 27.4 1 18 1z" fill="${color}" stroke="#ffffff" stroke-width="2"/>
        <g transform="translate(10.5 9)" fill="#ffffff">
          <path d="M2 1.5A1.5 1.5 0 0 1 3.5 0h5A1.5 1.5 0 0 1 10 1.5V15H2V1.5zM3.5 2v4h5V2h-5z"/>
          <path d="M11 4.2l2.6 2.1c.3.2.4.6.4.9v5.8a1.5 1.5 0 0 1-3 0V10h-.5V8.8h.5a1.2 1.2 0 0 1 1.2 1.2v3a.3.3 0 0 0 .6 0V7.5L11 5.9V4.2z"/>
          <rect x="1" y="15" width="10" height="1.6" rx=".8"/>
        </g>
      </svg>
    </div>`;
  return L.divIcon({ html, className: "fm-pin", iconSize: [w, h], iconAnchor: [w / 2, h - 1], tooltipAnchor: [0, -h + 6] });
}

/** "You are here": a blue dot with a soft halo. */
export function userLocationIcon() {
  return L.divIcon({
    html: '<span class="fm-user-dot"></span>',
    className: "fm-pin",
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

/**
 * The current base layer on `map` (Map by default) plus a metric scale bar.
 * Returns the chosen layer and its setter for <MapLayerSwitch>.
 */
export function useBaseLayer(map: L.Map | null, ready: boolean) {
  const [layer, setLayer] = useState<BaseLayer>("map");

  useEffect(() => {
    if (!ready || !map) return;
    const layers = BASE_LAYERS[layer].map(({ url, options }) => L.tileLayer(url, options).addTo(map));
    return () => {
      layers.forEach((l) => l.remove());
    };
  }, [ready, map, layer]);

  useEffect(() => {
    if (!ready || !map) return;
    const scale = L.control.scale({ position: "bottomright", imperial: false }).addTo(map);
    return () => {
      scale.remove();
    };
  }, [ready, map]);

  return { layer, setLayer };
}

/** The Map / Satellite segmented switch drawn over a map (top right). */
export function MapLayerSwitch({ layer, onChange }: { layer: BaseLayer; onChange: (layer: BaseLayer) => void }) {
  return (
    <div className="fm-picker-overlay fm-picker-layers" role="group" aria-label="Map style">
      {(["map", "satellite"] as const).map((l) => (
        <button key={l} type="button" aria-pressed={layer === l} onClick={() => onChange(l)}>
          {l === "map" ? "Map" : "Satellite"}
        </button>
      ))}
    </div>
  );
}
