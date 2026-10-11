import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/utils/geo", () => ({ getFreshUserCoords: vi.fn() }));
vi.mock("@/services/api/bookingApi", () => ({ stationCheckIn: vi.fn() }));

import StationCheckInCard from "./StationCheckInCard";
import { getFreshUserCoords } from "@/utils/geo";
import { stationCheckIn } from "@/services/api/bookingApi";
import { useBookingStore } from "@/store/bookingStore";

const booking = (over: Record<string, unknown> = {}) =>
  ({ _id: "b1", status: "upcoming", bookingDate: "2026-09-22", timeSlot: "10:00 AM", ...over }) as never;

const load = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  useBookingStore.setState({ load } as never);
});

describe("Check In at Petrol Pump", () => {
  it("sends the phone's position and refreshes the booking", async () => {
    vi.mocked(getFreshUserCoords).mockResolvedValue({ lat: 18.5814, lng: 73.9756, accuracy: 8 } as never);
    vi.mocked(stationCheckIn).mockResolvedValue({ msg: "Checked in." });
    render(<StationCheckInCard booking={booking()} />);
    await userEvent.click(screen.getByRole("button", { name: /Check In at Petrol Pump/ }));
    expect(stationCheckIn).toHaveBeenCalledWith("b1", 18.5814, 73.9756);
    await waitFor(() => expect(load).toHaveBeenCalled());
  });

  it("shows the server's reason when the customer is not at the pump", async () => {
    vi.mocked(getFreshUserCoords).mockResolvedValue({ lat: 18.6, lng: 73.97 } as never);
    vi.mocked(stationCheckIn).mockRejectedValue({
      response: { data: { reason: "TOO_FAR", msg: "You are about 2.1 km from BALSKAR. Check in when you reach the pump." } },
    });
    render(<StationCheckInCard booking={booking()} />);
    await userEvent.click(screen.getByRole("button", { name: /Check In at Petrol Pump/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("2.1 km");
    expect(load).not.toHaveBeenCalled();
  });

  it("without a GPS fix the server decides, and its answer is shown", async () => {
    vi.mocked(getFreshUserCoords).mockResolvedValue(null);
    vi.mocked(stationCheckIn).mockRejectedValue({
      response: { data: { reason: "LOCATION_REQUIRED", msg: "Turn on location so the app can confirm you are at the station." } },
    });
    render(<StationCheckInCard booking={booking()} />);
    await userEvent.click(screen.getByRole("button", { name: /Check In at Petrol Pump/ }));
    expect(stationCheckIn).toHaveBeenCalledWith("b1", null, null);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Turn on location/);
  });

  it("once checked in, shows the arrival instead of the button", () => {
    render(<StationCheckInCard booking={booking({ stationCheckInAt: "2026-09-22T04:35:00Z" })} />);
    expect(screen.getByTestId("station-checked-in").textContent).toMatch(/Checked in at the pump/);
    expect(screen.queryByRole("button", { name: /Check In at Petrol Pump/ })).toBeNull();
  });

  it("not shown once the attendant has the car, or for a finished booking", () => {
    const { container, rerender } = render(<StationCheckInCard booking={booking({ arrivalTime: "2026-09-22T04:40:00Z" })} />);
    expect(container.textContent).toBe("");
    rerender(<StationCheckInCard booking={booking({ status: "completed" })} />);
    expect(container.textContent).toBe("");
  });
});
