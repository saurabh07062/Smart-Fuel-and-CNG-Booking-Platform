import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, renderHook, screen } from "@testing-library/react";

// Socket hooks: capture the handlers so the test can fire events.
const handlers = vi.hoisted(() => new Map<string, (p?: unknown) => void>());
const watched = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("@/hooks/useSocket", () => ({
  useSocketEvent: (event: string, handler: (p?: unknown) => void) => handlers.set(event, handler),
  useWatchStations: (ids: string[]) => {
    watched.ids = ids;
  },
}));

import QueueInfoCard from "./QueueInfoCard";
import { useLiveQueueInfo } from "@/hooks/useLiveQueueInfo";
import { useBookingStore } from "@/store/bookingStore";
import { SOCKET_EVENTS } from "@/services/socket/socketEvents";

const info = {
  vehicleCountAhead: 4,
  queuePosition: 5,
  expectedWaitingSeconds: 380,
  expectedWaitingTime: "6 min 20 sec",
  estimatedStartTime: "10:06 AM",
};

describe("QueueInfoCard", () => {
  it("shows the server's four figures, unchanged", () => {
    render(<QueueInfoCard info={info} />);
    expect(screen.getByText("4 vehicles ahead")).toBeTruthy();
    expect(screen.getByText("#5")).toBeTruthy();
    expect(screen.getByText("6 min 20 sec")).toBeTruthy();
    expect(screen.getByText("10:06 AM")).toBeTruthy();
  });

  it("first in line reads naturally; nothing is shown without figures", () => {
    const { rerender, container } = render(
      <QueueInfoCard info={{ ...info, vehicleCountAhead: 0, queuePosition: 1, expectedWaitingSeconds: 0, expectedWaitingTime: "No wait" }} />,
    );
    expect(screen.getByText("No vehicles ahead")).toBeTruthy();
    expect(screen.getByText("No wait")).toBeTruthy();
    rerender(<QueueInfoCard info={null} />);
    expect(container.textContent).toBe("");
  });

  it("the compact line (booking rows, vendor list) carries the same figures", () => {
    render(<QueueInfoCard info={info} compact />);
    const line = screen.getByTestId("queue-info").textContent ?? "";
    expect(line).toContain("#5");
    expect(line).toContain("4 vehicles ahead");
    expect(line).toContain("wait 6 min 20 sec");
    expect(line).toContain("~10:06 AM");
  });
});

describe("useLiveQueueInfo", () => {
  const load = vi.fn(async () => {});
  beforeEach(() => {
    handlers.clear();
    load.mockClear();
    useBookingStore.setState({
      bookings: [
        { _id: "b1", status: "upcoming", station: "st1" },
        { _id: "b2", status: "completed", station: "st9" },
      ] as never,
      load,
    } as never);
  });

  it("watches only the stations of active bookings", () => {
    renderHook(() => useLiveQueueInfo());
    expect(watched.ids).toEqual(["st1"]);
  });

  it("refetches when the line at that station moves, not for another station", async () => {
    renderHook(() => useLiveQueueInfo());
    handlers.get(SOCKET_EVENTS.SLOT_UPDATED)?.({ stationId: "st2" });
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
    handlers.get(SOCKET_EVENTS.SLOT_UPDATED)?.({ stationId: "st1" });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    handlers.get(SOCKET_EVENTS.ETA_UPDATE)?.({ bookingId: "b1" });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("fetches nothing without an active booking", async () => {
    useBookingStore.setState({ bookings: [{ _id: "b2", status: "completed", station: "st9" }] as never } as never);
    renderHook(() => useLiveQueueInfo());
    handlers.get(SOCKET_EVENTS.SLOT_UPDATED)?.({ stationId: "st9" });
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
  });
});
