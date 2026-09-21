import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/services/api/vendorApi", () => ({ updateVendorStation: vi.fn() }));
vi.mock("@/services/api/authApi", () => ({ logoutRequest: vi.fn() }));
vi.mock("@/services/socket/socket", () => ({ disconnectSocket: vi.fn(), getSocket: vi.fn(), isNewer: () => true }));
// Leaflet does not run in jsdom: a stand-in that shows the pin it was given.
vi.mock("@/components/maps/StationPinPicker", () => ({
  default: ({ lat, lng, onChange }: { lat: string; lng: string; onChange: (a: number, b: number) => void }) => (
    <div>
      <span data-testid="pin">{`${lat},${lng}`}</span>
      <button type="button" onClick={() => onChange(18.5805631, 73.9753421)}>
        Drop pin
      </button>
    </div>
  ),
}));

import * as api from "@/services/api/vendorApi";
import type { VendorStation } from "@/services/api/vendorApi";
import { useAuthStore } from "@/store/authStore";
import { parseCoordinatePair } from "@/utils/coordinates";
import StationDetailsEditor from "./StationDetailsEditor";

const update = vi.mocked(api.updateVendorStation);

const STATION = {
  _id: "st1",
  name: ".IndianOil",
  address: "Ground Floor, Haveli, SH-60, Wagholi",
  openingHours: "24 Hours",
  status: "Active",
  fuelTypes: ["Petrol", "Diesel", "CNG"],
  prices: {},
  coordinates: { lat: 18.582535014511407, lng: 73.975371 },
} as unknown as VendorStation;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  update.mockResolvedValue(STATION);
  useAuthStore.setState({ user: { id: "v1", role: "vendor", vendorFuelTypes: ["petrol", "diesel", "cng"] } as never, isAuthenticated: true });
});

describe("parseCoordinatePair", () => {
  it("reads the pair Google Maps copies", () => {
    expect(parseCoordinatePair("18.580563, 73.975342")).toEqual({ lat: "18.580563", lng: "73.975342" });
    expect(parseCoordinatePair(" (18.58,73.97) ")).toEqual({ lat: "18.58", lng: "73.97" });
    expect(parseCoordinatePair("-33.86 151.21")).toEqual({ lat: "-33.86", lng: "151.21" });
  });
  it("is not fooled by a single number or out-of-range values", () => {
    expect(parseCoordinatePair("18.580563")).toBeNull();
    expect(parseCoordinatePair("95, 73")).toBeNull();
    expect(parseCoordinatePair("abc, def")).toBeNull();
  });
});

