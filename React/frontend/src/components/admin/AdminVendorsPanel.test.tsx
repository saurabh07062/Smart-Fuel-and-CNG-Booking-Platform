import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/services/api/adminApi", () => ({ fetchManagedVendors: vi.fn() }));

import * as api from "@/services/api/adminApi";
import AdminVendorsPanel from "./AdminVendorsPanel";
import { DonutChart, LineChart, BarChart } from "./charts/Charts";

const vendor = (over: Record<string, unknown>) =>
  ({
    _id: "v1",
    name: "Asha Kale",
    email: "asha@example.com",
    phone: "9000000000",
    businessName: "Kale Fuels",
    vendorStatus: "active",
    stationCount: 2,
    totalRevenue: 12500,
    createdAt: "2026-09-01T06:00:00Z",
    ...over,
  }) as never;

const show = () =>
  render(
    <MemoryRouter>
      <AdminVendorsPanel />
    </MemoryRouter>,
  );

beforeEach(() => vi.clearAllMocks());

describe("Admin vendors panel", () => {
  it("lists every vendor the server returns, with their details", async () => {
    vi.mocked(api.fetchManagedVendors).mockResolvedValue([
      vendor({}),
      vendor({ _id: "v2", name: "Ravi Shah", businessName: "Shah Petroleum", vendorStatus: "pending", stationCount: 0, totalRevenue: 0, phone: "9111111111" }),
      vendor({ _id: "v3", name: "Meera Rao", businessName: "Rao CNG", vendorStatus: "suspended", stationCount: 1, totalRevenue: 400 }),
    ]);
    show();

    await waitFor(() => expect(screen.getAllByTestId(/^vendor-row-/)).toHaveLength(3));
    const first = within(screen.getByTestId("vendor-row-v1"));
    expect(first.getByText("Kale Fuels")).toBeTruthy();
    expect(first.getByText("Asha Kale")).toBeTruthy();
    expect(first.getByText("asha@example.com")).toBeTruthy();
    expect(first.getByText("9000000000")).toBeTruthy();
    expect(first.getByText("Active")).toBeTruthy();
    expect(first.getByText("2")).toBeTruthy();

    // Pending and suspended vendors are listed too, with their own state.
    expect(within(screen.getByTestId("vendor-row-v2")).getByText("Pending")).toBeTruthy();
    expect(within(screen.getByTestId("vendor-row-v3")).getByText("Suspended")).toBeTruthy();
  });

  it("orders them by revenue, and hides the amounts until asked", async () => {
    vi.mocked(api.fetchManagedVendors).mockResolvedValue([
      vendor({ _id: "small", businessName: "Small", totalRevenue: 100 }),
      vendor({ _id: "big", businessName: "Big", totalRevenue: 90000 }),
    ]);
    show();
    await waitFor(() => expect(screen.getAllByTestId(/^vendor-row-/)).toHaveLength(2));
    expect(screen.getAllByTestId(/^vendor-row-/)[0].getAttribute("data-testid")).toBe("vendor-row-big");
    // Revenue is masked (the money toggle), never shown by default.
    expect(screen.queryByText("₹90,000.00")).toBeNull();
    expect(screen.getAllByTestId("money-hidden").length).toBeGreaterThan(0);
  });

  it("says so when there are no vendors, or when the server fails", async () => {
    vi.mocked(api.fetchManagedVendors).mockResolvedValue([]);
    const { unmount } = show();
    expect(await screen.findByText("No vendors have registered yet.")).toBeTruthy();
    unmount();

    vi.mocked(api.fetchManagedVendors).mockRejectedValue({ response: { data: { msg: "Vendors could not be loaded." } } });
    show();
    expect((await screen.findByRole("alert")).textContent).toContain("Vendors could not be loaded.");
  });
});

describe("Console charts", () => {
  it("a donut splits the ring by share and totals it in the middle", () => {
    const { container } = render(
      <DonutChart
        centreLabel="bookings"
        ariaLabel="Bookings by status"
        slices={[
          { label: "Completed", value: 3, colour: "#22c55e" },
          { label: "Cancelled", value: 1, colour: "#f97316" },
        ]}
      />,
    );
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Completed 3, Cancelled 1/ })).toBeTruthy();
    const arcs = container.querySelectorAll("circle");
    // Track plus one arc per slice.
    expect(arcs).toHaveLength(3);
  });

  it("a line chart marks the best point and reads out its series", () => {
    render(
      <LineChart
        points={[
          { label: "Jul", value: 100 },
          { label: "Aug", value: 400 },
          { label: "Sep", value: 250 },
        ]}
        ariaLabel="Monthly revenue"
        format={(v) => `₹${v}`}
      />,
    );
    expect(screen.getByRole("img", { name: "Monthly revenue: Jul ₹100, Aug ₹400, Sep ₹250" })).toBeTruthy();
    expect(screen.getByText("Aug").className).toContain("font-bold");
  });

  it("charts with nothing to show say so instead of drawing an empty frame", () => {
    const { container, rerender } = render(<LineChart points={[]} ariaLabel="Monthly revenue" />);
    expect(container.textContent).toContain("No data yet.");
    rerender(<BarChart points={[]} ariaLabel="Bookings by hour" />);
    expect(container.textContent).toContain("No data yet.");
  });
});
