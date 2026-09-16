import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { VendorRevenue } from "@/services/api/vendorApi";

const store = vi.hoisted(() => ({ revenue: null as unknown, loadTab: vi.fn() }));
vi.mock("@/store/vendorStore", () => ({
  useVendorStore: (select: (s: typeof store) => unknown) => select(store),
}));

import RevenueTab from "./RevenueTab";

const revenue: VendorRevenue = {
  todaysRevenue: 213,
  weeklyRevenue: 213,
  monthlyRevenue: 213,
  allTimeRevenue: 213,
  transactions: { today: 1, week: 1, month: 1, allTime: 1 },
  monthBreakdown: { fuelValue: 208, fees: 5, quantity: 2 },
  totalBookings: 1,
  fuelSales: { Petrol: { quantity: 2, revenue: 213, transactions: 1 } },
  awaitingCollection: { count: 1, amount: 108.4 },
  basis: "Completed bookings whose payment was received",
  asOf: "2026-09-14T06:00:00Z",
};

describe("Vendor revenue tab", () => {
  it("shows the server's real revenue, transactions and awaiting collection, with no estimated profit", () => {
    store.revenue = revenue;
    render(<RevenueTab />);
    const text = document.body.textContent || "";

    expect(text).not.toContain("Estimated Profit");
    expect(text).not.toContain("8% margin");
    expect(text).toContain("Today's Revenue · 1 paid");
    expect(text).toContain("₹213.00");
    expect(text).toContain("Awaiting Collection · 1 booking");
    expect(text).toContain("₹108.40");
    expect(text).toContain("₹208.00 + ₹5.00");
    expect(text).toContain("2 L • ₹213.00 • 1 paid");
    expect(screen.getByTestId("revenue-basis").textContent).toContain("Completed bookings whose payment was received");
  });

  it("reads ₹0 when there are no paid transactions", () => {
    store.revenue = {
      ...revenue,
      todaysRevenue: 0,
      weeklyRevenue: 0,
      monthlyRevenue: 0,
      allTimeRevenue: 0,
      transactions: { today: 0, week: 0, month: 0, allTime: 0 },
      monthBreakdown: { fuelValue: 0, fees: 0, quantity: 0 },
      fuelSales: {},
      awaitingCollection: { count: 0, amount: 0 },
    };
    render(<RevenueTab />);
    expect(document.body.textContent).toContain("Today's Revenue · 0 paid");
    expect(document.body.textContent).toContain("₹0.00");
    expect(document.body.textContent).toContain("No paid sales this month yet");
  });
});
