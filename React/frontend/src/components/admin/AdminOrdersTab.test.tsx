import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const store = vi.hoisted(() => ({
  orders: null as unknown,
  orderFilters: {},
  loadOrders: vi.fn(async () => {}),
}));
vi.mock("@/store/adminStore", () => ({
  useAdminStore: (select: (s: typeof store) => unknown) => select(store),
}));
vi.mock("@/services/api/adminApi", async (orig) => ({
  ...(await orig<typeof import("@/services/api/adminApi")>()),
  deleteAdminOrder: vi.fn(),
  updateAdminOrderStatus: vi.fn(),
}));

import * as api from "@/services/api/adminApi";
import AdminOrdersTab from "./AdminOrdersTab";

const deleteAdminOrder = vi.mocked(api.deleteAdminOrder);

const order = (orderId: string, status: string, paymentStatus = "paid") => ({
  bookingId: `id-${orderId}`,
  orderId,
  userName: "Saurabh yadav",
  userContact: "customer@example.com",
  vehiclePlate: "MH2574DS",
  bookingDate: "2026-09-14",
  startTime: "14:00",
  endTime: "14:00",
  fuelType: "Petrol",
  quantity: 4,
  amount: 405,
  paymentStatus,
  status,
  stationName: "Baner Fuels",
});

beforeEach(() => {
  vi.clearAllMocks();
  store.orders = {
    summary: {},
    stations: [
      {
        stationId: "s1",
        stationName: "Baner Fuels",
        address: "Baner",
        bookings: [
          order("FM-DONE", "completed"),
          order("FM-EXPIRED", "expired", "due_at_station"),
          order("FM-UPCOMING", "upcoming", "due_at_station"),
          order("FM-SERVING", "serving", "due_at_station"),
        ],
      },
    ],
  };
});
afterEach(() => vi.restoreAllMocks());

describe("Delete order", () => {
  it("offers Delete only for finished orders", () => {
    render(<AdminOrdersTab />);
    expect(screen.getByRole("button", { name: "Delete order FM-DONE" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete order FM-EXPIRED" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete order FM-UPCOMING" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete order FM-SERVING" })).toBeNull();
  });

  it("asks first, deletes, and reloads the list so the row disappears", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    deleteAdminOrder.mockResolvedValue({ ok: true, msg: "Order deleted" });
    render(<AdminOrdersTab />);

    fireEvent.click(screen.getByRole("button", { name: "Delete order FM-DONE" }));
    expect(confirm.mock.calls[0][0]).toContain("FM-DONE");
    expect(confirm.mock.calls[0][0]).toContain("no longer count in revenue"); // it was paid
    await waitFor(() => expect(deleteAdminOrder).toHaveBeenCalledWith("id-FM-DONE"));
    await waitFor(() => expect(store.loadOrders).toHaveBeenCalled());
  });

  it("does nothing when the admin cancels the confirmation", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<AdminOrdersTab />);
    fireEvent.click(screen.getByRole("button", { name: "Delete order FM-EXPIRED" }));
    expect(deleteAdminOrder).not.toHaveBeenCalled();
    expect(store.loadOrders).not.toHaveBeenCalled();
  });

  it("keeps the row when the server refuses", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    deleteAdminOrder.mockRejectedValue({ response: { data: { msg: "This order is serving." } } });
    render(<AdminOrdersTab />);
    fireEvent.click(screen.getByRole("button", { name: "Delete order FM-DONE" }));
    await waitFor(() => expect(deleteAdminOrder).toHaveBeenCalled());
    expect(store.loadOrders).not.toHaveBeenCalled();
    expect(screen.getByText("FM-DONE")).toBeTruthy();
  });
});
