import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const stationStore = vi.hoisted(() => ({
  stations: [] as Array<Record<string, unknown>>,
  loading: false,
  load: vi.fn(async () => {}),
}));
vi.mock("@/store/stationStore", () => ({
  useStationStore: (select: (s: typeof stationStore) => unknown) => select(stationStore),
}));
vi.mock("@/store/bookingStore", () => ({
  useBookingStore: (select: (s: Record<string, unknown>) => unknown) =>
    select({ bookings: [], showAll: false, setShowAll: vi.fn(), load: vi.fn(async () => {}) }),
}));
vi.mock("@/store/authStore", () => ({
  useAuthStore: (select: (s: Record<string, unknown>) => unknown) =>
    select({ user: { name: "Saurabh", vehicles: [], rewards: 0 } }),
}));
vi.mock("@/store/locationStore", () => ({
  useLocationStore: (select: (s: Record<string, unknown>) => unknown) =>
    select({
      coords: { lat: 18.58, lng: 73.97 },
      askLocation: false,
      locationAsked: vi.fn(),
      located: true,
      setCoords: vi.fn(),
      markGpsFailed: vi.fn(),
    }),
}));
vi.mock("@/hooks/useSocket", () => ({
  useWatchStations: () => {},
  useWatchStation: () => {},
  useSocketEvent: () => {},
  // The dashboard's shell now also keeps support chat live (useChatRealtime),
  // which subscribes to the reconnect resync.
  useResync: () => {},
}));
vi.mock("@/components/maps/StationsMap", () => ({ default: () => null }));
vi.mock("@/components/maps/LocationPicker", () => ({ default: () => null }));

import Dashboard from "./Dashboard";

const station = (over: Record<string, unknown>) => ({
  id: "s1",
  _id: "s1",
  name: "Petrol Only Pump",
  address: "Wagholi",
  open: true,
  fuelTypes: ["Petrol", "Diesel"],
  uiPrices: { Petrol: 96.72, Diesel: 89.62, CNG: null },
  queue: 0,
  waitTime: 0,
  distance: 1,
  lat: 18.58,
  lng: 73.97,
  reviews: 0,
  hours: "24 Hours",
  image: null,
  coordinates: { lat: 18.58, lng: 73.97 },
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("Choosing a fuel changes which pumps are shown", () => {
  it("lists only the pumps that sell, stock and price that fuel", () => {
    stationStore.stations = [
      station({}),
      station({ id: "s2", _id: "s2", name: "CNG Only Pump", fuelTypes: ["CNG"], uiPrices: { Petrol: null, Diesel: null, CNG: 99 } }),
    ];
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    // Petrol is the default: the CNG-only pump is not an answer to it.
    const list = () => within(screen.getByTestId("pump-list"));
    expect(list().getByText("Petrol Only Pump")).toBeTruthy();
    expect(list().queryByText("CNG Only Pump")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /CNG/ }));

    expect(list().getByText("CNG Only Pump")).toBeTruthy();
    expect(list().queryByText("Petrol Only Pump")).toBeNull();
    // And the heading follows the choice.
    expect(screen.getByText(/Nearest CNG Pump/)).toBeTruthy();
  });

  it("drops a pump whose fuel is marked out of stock", () => {
    stationStore.stations = [
      station({ fuelAvailability: { petrol: false, diesel: true, cng: false } }),
    ];
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    // Petrol is out of stock here, so nothing is offered for petrol at all.
    expect(screen.queryByTestId("pump-list")).toBeNull();
    expect(screen.queryByText("Petrol Only Pump")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /Diesel/ }));
    expect(within(screen.getByTestId("pump-list")).getByText("Petrol Only Pump")).toBeTruthy();
  });
});
