import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const store = vi.hoisted(() => ({
  stations: [
    {
      _id: "st1",
      name: "Audit Fuels",
      inventoryStatus: {
        petrol: { current: 4000, capacity: 10000, unit: "L", percent: 40, label: "Normal", tier: "normal", committed: 0, available: 4000 },
        diesel: { current: 0, capacity: null, unit: "L", percent: null, label: "Out of stock", tier: "out_of_stock", committed: 0, available: 0 },
      },
    },
  ] as Array<Record<string, unknown>>,
  loadStations: vi.fn(async () => {}),
  inventoryAlerts: [] as unknown[],
  loadInventoryAlerts: vi.fn(async () => {}),
}));
vi.mock("@/store/vendorStore", () => ({
  useVendorStore: (select: (s: typeof store) => unknown) => select(store),
}));
vi.mock("@/services/api/vendorApi", () => ({
  updateInventory: vi.fn(async () => ({ msg: "ok" })),
  fetchInventoryMovements: vi.fn(async () => []),
  resetInventory: vi.fn(async () => ({ msg: "Petrol inventory cleared", historyRemoved: 3 })),
}));

import * as api from "@/services/api/vendorApi";
import InventoryTab from "./InventoryTab";

beforeEach(() => vi.clearAllMocks());

describe("Reset inventory", () => {
  it("asks first, and clears nothing when the vendor backs out", async () => {
    render(<InventoryTab />);
    fireEvent.click(screen.getByTestId("reset-inventory-petrol"));
    expect(screen.getByText("Clear all Petrol inventory?")).toBeTruthy();
    expect(api.resetInventory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByText("Clear all Petrol inventory?")).toBeNull();
    expect(api.resetInventory).not.toHaveBeenCalled();
  });

  it("clears that one fuel after the confirmation", async () => {
    render(<InventoryTab />);
    fireEvent.click(screen.getByTestId("reset-inventory-petrol"));
    fireEvent.click(screen.getByTestId("reset-confirm-petrol"));
    await waitFor(() => expect(api.resetInventory).toHaveBeenCalledWith("st1", "petrol"));
    expect(api.resetInventory).toHaveBeenCalledTimes(1);
    // The tab reloads its stations and alerts afterwards.
    await waitFor(() => expect(store.loadStations).toHaveBeenCalled());
  });

  it("warns what is deleted, and each fuel has its own button", () => {
    render(<InventoryTab />);
    fireEvent.click(screen.getByTestId("reset-inventory-diesel"));
    const warning = screen.getByRole("alertdialog", { name: "Clear Diesel inventory" });
    expect(within(warning).getByText(/cannot be undone/)).toBeTruthy();
    expect(within(warning).getByText(/Other fuels are not touched/)).toBeTruthy();
    // Petrol's own confirmation is not open.
    expect(screen.queryByText("Clear all Petrol inventory?")).toBeNull();
  });
});
