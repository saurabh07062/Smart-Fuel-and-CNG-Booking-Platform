import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const loadStations = vi.fn(async () => {});
vi.mock("@/store/vendorStore", () => ({
  useVendorStore: (select: (s: { loadStations: typeof loadStations }) => unknown) => select({ loadStations }),
}));
vi.mock("@/services/api/vendorApi", () => ({ updateNozzleConfig: vi.fn(async () => ({ msg: "Nozzle setup saved" })) }));

import * as api from "@/services/api/vendorApi";
import NozzleModes, { nozzleSummary } from "./NozzleModes";

beforeEach(() => vi.clearAllMocks());

describe("Vendor nozzle assignment", () => {
  it("summarises each setup", () => {
    expect(nozzleSummary(null)).toBe("1 nozzle shared by app bookings and walk-ins");
    expect(nozzleSummary({ total: 4, online: 1 })).toBe("1 for app bookings · 3 for walk-ins");
    expect(nozzleSummary({ total: 4, online: 0 })).toBe("4 for walk-ins · no app booking");
    expect(nozzleSummary({ total: 1, online: 1 })).toBe("1 nozzle shared by app bookings and walk-ins");
    expect(nozzleSummary({ total: 4, online: 2 })).toBe("2 for app bookings · 2 for walk-ins");
    expect(nozzleSummary({ total: 2, online: 2 })).toBe("2 nozzles shared by app bookings and walk-ins");
  });

  it("shows one row per fuel the station sells, with its saved setup", () => {
    render(<NozzleModes station={{ _id: "st1", fuelTypes: ["Petrol", "CNG"], nozzleConfig: { petrol: { total: 4, online: 1 } } } as never} />);
    const petrol = screen.getByTestId("nozzle-petrol");
    expect((within(petrol).getByLabelText("Petrol total nozzles") as HTMLInputElement).value).toBe("4");
    expect(within(petrol).getByText("1 for app bookings · 3 for walk-ins")).toBeTruthy();
    expect(screen.getByTestId("nozzle-cng").textContent).toContain("shared");
    expect(screen.queryByTestId("nozzle-diesel")).toBeNull();
  });

  it("vendor enters 4 nozzles with 1 online and saves", async () => {
    render(<NozzleModes station={{ _id: "st1", fuelTypes: ["Petrol"] } as never} />);
    fireEvent.change(screen.getByLabelText("Petrol total nozzles"), { target: { value: "4" } });
    expect(screen.getByText("1 for app bookings · 3 for walk-ins")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateNozzleConfig).toHaveBeenCalledWith("st1", { petrol: { total: 4, online: 1 } }));
    expect(loadStations).toHaveBeenCalled();
  });

  it("online 0 makes the fuel walk-in only", async () => {
    render(<NozzleModes station={{ _id: "st1", fuelTypes: ["CNG"], nozzleConfig: { cng: { total: 2, online: 1 } } } as never} />);
    fireEvent.change(screen.getByLabelText("CNG online nozzles"), { target: { value: "0" } });
    expect(screen.getByText("2 for walk-ins · no app booking")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateNozzleConfig).toHaveBeenCalledWith("st1", { cng: { total: 2, online: 0 } }));
  });

  it("several nozzles can take app bookings, never more than the total", async () => {
    render(<NozzleModes station={{ _id: "st1", fuelTypes: ["Petrol"], nozzleConfig: { petrol: { total: 4, online: 1 } } } as never} />);
    fireEvent.change(screen.getByLabelText("Petrol online nozzles"), { target: { value: "2" } });
    expect(screen.getByText("2 for app bookings · 2 for walk-ins")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Petrol online nozzles"), { target: { value: "9" } });
    expect((screen.getByLabelText("Petrol online nozzles") as HTMLInputElement).value).toBe("4");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateNozzleConfig).toHaveBeenCalledWith("st1", { petrol: { total: 4, online: 4 } }));
  });

  it("no Save button until something changes", () => {
    render(<NozzleModes station={{ _id: "st1", fuelTypes: ["Petrol"], nozzleConfig: { petrol: { total: 4, online: 1 } } } as never} />);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
