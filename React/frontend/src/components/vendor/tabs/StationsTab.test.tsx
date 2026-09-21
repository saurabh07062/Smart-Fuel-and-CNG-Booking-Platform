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
import { useAuthStore } from "@/store/authStore";

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
  useAuthStore.setState({ user: null, isAuthenticated: false });
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

describe("Vendor Add Station shows only the fuels the vendor sells", () => {
  it("a petrol + diesel vendor sees and sends only petrol and diesel", async () => {
    useAuthStore.setState({ user: { id: "v1", role: "vendor", vendorFuelTypes: ["petrol", "diesel"] } as never });
    const user = userEvent.setup();
    render(<StationsTab />);
    await openAddForm(user);

    expect(screen.getByLabelText("Petrol Price")).toBeTruthy();
    expect(screen.getByLabelText("Diesel Price")).toBeTruthy();
    expect(screen.queryByLabelText("CNG Price")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Drop pin" }));
    await user.click(screen.getByRole("button", { name: /Create Station/ }));
    await waitFor(() => expect(createVendorStation).toHaveBeenCalledTimes(1));
    const sent = createVendorStation.mock.calls[0][0];
    expect(sent.fuelTypes).toEqual(["Petrol", "Diesel"]);
    expect(Object.keys(sent.prices)).toEqual(["petrol", "diesel"]);
  });

  it("a CNG-only vendor sees only CNG", async () => {
    useAuthStore.setState({ user: { id: "v1", role: "vendor", vendorFuelTypes: ["cng"] } as never });
    const user = userEvent.setup();
    render(<StationsTab />);
    await openAddForm(user);
    expect(screen.getByLabelText("CNG Price")).toBeTruthy();
    expect(screen.queryByLabelText("Petrol Price")).toBeNull();
    expect(screen.queryByLabelText("Diesel Price")).toBeNull();
  });

  it("station cards show prices only for the fuels that station sells", () => {
    useAuthStore.setState({ user: { id: "v1", role: "vendor", vendorFuelTypes: ["petrol", "diesel"] } as never });
    store.stations = [
      { _id: "s1", name: "Baner", address: "Baner", status: "Active", fuelTypes: ["Petrol", "Diesel"], prices: { petrol: 101, diesel: 92 } },
    ];
    render(<StationsTab />);
    expect(screen.getByText("petrol")).toBeTruthy();
    expect(screen.getByText("diesel")).toBeTruthy();
    expect(screen.queryByText("cng")).toBeNull();
  });

  it("an older vendor with no recorded fuels still sees all three", async () => {
    useAuthStore.setState({ user: { id: "v1", role: "vendor" } as never });
    const user = userEvent.setup();
    render(<StationsTab />);
    await openAddForm(user);
    for (const label of ["Petrol Price", "Diesel Price", "CNG Price"]) expect(screen.getByLabelText(label)).toBeTruthy();
  });
});

describe("Vendor Add Station typed latitude / longitude", () => {
  it("typing both coordinates places the pin and saves exactly what was typed", async () => {
    const user = userEvent.setup();
    render(<StationsTab />);
    await openAddForm(user);

    await user.type(screen.getByLabelText("Latitude"), "18.5204303");
    expect(screen.getByTestId("pin").textContent).toBe("none"); // one coordinate is not a location
    await user.type(screen.getByLabelText("Longitude"), "73.8567437");
    expect(screen.getByTestId("pin").textContent).toBe("18.5204303,73.8567437");
    expect(screen.getByTestId("pin-status").textContent).toContain("18.5204303, 73.8567437");

    await user.click(screen.getByRole("button", { name: /Create Station/ }));
    await waitFor(() => expect(createVendorStation).toHaveBeenCalledTimes(1));
    expect(createVendorStation.mock.calls[0][0]).toMatchObject({
      coordinates: { lat: 18.5204303, lng: 73.8567437 },
    });
  });

  it("changing a coordinate moves the pin", async () => {
    const user = userEvent.setup();
    render(<StationsTab />);
    await openAddForm(user);
    await user.type(screen.getByLabelText("Latitude"), "18.52");
    await user.type(screen.getByLabelText("Longitude"), "73.85");
    expect(screen.getByTestId("pin").textContent).toBe("18.52,73.85");

    await user.clear(screen.getByLabelText("Latitude"));
    await user.type(screen.getByLabelText("Latitude"), "19.07");
    expect(screen.getByTestId("pin").textContent).toBe("19.07,73.85");
  });

  it("refuses latitude outside -90..90 and longitude outside -180..180", async () => {
    const user = userEvent.setup();
    render(<StationsTab />);
    await openAddForm(user);

    await user.type(screen.getByLabelText("Latitude"), "95");
    await user.type(screen.getByLabelText("Longitude"), "-181");
    expect(screen.getByText("Latitude must be between -90 and 90.")).toBeTruthy();
    expect(screen.getByText("Longitude must be between -180 and 180.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Create Station/ }));
    expect(createVendorStation).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText("Latitude"));
    await user.type(screen.getByLabelText("Latitude"), "-90");
    await user.clear(screen.getByLabelText("Longitude"));
    await user.type(screen.getByLabelText("Longitude"), "180");
    expect(screen.queryByRole("alert")).toBeNull(); // the limits themselves are valid
  });

  it("refuses text that is not a number", async () => {
    const user = userEvent.setup();
    render(<StationsTab />);
    await openAddForm(user);
    await user.type(screen.getByLabelText("Latitude"), "18.5abc");
    expect(screen.getByText("Latitude must be a number.")).toBeTruthy();
  });

  it("a vendor with no stations sees the Add form open once the list has loaded", async () => {
    (store as Record<string, unknown>).loading = false;
    try {
      render(<StationsTab />);
      await waitFor(() => expect(screen.getByLabelText("Latitude")).toBeTruthy());
    } finally {
      delete (store as Record<string, unknown>).loading;
    }
  });
});
