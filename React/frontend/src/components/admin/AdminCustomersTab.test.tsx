import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/services/api/adminApi", () => ({
  fetchAdminCustomers: vi.fn(),
  fetchAdminActivity: vi.fn(),
}));

import * as api from "@/services/api/adminApi";
import AdminCustomersTab from "./AdminCustomersTab";
import AdminActivityPanel from "./AdminActivityPanel";

const customer = (over: Record<string, unknown>) =>
  ({
    _id: "c1",
    name: "Asha Kale",
    email: "asha@example.com",
    phone: "9000000000",
    isVerified: true,
    vehicles: 2,
    joinedAt: "2026-09-01T06:00:00Z",
    bookings: 5,
    completed: 4,
    cancelled: 1,
    lastBookingAt: "2026-09-20T06:00:00Z",
    spent: 2500,
    ...over,
  }) as never;

beforeEach(() => vi.clearAllMocks());

describe("Admin customers (user management)", () => {
  it("lists each customer's own activity, with the amount masked", async () => {
    vi.mocked(api.fetchAdminCustomers).mockResolvedValue({
      total: 42,
      returned: 2,
      customers: [customer({}), customer({ _id: "c2", name: "Ravi Shah", isVerified: false, bookings: 0, completed: 0, cancelled: 0, spent: 0, lastBookingAt: null, vehicles: 0 })],
    });
    render(<AdminCustomersTab />);

    await waitFor(() => expect(screen.getAllByTestId(/^customer-row-/)).toHaveLength(2));
    const first = within(screen.getByTestId("customer-row-c1"));
    expect(first.getByText("Asha Kale")).toBeTruthy();
    expect(first.getByText("asha@example.com")).toBeTruthy();
    expect(first.getByText("Verified · 2 vehicles")).toBeTruthy();
    expect(first.getByText("5")).toBeTruthy();
    expect(screen.queryByText("₹2,500.00")).toBeNull(); // masked until the eye is tapped
    fireEvent.click(first.getByRole("button", { name: "Show amount paid by Asha Kale" }));
    expect(screen.getByText("₹2,500.00")).toBeTruthy();

    // A customer who never booked still appears, with zeros and a dash.
    const second = within(screen.getByTestId("customer-row-c2"));
    expect(second.getByText("Not verified")).toBeTruthy();
    expect(second.getByText("—")).toBeTruthy();
    expect(screen.getByText("42 registered")).toBeTruthy();
  });

  it("searches on the server, and says when nothing matches", async () => {
    vi.mocked(api.fetchAdminCustomers).mockResolvedValue({ total: 42, returned: 0, customers: [] });
    render(<AdminCustomersTab />);
    await waitFor(() => expect(api.fetchAdminCustomers).toHaveBeenCalledWith(""));

    fireEvent.change(screen.getByLabelText("Search customers"), { target: { value: "ravi" } });
    fireEvent.submit(screen.getByLabelText("Search customers"));
    await waitFor(() => expect(api.fetchAdminCustomers).toHaveBeenLastCalledWith("ravi"));
    expect(await screen.findByText(/No customer matches/)).toBeTruthy();
  });

  it("shows the server's error instead of an empty table", async () => {
    vi.mocked(api.fetchAdminCustomers).mockRejectedValue({ response: { data: { msg: "Failed to load customers" } } });
    render(<AdminCustomersTab />);
    expect((await screen.findByRole("alert")).textContent).toContain("Failed to load customers");
  });
});

describe("Admin recent activity", () => {
  it("shows bookings, payments, vendors and station changes newest first", async () => {
    const now = Date.now();
    vi.mocked(api.fetchAdminActivity).mockResolvedValue([
      { kind: "payment", at: new Date(now - 60_000).toISOString(), title: "Payment collected for FM-1", detail: "Baner Fuels · Cash", status: "paid", amount: 505 },
      { kind: "booking", at: new Date(now - 3_600_000).toISOString(), title: "Petrol booking FM-2", detail: "Asha · Baner Fuels", status: "upcoming", amount: 213 },
      { kind: "vendor", at: new Date(now - 7_200_000).toISOString(), title: "Vendor registered: Shah Petroleum", detail: "Ravi Shah", status: "pending", amount: null },
      { kind: "station", at: new Date(now - 86_400_000).toISOString(), title: "Station updated: Kharadi Fuels", detail: "Shah Petroleum", status: "Active", amount: null },
    ]);
    render(<AdminActivityPanel />);

    const list = await screen.findByTestId("activity-list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0].textContent).toContain("Payment collected for FM-1");
    expect(items[0].textContent).toContain("1 min ago");
    expect(items[1].textContent).toContain("1 h ago");
    expect(items[2].textContent).toContain("Vendor registered: Shah Petroleum");
    // Amounts are masked here too.
    expect(screen.queryByText("₹505.00")).toBeNull();
  });

  it("says so when nothing has happened yet", async () => {
    vi.mocked(api.fetchAdminActivity).mockResolvedValue([]);
    render(<AdminActivityPanel />);
    expect(await screen.findByText("Nothing has happened on the platform yet.")).toBeTruthy();
  });
});
