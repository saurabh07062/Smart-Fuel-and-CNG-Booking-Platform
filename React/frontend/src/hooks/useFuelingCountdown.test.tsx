import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useFuelingCountdown } from "./useFuelingCountdown";
import { _resetServerClock, recordServerDate, serverNow } from "@/utils/serverClock";
import ServiceCountdown from "@/components/booking/ServiceCountdown";

vi.mock("@/store/bookingStore", () => ({
  useBookingStore: (select: (s: { load: () => Promise<void> }) => unknown) => select({ load: vi.fn(async () => {}) }),
}));

function Probe({ start, seconds, fuel = "Petrol" }: { start: number | null; seconds: number; fuel?: string }) {
  const c = useFuelingCountdown({
    fuelingStartTime: start === null ? null : new Date(start).toISOString(),
    serviceDurationSeconds: seconds,
    fuelType: fuel,
  });
  return <p data-testid="c">{`${c.label}|${c.finished}|${Math.round(c.progress * 100)}`}</p>;
}

afterEach(() => {
  vi.useRealTimers();
  _resetServerClock();
});

describe("fueling countdown", () => {
  it("counts from the server's start time and reaches zero at start + duration", () => {
    vi.useFakeTimers();
    const start = Date.now() - 10_000;
    render(<Probe start={start} seconds={40} />);
    expect(screen.getByTestId("c").textContent).toBe("00:30|false|25");
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByTestId("c").textContent).toBe("00:00|true|100");
  });

  it("a refresh (fresh mount) shows the same remaining time -- it never restarts", () => {
    vi.useFakeTimers();
    const start = Date.now() - 100_000;
    const first = render(<Probe start={start} seconds={300} fuel="CNG" />);
    expect(screen.getByTestId("c").textContent).toBe("03:20|false|33");
    first.unmount();
    act(() => vi.advanceTimersByTime(5_000));
    render(<Probe start={start} seconds={300} fuel="CNG" />);
    expect(screen.getByTestId("c").textContent).toBe("03:15|false|35");
  });

  it("uses the server's clock, not a wrong device clock", () => {
    // The device is 60 s behind the server.
    recordServerDate(new Date(Date.now() + 60_000).toUTCString());
    expect(serverNow() - Date.now()).toBeGreaterThan(58_000);
    const start = serverNow() - 10_000; // started 10 s ago on the SERVER
    render(<Probe start={start} seconds={40} />);
    expect(screen.getByTestId("c").textContent).toMatch(/^00:(29|30)\|false/);
  });

  it("ignores sub-second header noise", () => {
    recordServerDate(new Date(Date.now() + 900).toUTCString());
    expect(Math.abs(serverNow() - Date.now())).toBeLessThan(50);
  });

  it("the customer screen says completion is automatic, then that it is completing", () => {
    vi.useFakeTimers();
    render(
      <ServiceCountdown
        booking={{ _id: "b1", status: "serving", fuelType: "Diesel", fuelingStartTime: new Date(Date.now() - 1_000).toISOString(), serviceDurationSeconds: 2 } as never}
      />,
    );
    expect(screen.getByText(/completes automatically/)).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1_500));
    expect(screen.getByText("Completing your booking now…")).toBeTruthy();
  });
});
