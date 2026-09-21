import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const store = vi.hoisted(() => ({
  stations: [{ _id: "st1", name: "Audit Fuels", address: "Baner", fuelTypes: ["Petrol"] }] as Array<Record<string, unknown>>,
  selectedStation: "st1" as string | null,
  stationBookings: [] as Array<Record<string, unknown>>,
  viewStationBookings: vi.fn(async () => {}),
  refreshLive: vi.fn(async () => {}),
  backToStationList: vi.fn(),
}));
vi.mock("@/store/vendorStore", () => ({
  useVendorStore: (select: (s: typeof store) => unknown) => select(store),
}));
vi.mock("@/components/vendor/WalkInPanel", () => ({ default: () => null }));
vi.mock("@/services/api/vendorApi", () => ({
  updateVendorBookingStatus: vi.fn(async () => ({ msg: "Booking completed" })),
  collectVendorBookingPayment: vi.fn(async () => ({ msg: "Payment of ₹213 recorded.", alreadyPaid: false })),
  checkInWithCode: vi.fn(),
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
    // Asks how it was paid; nothing is recorded until a method is chosen.
    const record = screen.getByRole("button", { name: "Record payment" });
    expect((record as HTMLButtonElement).disabled).toBe(true);
    expect(api.collectVendorBookingPayment).not.toHaveBeenCalled();
    await user.click(screen.getByRole("radio", { name: /Cash/ }));
    await user.click(record);
    expect(api.collectVendorBookingPayment).toHaveBeenCalledWith("st1", "b0000000000000000000002", "cash");
    await waitFor(() => expect(store.refreshLive).toHaveBeenCalled());
  });

  it("after a PIN starts fueling on a pay-at-pump booking, asks Cash or Online (UPI)", async () => {
    const user = userEvent.setup();
    store.stationBookings = [];
    vi.mocked(api.checkInWithCode).mockResolvedValue({
      msg: "Checked in. Fueling has started.",
      started: true,
      booking: { _id: "b0000000000000000000009", station: "st1", amount: 505, payMethod: "station", paymentStatus: "due_at_station" },
    });
    render(<BookingsTab />);
    await user.type(screen.getByLabelText("Customer verification code"), "4321");
    await user.click(screen.getByRole("button", { name: /Start Fueling/ }));

    expect(await screen.findByText("How was the payment collected?")).toBeTruthy();
    // The list refreshes silently: a loading refresh would unmount this tab
    // (VendorPanel shows a spinner) and close the popup straight away.
    await waitFor(() => expect(store.refreshLive).toHaveBeenCalled());
    expect(store.viewStationBookings).not.toHaveBeenCalled();
    expect(screen.getByText("How was the payment collected?")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /UPI/ }));
    await user.click(screen.getByRole("button", { name: "Record payment" }));
    expect(api.collectVendorBookingPayment).toHaveBeenCalledWith("st1", "b0000000000000000000009", "upi");
  });

  it("'Later' leaves the payment owed", async () => {
    const user = userEvent.setup();
    store.stationBookings = [];
    vi.mocked(api.checkInWithCode).mockResolvedValue({
      msg: "Checked in. Fueling has started.",
      started: true,
      booking: { _id: "b0000000000000000000009", station: "st1", amount: 505, payMethod: "station", paymentStatus: "due_at_station" },
    });
    render(<BookingsTab />);
    await user.type(screen.getByLabelText("Customer verification code"), "4321");
    await user.click(screen.getByRole("button", { name: /Start Fueling/ }));
    await user.click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.queryByText("How was the payment collected?")).toBeNull();
    expect(api.collectVendorBookingPayment).not.toHaveBeenCalled();
  });

  it("also asks when the car is checked in but waiting for the nozzle", async () => {
    const user = userEvent.setup();
    store.stationBookings = [];
    vi.mocked(api.checkInWithCode).mockResolvedValue({
      msg: "Checked in. The nozzle is busy.",
      queued: true,
      booking: { _id: "b0000000000000000000009", station: "st1", amount: 505, payMethod: "station", paymentStatus: "due_at_station" },
    });
    render(<BookingsTab />);
    await user.type(screen.getByLabelText("Customer verification code"), "4321");
    await user.click(screen.getByRole("button", { name: /Start Fueling/ }));
    expect(await screen.findByText("How was the payment collected?")).toBeTruthy();
    expect(screen.getByText(/waiting for the nozzle/)).toBeTruthy();
  });

  it("does not ask when the booking is already paid", async () => {
    const user = userEvent.setup();
    store.stationBookings = [];
    vi.mocked(api.checkInWithCode).mockResolvedValue({
      msg: "Checked in. Fueling has started.",
      started: true,
      booking: { _id: "b0000000000000000000009", station: "st1", amount: 505, payMethod: "station", paymentStatus: "paid" },
    });
    render(<BookingsTab />);
    await user.type(screen.getByLabelText("Customer verification code"), "4321");
    await user.click(screen.getByRole("button", { name: /Start Fueling/ }));
    await waitFor(() => expect(api.checkInWithCode).toHaveBeenCalled());
    expect(screen.queryByText("How was the payment collected?")).toBeNull();
  });

  it("a fill in progress shows a live timer from the server's start time, and no manual complete button", () => {
    store.stationBookings = [
      row({
        _id: "b0000000000000000000004",
        status: "serving",
        fuelingStartTime: new Date(Date.now() - 10_000).toISOString(),
        serviceDurationSeconds: 40,
      }),
    ];
    render(<BookingsTab />);

    const timer = within(screen.getByTestId("booking-row-b0000000000000000000004")).getByTestId("fueling-timer");
    expect(timer.textContent).toMatch(/00:(29|30) left/);
    expect(screen.queryByRole("button", { name: "Mark complete" })).toBeNull();
    // A serving pump booking can still have its payment collected.
    expect(screen.getByRole("button", { name: "Collect payment for #00000004" })).toBeTruthy();
  });

  it("offers the invoice only on completed bookings", () => {
    store.stationBookings = [
      row({ _id: "b0000000000000000000001", status: "upcoming" }),
      row({ _id: "b0000000000000000000002", status: "completed", paymentStatus: "paid", collectedAt: "2026-09-14T06:00:00Z" }),
    ];
    render(<BookingsTab />);
    const link = within(screen.getByTestId("booking-row-b0000000000000000000002")).getByRole("link", { name: /invoice/i });
    expect(link.getAttribute("href")).toBe("/api/invoices/b0000000000000000000002");
    expect(within(screen.getByTestId("booking-row-b0000000000000000000001")).queryByRole("link", { name: /invoice/i })).toBeNull();
  });

  it("checks a customer in with their 4-digit code", async () => {
    const user = userEvent.setup();
    store.stationBookings = [];
    vi.mocked(api.checkInWithCode).mockResolvedValue({ msg: "Checked in. Fueling has started.", started: true });
    render(<BookingsTab />);

    const input = screen.getByLabelText("Customer verification code");
    await user.type(input, "12a34");
    expect((input as HTMLInputElement).value).toBe("1234");
    await user.click(screen.getByRole("button", { name: /Start Fueling/ }));
    expect(api.checkInWithCode).toHaveBeenCalledWith("1234");
    await waitFor(() => expect(store.refreshLive).toHaveBeenCalled());
  });

  it("does not send an incomplete code", async () => {
    const user = userEvent.setup();
    render(<BookingsTab />);
    await user.type(screen.getByLabelText("Customer verification code"), "12");
    await user.click(screen.getByRole("button", { name: /Start Fueling/ }));
    expect(api.checkInWithCode).not.toHaveBeenCalled();
  });
});
