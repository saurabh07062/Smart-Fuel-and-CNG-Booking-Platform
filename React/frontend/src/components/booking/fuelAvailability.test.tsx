import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { UiStation } from "@/types";
import { useBookingDraftStore } from "@/store/bookingDraftStore";
import FuelVehicleStep from "./FuelVehicleStep";

const station = (over: Partial<UiStation>): UiStation =>
  ({
    id: "s1",
    _id: "s1",
    name: "Torrent Gas CNG Station",
    address: "Wagholi",
    open: true,
    // The real data behind the bug: three fuels listed, only CNG priced.
    fuelTypes: ["Petrol", "Diesel", "CNG"],
    uiPrices: { Petrol: null, Diesel: null, CNG: 97.75 },
    queue: 0,
    waitTime: 0,
    distance: 1,
    ...over,
  }) as UiStation;

beforeEach(() => {
  useBookingDraftStore.getState().reset();
  vi.clearAllMocks();
});

const renderStep = (s: UiStation) =>
  render(<FuelVehicleStep station={s} vehicles={[]} onSaveVehicle={async () => null} savingVehicle={false} />);

describe("The wizard only offers fuels the station can actually serve", () => {
  it("picks the one priced fuel, and locks the unpriced ones", () => {
    renderStep(station({}));

    expect(useBookingDraftStore.getState().draft.fuelType).toBe("CNG");
    expect(screen.getByText("₹97.75/kg")).toBeTruthy(); // per kg, not per litre
    expect((screen.getByRole("button", { name: /Petrol/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Diesel/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /CNG/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByText("Not sold here")).toHaveLength(2);
  });

  it("replaces a fuel the link chose but the station cannot serve", () => {
    useBookingDraftStore.getState().patch({ fuelType: "Petrol" });
    renderStep(station({}));
    expect(useBookingDraftStore.getState().draft.fuelType).toBe("CNG");
  });

  it("says out of stock rather than not sold, when that is the reason", () => {
    renderStep(
      station({
        uiPrices: { Petrol: 104, Diesel: null, CNG: 97.75 },
        fuelAvailability: { petrol: false, diesel: true, cng: true },
      }),
    );
    expect(screen.getByText("Out of stock")).toBeTruthy();
    expect(useBookingDraftStore.getState().draft.fuelType).toBe("CNG");
  });
});
