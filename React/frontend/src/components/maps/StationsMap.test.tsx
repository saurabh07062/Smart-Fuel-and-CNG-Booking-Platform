import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * The customer station map: one pump pin per station with real coordinates
 * (red open, slate closed), the customer's dot, Map / Satellite, click to open.
 * Leaflet cannot draw in jsdom; what is checked is what it is asked to draw.
 */
const fake = vi.hoisted(() => {
  const markers: Array<{ latlng: unknown; opts: Record<string, unknown>; handlers: Record<string, () => void> }> = [];
  const map = {
    removeLayer: vi.fn(),
    fitBounds: vi.fn(),
    setView: vi.fn(),
  };
  return { markers, map };
});

vi.mock("leaflet", () => {
  const layer = () => ({ addTo: vi.fn(function (this: unknown) { return this; }), remove: vi.fn() });
  return {
    default: {
      marker: vi.fn((latlng: unknown, opts: Record<string, unknown>) => {
        const m = {
          latlng,
          opts,
          handlers: {} as Record<string, () => void>,
          addTo() {
            return this;
          },
          bindTooltip: vi.fn(),
          on(event: string, fn: () => void) {
            this.handlers[event] = fn;
          },
        };
        fake.markers.push(m);
        return m;
      }),
      divIcon: vi.fn((o: { html: string }) => ({ html: o.html })),
      latLngBounds: vi.fn((pts: unknown) => pts),
      tileLayer: vi.fn(layer),
      control: { scale: vi.fn(layer) },
    },
  };
});
vi.mock("@/hooks/useLeafletMap", () => ({
  PUNE: [18.52, 73.85],
  useLeafletMap: () => ({ containerRef: { current: null }, mapRef: { current: fake.map }, ready: true }),
}));
const navigate = vi.fn();
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));

import L from "leaflet";
import type { UiStation } from "@/types";
import StationsMap from "./StationsMap";

const station = (id: string, over: Partial<UiStation> = {}) =>
  ({ id, _id: id, name: `Pump ${id}`, lat: 18.5, lng: 73.8, open: true, queue: 2, waitTime: 6, distance: 1.2, ...over }) as UiStation;

const draw = (props: Parameters<typeof StationsMap>[0]) =>
  render(
    <MemoryRouter>
      <StationsMap {...props} />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  fake.markers.length = 0;
});

describe("StationsMap", () => {
  it("draws a red pin for open and a slate pin for closed stations, skipping ones without a location", () => {
    draw({
      stations: [station("a"), station("b", { open: false, lat: 18.6, lng: 73.9 }), station("c", { lat: null, lng: null })],
    });
    const pins = fake.markers.filter((m) => m.opts.title !== "You are here");
    expect(pins.map((m) => m.opts.title)).toEqual(["Pump a", "Pump b"]);
    expect(String((pins[0].opts.icon as { html: string }).html)).toContain("#e23744");
    expect(String((pins[1].opts.icon as { html: string }).html)).toContain("#64748b");
    expect(fake.map.fitBounds).toHaveBeenCalled();
  });

  it("open-station pins turn green with the green app colour; closed stay slate", async () => {
    const { useUiStore } = await import("@/store/uiStore");
    useUiStore.getState().setAccent("green");
    try {
      draw({ stations: [station("a"), station("b", { open: false, lat: 18.6, lng: 73.9 })] });
      const pins = fake.markers.filter((m) => m.opts.title !== "You are here");
      expect(String((pins[0].opts.icon as { html: string }).html)).toContain("#1a8f4a");
      expect(String((pins[1].opts.icon as { html: string }).html)).toContain("#64748b");
    } finally {
      useUiStore.getState().setAccent("red");
    }
  });

  it("clicking a pin opens that station", () => {
    draw({ stations: [station("a"), station("b", { lat: 18.6 })] });
    fake.markers[0].handlers.click();
    expect(navigate).toHaveBeenCalledWith("/stations/a");
  });

  it("shows the customer's location and keeps it in view", () => {
    draw({ stations: [station("a")], userCoords: { lat: 18.53, lng: 73.86 } });
    expect(fake.markers.some((m) => m.opts.title === "You are here")).toBe(true);
    expect(fake.map.fitBounds).toHaveBeenCalledWith(
      expect.arrayContaining([[18.53, 73.86]]),
      expect.anything(),
    );
    expect(screen.getByText("You")).toBeTruthy();
  });

  it("no stations and no location: centred on Pune", () => {
    draw({ stations: [] });
    expect(fake.map.setView).toHaveBeenCalledWith([18.52, 73.85], 12);
  });

  it("has the Map / Satellite switch", () => {
    draw({ stations: [station("a")] });
    fireEvent.click(screen.getByRole("button", { name: "Satellite" }));
    expect(vi.mocked(L.tileLayer).mock.calls.some((c) => String(c[0]).includes("World_Imagery"))).toBe(true);
  });
});
