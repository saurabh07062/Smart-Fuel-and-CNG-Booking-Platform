import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const store = vi.hoisted(() => ({
  dashboard: null as Record<string, unknown> | null,
  loadTab: vi.fn(async () => {}),
}));
vi.mock("@/store/vendorStore", () => ({
  useVendorStore: (select: (s: typeof store) => unknown) => select(store),
}));

import DashboardTab from "./DashboardTab";

beforeEach(() => {
  store.dashboard = {
    todaysRevenue: 25450,
    monthlySales: 312000,
    todaysBookings: 4,
    fuelStock: { petrol: 1000, diesel: 500, cng: 200 },
    awaitingCollection: { count: 2, amount: 1010 },
  };
});

describe("Vendor dashboard income", () => {
  it("each amount hides and shows on its own eye", () => {
    render(<DashboardTab />);
    expect(document.body.textContent).toContain("₹ ••••••");
    expect(screen.queryByText("₹25,450.00")).toBeNull();
    expect(screen.queryByText("₹3,12,000.00")).toBeNull();

    // This month's eye reveals only this month's figure.
    fireEvent.click(screen.getByRole("button", { name: "Show this month's revenue" }));
    expect(screen.getByText("₹3,12,000.00")).toBeTruthy();
    expect(screen.queryByText("₹25,450.00")).toBeNull();
    expect(screen.queryByText("₹1,010.00")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show today's revenue" }));
    expect(screen.getByText("₹25,450.00")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide today's revenue" }));
    expect(screen.queryByText("₹25,450.00")).toBeNull();
    expect(screen.getByText("₹3,12,000.00")).toBeTruthy();
  });

  it("figures that are not money are always visible", () => {
    render(<DashboardTab />);
    expect(screen.getByText("4")).toBeTruthy(); // today's bookings
  });
});
