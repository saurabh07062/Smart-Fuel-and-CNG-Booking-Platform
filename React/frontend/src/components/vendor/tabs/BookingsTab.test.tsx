import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const store = vi.hoisted(() => ({
  stations: [{ _id: "st1", name: "Audit Fuels", address: "Baner", fuelTypes: ["Petrol"] }] as Array<Record<string, unknown>>,
  selectedStation: "st1" as string | null,
  stationBookings: [] as Array<Record<string, unknown>>,
  viewStationBookings: vi.fn(async () => {}),
  backToStationList: vi.fn(),
}));
vi.mock("@/store/vendorStore", () => ({
  useVendorStore: (select: (s: typeof store) => unknown) => select(store),
}));
vi.mock("@/components/vendor/WalkInPanel", () => ({ default: () => null }));
vi.mock("@/services/api/vendorApi", () => ({
  updateVendorBookingStatus: vi.fn(async () => ({ msg: "Booking completed" })),
  collectVendorBookingPayment: vi.fn(async () => ({ msg: "Payment of ₹213 recorded.", alreadyPaid: false })),
}));

import * as api from "@/services/api/vendorApi";
import BookingsTab from "./BookingsTab";

const row = (over: Record<string, unknown>) => ({
  _id: "b0000000000000000000001",
  user: { name: "Asha", phone: "9000000000" },
  fuelType: "Petrol",
  quantity: 2,
  price: 104,
  amount: 213,
  bookingDate: "2026-09-14",
  timeSlot: "11:00 AM",
  vehiclePlate: "MH12AB1234",
  payMethod: "station",
  paymentStatus: "due_at_station",
  status: "upcoming",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("Vendor bookings: real payment state and collection", () => {
  it("shows booking ref, slot, vehicle, price and payment for each booking", () => {
    store.stationBookings = [
      row({ _id: "b0000000000000000000001", status: "upcoming" }),
      row({ _id: "b0000000000000000000002", status: "completed", paymentStatus: "paid", collectedAt: "2026-09-14T06:00:00Z" }),
      row({ _id: "b0000000000000000000003", status: "cancelled" }),
    ];
    render(<BookingsTab />);

    const first = within(screen.getByTestId("booking-row-b0000000000000000000001"));
    expect(first.getByText("#00000001")).toBeTruthy();
    expect(first.getByText("2026-09-14 · 11:00 AM")).toBeTruthy();
    expect(first.getByText("MH12AB1234")).toBeTruthy();
    expect(first.getByText("Due at pump")).toBeTruthy();
    expect(within(screen.getByTestId("booking-row-b0000000000000000000002")).getByText("Paid at pump")).toBeTruthy();
    expect(within(screen.getByTestId("booking-row-b0000000000000000000003")).getByText("Not charged")).toBeTruthy();
  });

  it("offers Collect only for a fuelled booking still owed, and records it through the API", async () => {
    const user = userEvent.setup();
    store.stationBookings = [
      row({ _id: "b0000000000000000000001", status: "upcoming" }),
      row({ _id: "b0000000000000000000002", status: "completed" }),
      row({ _id: "b0000000000000000000003", status: "completed", paymentStatus: "paid", collectedAt: "2026-09-14T06:00:00Z" }),
    ];
    render(<BookingsTab />);

    expect(screen.queryByRole("button", { name: "Collect payment for #00000001" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Collect payment for #00000003" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Collect payment for #00000002" }));
    expect(api.collectVendorBookingPayment).toHaveBeenCalledWith("st1", "b0000000000000000000002");
    await waitFor(() => expect(store.viewStationBookings).toHaveBeenCalledWith("st1"));
  });

  it("Mark complete only completes; it does not record payment", async () => {
    const user = userEvent.setup();
    store.stationBookings = [row({ _id: "b0000000000000000000004", status: "serving" })];
    render(<BookingsTab />);

    await user.click(screen.getByRole("button", { name: "Mark complete" }));
    expect(api.updateVendorBookingStatus).toHaveBeenCalledWith("st1", "b0000000000000000000004", "completed");
    expect(api.collectVendorBookingPayment).not.toHaveBeenCalled();
    // A serving pump booking can also have its payment collected.
    expect(screen.getByRole("button", { name: "Collect payment for #00000004" })).toBeTruthy();
  });
});
