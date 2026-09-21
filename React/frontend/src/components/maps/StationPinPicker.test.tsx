import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

/**
 * The Leaflet side of the pin picker. Leaflet cannot draw in jsdom, so the map
 * and marker are recording stand-ins; what is checked is what the component
 * asks Leaflet to do: place the marker, move it, and centre the map on it.
 */
const fake = vi.hoisted(() => {
  const handlers: Record<string, (e: unknown) => void> = {};
  const marker = {
    addTo: vi.fn(function (this: unknown) {
      return marker;
    }),
    setLatLng: vi.fn(),
    on: vi.fn((event: string, fn: (e: unknown) => void) => {
      handlers[`marker:${event}`] = fn;
    }),
  };
  const map = {
    on: vi.fn((event: string, fn: (e: unknown) => void) => {
      handlers[`map:${event}`] = fn;
    }),
    off: vi.fn(),
    setView: vi.fn(),
    getZoom: vi.fn(() => 12),
    getBounds: vi.fn(() => ({ contains: () => true })),
    removeLayer: vi.fn(),
  };
  return { handlers, marker, map };
});

vi.mock("leaflet", () => {
  const layer = () => ({ addTo: vi.fn(function (this: unknown) { return this; }), remove: vi.fn() });
  return {
    default: {
      marker: vi.fn(() => fake.marker),
      divIcon: vi.fn(() => ({})),
      tileLayer: vi.fn(layer),
      control: { scale: vi.fn(layer) },
    },
  };
});
vi.mock("@/hooks/useLeafletMap", () => ({
  PUNE: [18.52, 73.85],
  useLeafletMap: () => ({ containerRef: { current: null }, mapRef: { current: fake.map }, ready: true }),
}));

import L from "leaflet";
import StationPinPicker from "./StationPinPicker";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("StationPinPicker", () => {
  it("places no marker until both coordinates are valid", () => {
    render(<StationPinPicker lat="18.5" lng="" onChange={() => {}} followPin />);
    expect(L.marker).not.toHaveBeenCalled();
    render(<StationPinPicker lat="95" lng="73.8" onChange={() => {}} followPin />);
    expect(L.marker).not.toHaveBeenCalled();
  });

  it("starts on the street map, switches to satellite, and shows the pinned coordinates", async () => {
    const { fireEvent, screen } = await import("@testing-library/react");
    render(<StationPinPicker lat="18.5204303" lng="73.8567437" onChange={() => {}} followPin />);
    const urls = () => vi.mocked(L.tileLayer).mock.calls.map((c) => String(c[0]));
    expect(urls().some((u) => u.includes("tile.openstreetmap.org"))).toBe(true);
    // No provider that needs an API key (CARTO watermarks keyless tiles).
    expect(urls().some((u) => u.includes("cartocdn"))).toBe(false);
    expect(screen.getByRole("button", { name: "Map" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Satellite" }));
    expect(urls().some((u) => u.includes("World_Imagery"))).toBe(true);
    expect(screen.getByRole("button", { name: "Satellite" }).getAttribute("aria-pressed")).toBe("true");

    expect(screen.getByText("18.520430, 73.856744")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Check in Google Maps/ }).getAttribute("href")).toContain("query=18.5204303,73.8567437");
  });

  it("without a pin, asks for a click instead of showing coordinates", async () => {
    const { screen } = await import("@testing-library/react");
    render(<StationPinPicker lat="" lng="" onChange={() => {}} />);
    expect(screen.getByText("Click the map to drop the pin on the pump")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("typed coordinates place the marker and centre the map on them", () => {
    render(<StationPinPicker lat="18.5204303" lng="73.8567437" onChange={() => {}} followPin />);
    expect(L.marker).toHaveBeenCalledWith([18.5204303, 73.8567437], expect.anything());
    expect(fake.map.setView).toHaveBeenLastCalledWith([18.5204303, 73.8567437], 17);
  });

  it("changed coordinates move the same marker and re-centre, even while it is still on screen", () => {
    const view = render(<StationPinPicker lat="18.52" lng="73.85" onChange={() => {}} followPin />);
    view.rerender(<StationPinPicker lat="19.07" lng="72.87" onChange={() => {}} followPin />);
    expect(L.marker).toHaveBeenCalledTimes(1);
    expect(fake.marker.setLatLng).toHaveBeenLastCalledWith([19.07, 72.87]);
    expect(fake.map.setView).toHaveBeenLastCalledWith([19.07, 72.87], 17);
  });

  it("a click on the map is reported, and does not yank the view the vendor is already looking at", () => {
    const onChange = vi.fn();
    const view = render(<StationPinPicker lat="" lng="" onChange={onChange} followPin />);
    fake.handlers["map:click"]({ latlng: { lat: 18.601123, lng: 73.741234 } });
    expect(onChange).toHaveBeenCalledWith(18.601123, 73.741234);

    fake.map.setView.mockClear();
    view.rerender(<StationPinPicker lat="18.601123" lng="73.741234" onChange={onChange} followPin />);
    expect(fake.marker.addTo).toHaveBeenCalled();
    expect(fake.map.setView).not.toHaveBeenCalled();
  });
});
