import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/components/layout/Layout", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/maps/StationsMap", () => ({ default: () => null }));
vi.mock("@/hooks/useSocket", () => ({ useWatchStations: () => {} }));

import Stations from "./Stations";
import StationCard from "@/components/station/StationCard";
import { useStationStore } from "@/store/stationStore";
import type { UiStation } from "@/types";

const station = (over: Partial<UiStation>): UiStation =>
  ({
    id: "s1",
    _id: "s1",
    name: "Station",
    address: "Road",
    open: true,
    fuelTypes: ["Petrol"],
    uiPrices: { Petrol: 100, Diesel: null, CNG: null },
    queue: 0,
    waitTime: 0,
    queueStatus: "Low",
    distance: 1,
    ...over,
  }) as UiStation;

const inRouter = (ui: React.ReactNode) =>
  render(
    <MemoryRouter initialEntries={["/stations"]}>
      <Routes>
        <Route path="/stations" element={ui} />
        <Route path="/nearest-pump" element={<p>Nearest page</p>} />
        <Route path="/booking" element={<p>Booking page</p>} />
      </Routes>
    </MemoryRouter>,
  );

describe("Station card", () => {
  it("an out-of-stock station offers 'Try nearby' instead of a dead Book button", () => {
    inRouter(<StationCard station={station({ fuelAvailability: { petrol: false, diesel: true, cng: true } })} />);
    expect(screen.getAllByText("Out of stock").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Book Now/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Try nearby/ }));
    expect(screen.getByText("Nearest page")).toBeTruthy();
  });

  it("a closed station also offers 'Try nearby'", () => {
    inRouter(<StationCard station={station({ open: false })} />);
    expect(screen.getByText("Closed")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Try nearby/ })).toBeTruthy();
  });

  it("an open, stocked station books, with the price per litre", () => {
    inRouter(<StationCard station={station({ fuelAvailability: { petrol: true, diesel: true, cng: true } })} />);
    expect(screen.getByText("₹100.00/L")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Book Now/ }));
    expect(screen.getByText("Booking page")).toBeTruthy();
  });
});

describe("Stations filters", () => {
  beforeEach(() => {
    useStationStore.setState({
      stations: [
        station({ id: "a", _id: "a", name: "Open Low" }),
        station({ id: "b", _id: "b", name: "Closed One", open: false }),
        station({ id: "c", _id: "c", name: "Busy One", queueStatus: "High" }),
        station({ id: "d", _id: "d", name: "Diesel Only", fuelTypes: ["Diesel"], uiPrices: { Petrol: null, Diesel: 90, CNG: null } }),
      ],
      loading: false,
      error: null,
      filter: "all",
      load: async () => {},
    } as never);
  });

  const names = () => screen.queryAllByRole("heading", { level: 3 }).map((h) => h.textContent);

  it("Open now, Low queue and Diesel narrow the list", () => {
    inRouter(<Stations />);
    expect(names()).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: /Open now/ }));
    expect(names()).not.toContain("Closed One");
    fireEvent.click(screen.getByRole("button", { name: /Low queue/ }));
    expect(names()).toEqual(expect.arrayContaining(["Open Low", "Diesel Only"]));
    expect(names()).not.toContain("Busy One");
    fireEvent.click(screen.getByRole("button", { name: /Diesel/ }));
    expect(names()).toEqual(["Diesel Only"]);
  });
});
