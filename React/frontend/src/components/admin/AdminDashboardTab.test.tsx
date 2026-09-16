import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useAdminStore } from "@/store/adminStore";
import type { SuperAdminDashboard } from "@/services/api/adminApi";
import AdminDashboardTab from "./AdminDashboardTab";

const zero = { revenue: 0, fuelValue: 0, fees: 0, quantity: 0, transactions: 0 };
const base: SuperAdminDashboard = {
  stations: { total: 1, active: 1 },
  vendors: { total: 1, pending: 0 },
  customers: { total: 2 },
  bookings: {},
  today: { date: "2026-09-14", bookings: 0, byHour: [] },
  fuelStock: { petrol: 0, diesel: 0, cng: 0 },
  fuelCapacity: { petrol: null, diesel: null, cng: null },
  liveQueue: { stations: 1, vehicles: 0, avgWaitMinutes: null },
  revenue: {
    total: 0,
    today: zero,
    week: zero,
    month: zero,
    allTime: zero,
    awaitingCollection: { count: 0, amount: 0 },
    basis: "Completed bookings whose payment was received",
    monthly: [],
    forecastNextMonth: { ready: false, forMonth: null, value: null, method: "none", errorPercent: null, reliability: "unmeasured", completeMonths: 0, daysObserved: 0 },
  },
};

beforeEach(() => {
  useAdminStore.setState({ dashboard: null, dashboardError: null });
});

describe("Admin dashboard shows only real figures", () => {
  it("with no transactions it reads ₹0, not the old placeholder numbers", () => {
    useAdminStore.setState({ dashboard: base });
    render(<AdminDashboardTab tab="dashboard" />);

    expect(screen.getByTestId("tile-revenue-today").textContent).toContain("₹0.00");
    expect(screen.getByTestId("tile-revenue-today").textContent).toContain("0 paid transactions");
    expect(screen.getByTestId("tile-awaiting").textContent).toContain("₹0.00");
    expect(screen.getByTestId("tile-wait").textContent).toContain("—");
    expect(screen.getByTestId("by-hour-empty")).toBeTruthy();

    const text = document.body.textContent || "";
    for (const fake of ["₹1.4L", "+12% vs last week", "4 mins", "4,500L", "2,100L", "6,500L", "8,900L", "4 PM (Peak)", "Auto-Refill"]) {
      expect(text).not.toContain(fake);
    }
  });

  it("renders the server's revenue, collection, queue, hourly and stock figures", () => {
    useAdminStore.setState({
      dashboard: {
        ...base,
        bookings: { completed: 3, cancelled: 1 },
        today: { date: "2026-09-14", bookings: 4, byHour: [{ hour: 11, bookings: 3, completed: 2, cancelled: 1 }] },
        fuelStock: { petrol: 4998, diesel: 0, cng: 795 },
        fuelCapacity: { petrol: 10000, diesel: null, cng: 1000 },
        liveQueue: { stations: 1, vehicles: 2, avgWaitMinutes: 3.5 },
        revenue: {
          ...base.revenue,
          today: { revenue: 530.5, fuelValue: 520.5, fees: 10, quantity: 5, transactions: 2 },
          month: { revenue: 530.5, fuelValue: 520.5, fees: 10, quantity: 5, transactions: 2 },
          awaitingCollection: { count: 1, amount: 213 },
        },
      },
    });
    render(<AdminDashboardTab tab="dashboard" />);

    expect(screen.getByTestId("tile-revenue-today").textContent).toContain("₹530.50");
    expect(screen.getByTestId("tile-revenue-today").textContent).toContain("2 paid transactions");
    expect(screen.getByTestId("tile-bookings-today").textContent).toContain("4");
    expect(screen.getByTestId("tile-awaiting").textContent).toContain("₹213.00");
    expect(screen.getByTestId("tile-wait").textContent).toContain("3.5 min");
    expect(screen.getByTestId("by-hour").textContent).toContain("11 AM");
    expect(screen.getByTestId("inventory-panel").textContent).toContain("4,998 L / 10,000 L");
    expect(screen.getByTestId("inventory-panel").textContent).toContain("capacity not recorded");
  });

  it("shows a loading state, then an error with a retry when the server fails", () => {
    const { rerender } = render(<AdminDashboardTab tab="dashboard" />);
    expect(document.body.textContent).toContain("Loading dashboard");

    useAdminStore.setState({ dashboardError: "Could not load the dashboard from the server." });
    rerender(<AdminDashboardTab tab="dashboard" />);
    expect(screen.getByRole("alert").textContent).toContain("Could not load the dashboard");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
