import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The vendor store, reduced to what the Stations tab reads.
const store = vi.hoisted(() => ({
  stations: [] as Array<Record<string, unknown>>,
  loadStations: vi.fn(async () => {}),
  viewStationBookings: vi.fn(async () => {}),
  setTab: vi.fn(async () => {}),
  openPriceHistory: vi.fn(async () => {}),
}));
vi.mock("@/store/vendorStore", () => ({
  useVendorStore: (select: (s: typeof store) => unknown) => select(store),
}));
vi.mock("@/components/vendor/PriceHistoryModal", () => ({ default: () => null }));

// Leaflet does not run in jsdom: a stand-in picker that shows the pin and can drop one.
vi.mock("@/components/maps/StationPinPicker", () => ({
  default: ({ lat, lng, onChange }: { lat: string; lng: string; onChange: (lat: number, lng: number) => void }) => (
    <div>
      <span data-testid="pin">{lat && lng ? `${lat},${lng}` : "none"}</span>
      <button type="button" onClick={() => onChange(18.601123, 73.741234)}>
        Drop pin
      </button>
    </div>
  ),
}));

vi.mock("@/services/api/vendorApi", () => ({
  createVendorStation: vi.fn(async () => ({})),
  fetchVendorProfile: vi.fn(async () => ({})),
  toggleVendorStationStatus: vi.fn(),
  deleteVendorStation: vi.fn(),
}));
vi.mock("@/utils/geo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/geo")>()),
  getFreshUserCoords: vi.fn(async () => null),
}));

import * as api from "@/services/api/vendorApi";
import * as geo from "@/utils/geo";
import StationsTab from "./StationsTab";

const createVendorStation = vi.mocked(api.createVendorStation);
const fetchVendorProfile = vi.mocked(api.fetchVendorProfile);

async function openAddForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Add Station" }));
  await user.type(screen.getByPlaceholderText("e.g. FuelMart Highway Station"), "Baner Fuels");
  await user.type(screen.getByPlaceholderText("e.g. Highway Road, City"), "Baner Road, Pune");
}

beforeEach(() => {
  vi.clearAllMocks();
  store.stations = [];
  fetchVendorProfile.mockResolvedValue({} as never);
});

describe("Vendor Add Station location", () => {
  it("will not create a station until its location is pinned", async () => {
    const user = userEvent.setup();
    render(<StationsTab />);
    await openAddForm(user);

    expect(screen.getByTestId("pin").textContent).toBe("none");
    await user.click(screen.getByRole("button", { name: /Create Station/ }));

    expect(createVendorStation).not.toHaveBeenCalled();
  });

  it("sends the pinned coordinates with the new station", async () => {
    const user = userEvent.setup();
    render(<StationsTab />);
    await openAddForm(user);

    await user.click(screen.getByRole("button", { name: "Drop pin" }));
    expect(screen.getByTestId("pin-status").textContent).toContain("18.601123, 73.741234");
    await user.click(screen.getByRole("button", { name: /Create Station/ }));

    await waitFor(() => expect(createVendorStation).toHaveBeenCalledTimes(1));
    expect(createVendorStation.mock.calls[0][0]).toMatchObject({
      name: "Baner Fuels",
      address: "Baner Road, Pune",
      coordinates: { lat: 18.601123, lng: 73.741234 },
    });
    expect(store.loadStations).toHaveBeenCalled();
  });

  it("a vendor's first station starts from the pin dropped at registration", async () => {
    const user = userEvent.setup();
    fetchVendorProfile.mockResolvedValue({ registrationLocation: { lat: 18.5913, lng: 73.7389 } } as never);
    render(<StationsTab />);
    await user.click(screen.getByRole("button", { name: "Add Station" }));

    await waitFor(() => expect(screen.getByTestId("pin").textContent).toBe("18.5913,73.7389"));
  });

  it("a later station does not reuse the registration pin", async () => {
    const user = userEvent.setup();
    store.stations = [{ _id: "s1", name: "Existing", address: "Somewhere", status: "Active", prices: {} }];
    fetchVendorProfile.mockResolvedValue({ registrationLocation: { lat: 18.5913, lng: 73.7389 } } as never);
    render(<StationsTab />);
    await user.click(screen.getByRole("button", { name: "Add Station" }));

    expect(fetchVendorProfile).not.toHaveBeenCalled();
    expect(screen.getByTestId("pin").textContent).toBe("none");
  });

  it("'Use my location' sets the pin from the device, and says so when it cannot", async () => {
    const user = userEvent.setup();
    const fresh = vi.mocked(geo.getFreshUserCoords);
    render(<StationsTab />);
    await openAddForm(user);

    await user.click(screen.getByRole("button", { name: /Use my location/ }));
    expect(screen.getByTestId("pin").textContent).toBe("none");

    fresh.mockResolvedValueOnce({ lat: 18.55, lng: 73.8 } as never);
    await user.click(screen.getByRole("button", { name: /Use my location/ }));
    await waitFor(() => expect(screen.getByTestId("pin").textContent).toBe("18.550000,73.800000"));
  });
});
