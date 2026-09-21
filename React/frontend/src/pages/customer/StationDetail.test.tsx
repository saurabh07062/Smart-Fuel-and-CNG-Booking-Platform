import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/services/api/stationApi", () => ({ fetchStationById: vi.fn(), fetchStations: vi.fn() }));
vi.mock("@/hooks/useSocket", () => ({ useWatchStation: vi.fn() }));
vi.mock("@/components/layout/Layout", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/maps/StationsMap", () => ({ default: () => null }));

import * as stationApi from "@/services/api/stationApi";
import { useStationStore } from "@/store/stationStore";
import { mapBackendStation } from "@/utils/station";
import type { Station, UiStation } from "@/types";
import StationDetail from "./StationDetail";

const fetchStationById = vi.mocked(stationApi.fetchStationById);

const raw = (over: Record<string, unknown>) =>
  ({
    _id: "s1",
    name: "Baner Fuels",
    address: "Baner Road",
    status: "Active",
    fuelTypes: ["Petrol"],
    prices: { petrol: 100 },
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...over,
  }) as unknown as Station & Record<string, unknown>;
const ui = (over: Record<string, unknown>) => mapBackendStation(raw(over)) as UiStation;

const open = () =>
  render(
    <MemoryRouter initialEntries={["/stations/s1"]}>
      <Routes>
        <Route path="/stations/:id" element={<StationDetail />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  useStationStore.setState({ stations: [], selected: null, loading: false, error: null });
});

describe("Station detail shows the latest data", () => {
  it("refetches a station already held in the list store, and the store (and so the list) updates too", async () => {
    useStationStore.setState({ stations: [ui({})] });
    fetchStationById.mockResolvedValue(
      ui({ name: "Baner Fuels & CNG", pumpImages: { petrol: "/uploads/stations/stations-1-aaaaaaaaaaaaaaaa.png" }, updatedAt: "2026-09-02T10:00:00.000Z" }),
    );
    open();

    expect(screen.getByRole("heading", { name: "Baner Fuels" })).toBeTruthy(); // what was held, at once
    await screen.findByRole("heading", { name: "Baner Fuels & CNG" });
    expect(fetchStationById).toHaveBeenCalledWith("s1");
    // The pump photo is the page cover now; there is no separate "Pump photos" section.
    expect(screen.queryByRole("region", { name: "Pump photos" })).toBeNull();
    expect(useStationStore.getState().stations[0].name).toBe("Baner Fuels & CNG");
  });

  it("opened directly, the fetched station goes into the store so live events can patch it", async () => {
    fetchStationById.mockResolvedValue(ui({}));
    open();
    await screen.findByRole("heading", { name: "Baner Fuels" });
    expect(useStationStore.getState().stations.map((s) => s.id)).toEqual(["s1"]);

    // A station:updated event (what useRealtimeSync does) shows without a reload.
    useStationStore.getState().patchStation(raw({ name: "Renamed live", updatedAt: "2026-09-03T10:00:00.000Z" }));
    await screen.findByRole("heading", { name: "Renamed live" });
  });

  it("a failed refetch keeps a station already on screen instead of an error page", async () => {
    useStationStore.setState({ stations: [ui({})] });
    fetchStationById.mockRejectedValue(new Error("offline"));
    open();
    await waitFor(() => expect(fetchStationById).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: "Baner Fuels" })).toBeTruthy();
    expect(screen.queryByText("Could not load this station.")).toBeNull();
  });

  it("shows the error when there is nothing to show", async () => {
    fetchStationById.mockRejectedValue(new Error("offline"));
    open();
    await screen.findByText("Could not load this station.");
  });
});