describe("Edit Station details", () => {
  it("opens with the station's saved details and location", () => {
    render(<StationDetailsEditor station={STATION} onSaved={() => {}} />);
    expect((screen.getByLabelText("Station Name") as HTMLInputElement).value).toBe(".IndianOil");
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toContain("Wagholi");
    expect((screen.getByLabelText("Latitude") as HTMLInputElement).value).toBe("18.582535014511407");
    expect((screen.getByLabelText("Longitude") as HTMLInputElement).value).toBe("73.975371");
    expect(screen.getByTestId("pin").textContent).toBe("18.582535014511407,73.975371");
  });

  it("closes itself after a successful save, and stays open when the save fails", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(<StationDetailsEditor station={STATION} onSaved={onSaved} onClose={onClose} />);

    update.mockRejectedValueOnce({ response: { data: { msg: "Latitude must be a number between -90 and 90." } } });
    await user.click(screen.getByRole("button", { name: /Save Details/ }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Save Details/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSaved.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("pasting the Google Maps pair into one box fills both, shows the move, and saves it", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<StationDetailsEditor station={STATION} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "18.580563, 73.975342" } });
    expect((screen.getByLabelText("Latitude") as HTMLInputElement).value).toBe("18.580563");
    expect((screen.getByLabelText("Longitude") as HTMLInputElement).value).toBe("73.975342");
    expect(screen.getByTestId("location-moved").textContent).toContain("to 18.580563, 73.975342");

    await user.click(screen.getByRole("button", { name: /Save Details/ }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith("st1", {
      name: ".IndianOil",
      address: "Ground Floor, Haveli, SH-60, Wagholi",
      openingHours: "24 Hours",
      fuelTypes: ["Petrol", "Diesel", "CNG"],
      coordinates: { lat: 18.580563, lng: 73.975342 },
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("edits name, hours, fuels, and a pin dropped on the map", async () => {
    const user = userEvent.setup();
    render(<StationDetailsEditor station={STATION} onSaved={() => {}} />);
    await user.clear(screen.getByLabelText("Station Name"));
    await user.type(screen.getByLabelText("Station Name"), "IndianOil Wagholi");
    await user.clear(screen.getByLabelText("Opening Hours"));
    await user.type(screen.getByLabelText("Opening Hours"), "06:00-22:00");
    await user.click(screen.getByRole("checkbox", { name: "CNG" }));
    await user.click(screen.getByRole("button", { name: "Drop pin" }));
    await user.click(screen.getByRole("button", { name: /Save Details/ }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1]).toMatchObject({
      name: "IndianOil Wagholi",
      openingHours: "06:00-22:00",
      fuelTypes: ["Petrol", "Diesel"],
      coordinates: { lat: 18.580563, lng: 73.975342 },
    });
  });

  it("a move over 200 m is flagged and must be confirmed; declining saves nothing", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<StationDetailsEditor station={STATION} onSaved={() => {}} />);

    // The wrong paste from this session: about 1 km from the saved pin.
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "18.5717712, 73.9748866" } });
    expect(screen.getByTestId("large-move").textContent).toMatch(/km from the saved location/);
    await user.click(screen.getByRole("button", { name: /Save Details/ }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain("18.5717712, 73.9748866");
    expect(update).not.toHaveBeenCalled();
  });

  it("a small correction is not flagged", () => {
    render(<StationDetailsEditor station={{ ...STATION, coordinates: { lat: 18.5805, lng: 73.9753 } } as never} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "18.5805621, 73.9753407" } });
    expect(screen.queryByTestId("large-move")).toBeNull();
    expect(screen.getByTestId("location-moved")).toBeTruthy();
  });

  it("warns when the new point is the person's own current location", () => {
    localStorage.setItem("fm_user_lat", "18.5717712");
    localStorage.setItem("fm_user_lng", "73.9843486");
    render(<StationDetailsEditor station={STATION} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "18.5720811, 73.9843519" } });
    expect(screen.getByTestId("near-device").textContent).toMatch(/where you are right now/);
  });

  it("sends the station's updatedAt so a stale form cannot overwrite newer data", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <StationDetailsEditor station={{ ...STATION, updatedAt: "2026-09-17T12:47:08.042Z" } as never} onSaved={() => {}} onClose={onClose} />,
    );
    update.mockRejectedValueOnce({ response: { status: 409, data: { msg: "This station was changed after you opened the form.", reason: "STALE_EDIT" } } });
    await user.click(screen.getByRole("button", { name: /Save Details/ }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1].expectedUpdatedAt).toBe("2026-09-17T12:47:08.042Z");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers only the fuels the vendor registered for", () => {
    useAuthStore.setState({ user: { id: "v1", role: "vendor", vendorFuelTypes: ["petrol", "diesel"] } as never });
    render(<StationDetailsEditor station={STATION} onSaved={() => {}} />);
    expect(screen.getByRole("checkbox", { name: "Petrol" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "CNG" })).toBeNull();
  });

  it("refuses an out-of-range latitude, an empty name and no fuels without calling the API", async () => {
    const user = userEvent.setup();
    render(<StationDetailsEditor station={STATION} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "95" } });
    expect(screen.getByText("Latitude must be between -90 and 90.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Save Details/ }));
    expect(update).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "18.58" } });
    await user.clear(screen.getByLabelText("Station Name"));
    await user.click(screen.getByRole("button", { name: /Save Details/ }));
    expect(update).not.toHaveBeenCalled();
  });
});
