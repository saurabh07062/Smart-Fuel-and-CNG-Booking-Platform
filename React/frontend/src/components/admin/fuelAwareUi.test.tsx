import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

const store = vi.hoisted(() => ({
  stations: [] as Array<Record<string, unknown>>,
  loadStations: vi.fn(async () => {}),
  stationsError: null as string | null,
}));
vi.mock("@/store/adminStore", () => ({
  useAdminStore: (select: (s: typeof store) => unknown) => select(store),
}));
vi.mock("@/services/api/adminApi", () => ({
  createStationAdmin: vi.fn(),
  updateStationAdmin: vi.fn(),
  deleteStationAdmin: vi.fn(),
  toggleStationStatusAdmin: vi.fn(),
}));
vi.mock("@/components/maps/StationPinPicker", () => ({ default: () => null }));

import AdminStationsTab from "./AdminStationsTab";
import StationImagesEditor from "@/components/vendor/StationImagesEditor";

const station = (over: Record<string, unknown>) => ({
  _id: "s1",
  name: "Torrent Gas",
  address: "Wagholi",
  status: "Active",
  prices: { petrol: 0, diesel: 0, cng: 101 },
  coordinates: { lat: 18.58, lng: 73.97 },
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("A CNG-only station shows CNG only", () => {
  it("the admin's station card drops petrol and diesel", () => {
    store.stations = [station({ fuelTypes: ["CNG"] })];
    render(<AdminStationsTab />);
    const card = screen.getByText("Torrent Gas").closest("div")!.parentElement!;
    expect(within(card).getByText("CNG")).toBeTruthy();
    expect(within(card).queryByText("PETROL")).toBeNull();
    expect(within(card).queryByText("DIESEL")).toBeNull();
    expect(within(card).getByText("₹101")).toBeTruthy();
  });

  it("a station that sells all three still shows all three", () => {
    store.stations = [station({ _id: "s2", name: "Bharat Petroleum", fuelTypes: ["Petrol", "Diesel", "CNG"], prices: { petrol: 120, diesel: 101, cng: 0 } })];
    render(<AdminStationsTab />);
    expect(screen.getByText("PETROL")).toBeTruthy();
    expect(screen.getByText("DIESEL")).toBeTruthy();
    expect(screen.getByText("CNG")).toBeTruthy();
    // A fuel sold but never priced reads "Not set", not ₹0.
    expect(screen.getByText("Not set")).toBeTruthy();
    expect(screen.queryByText("₹0")).toBeNull();
  });

  it("the pump photo upload asks only for the CNG photo", () => {
    render(<StationImagesEditor station={{ _id: "s1", fuelTypes: ["CNG"], pumpImages: {} } as never} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText("CNG Pump Image")).toBeTruthy();
    expect(screen.queryByText("Petrol Pump Image")).toBeNull();
  });

  it("a petrol-and-diesel station is not asked for a CNG photo", () => {
    render(<StationImagesEditor station={{ _id: "s2", fuelTypes: ["Petrol", "Diesel"], pumpImages: {} } as never} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText("Petrol Pump Image")).toBeTruthy();
    expect(screen.queryByText("CNG Pump Image")).toBeNull();
  });
});

/** The card's photo is decorative (alt=""), so it is read off the DOM. */
const photoSrc = (container: HTMLElement) => container.querySelector("img")?.getAttribute("src") ?? null;

describe("Station photo on the admin card", () => {
  it("uses the pump photo when the station has no photo of its own", () => {
    store.stations = [station({ fuelTypes: ["Petrol"], images: [], pumpImages: { petrol: "/uploads/stations/pump.png" } })];
    const { container } = render(<AdminStationsTab />);
    expect(photoSrc(container)).toBe("/uploads/stations/pump.png");
  });

  it("the station's own photo still wins", () => {
    store.stations = [
      station({ fuelTypes: ["Petrol"], images: ["/uploads/stations/main.png"], pumpImages: { petrol: "/uploads/stations/pump.png" } }),
    ];
    const { container } = render(<AdminStationsTab />);
    expect(photoSrc(container)).toBe("/uploads/stations/main.png");
  });

  it("with no photo at all, the pump icon stays", () => {
    store.stations = [station({ fuelTypes: ["CNG"], images: [], pumpImages: {} })];
    const { container } = render(<AdminStationsTab />);
    expect(photoSrc(container)).toBeNull();
    expect(container.querySelector(".fa-gas-pump")).toBeTruthy();
  });
});
