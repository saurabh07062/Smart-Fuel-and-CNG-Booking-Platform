import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const loadStations = vi.fn(async () => {});
vi.mock("@/store/vendorStore", () => ({
  useVendorStore: (select: (s: { loadStations: typeof loadStations }) => unknown) => select({ loadStations }),
}));
vi.mock("@/services/api/vendorApi", () => ({
  updateStationSchedule: vi.fn(async () => ({ msg: "Slot timings saved", openingHours: "Varies by day", outsideHours: 0 })),
}));

import * as api from "@/services/api/vendorApi";
import SlotTimings, { daySummary } from "./SlotTimings";

beforeEach(() => vi.clearAllMocks());

describe("Vendor slot timings", () => {
  it("summarises a day the way customers will see it", () => {
    expect(daySummary({ open: "06:00", close: "22:00", is24h: true, isClosed: false })).toBe("Open 24 hours · slots all day");
    expect(daySummary({ open: "08:00", close: "20:30", is24h: false, isClosed: false })).toBe("Slots 8:00 AM – 8:30 PM");
    expect(daySummary({ open: "06:00", close: "22:00", is24h: false, isClosed: true })).toBe("Closed · no slots");
  });

  it("starts from the saved schedule; a station without one is open 24 hours", () => {
    render(<SlotTimings station={{ _id: "st1", operatingSchedule: { sunday: { open: "09:00", close: "13:00", is24h: false, isClosed: false } } } as never} />);
    expect((screen.getByLabelText("monday hours") as HTMLSelectElement).value).toBe("24h");
    expect((screen.getByLabelText("sunday hours") as HTMLSelectElement).value).toBe("hours");
    expect((screen.getByLabelText("sunday opening time") as HTMLInputElement).value).toBe("09:00");
    expect(screen.queryByText("Save timings")).toBeNull();
  });

  it("saves all seven days after a change", async () => {
    render(<SlotTimings station={{ _id: "st1" } as never} />);
    fireEvent.change(screen.getByLabelText("tuesday hours"), { target: { value: "closed" } });
    fireEvent.change(screen.getByLabelText("monday hours"), { target: { value: "hours" } });
    fireEvent.change(screen.getByLabelText("monday opening time"), { target: { value: "07:00" } });
    fireEvent.click(screen.getByText("Save timings"));
    await waitFor(() => expect(api.updateStationSchedule).toHaveBeenCalledTimes(1));
    const [id, sent] = vi.mocked(api.updateStationSchedule).mock.calls[0];
    expect(id).toBe("st1");
    expect(Object.keys(sent)).toHaveLength(7);
    expect(sent.monday).toEqual({ open: "07:00", close: "22:00", is24h: false, isClosed: false });
    expect(sent.tuesday.isClosed).toBe(true);
    expect(sent.wednesday.is24h).toBe(true);
    await waitFor(() => expect(loadStations).toHaveBeenCalled());
  });

  it("'Apply to all' copies one day's hours to every day", async () => {
    render(<SlotTimings station={{ _id: "st1" } as never} />);
    fireEvent.change(screen.getByLabelText("friday hours"), { target: { value: "closed" } });
    fireEvent.click(within(screen.getByTestId("slot-day-friday")).getByText("Apply to all"));
    for (const day of ["monday", "sunday"]) {
      expect((screen.getByLabelText(`${day} hours`) as HTMLSelectElement).value).toBe("closed");
    }
  });

  it("refuses a closing time before the opening time without calling the server", async () => {
    render(<SlotTimings station={{ _id: "st1" } as never} />);
    fireEvent.change(screen.getByLabelText("monday hours"), { target: { value: "hours" } });
    fireEvent.change(screen.getByLabelText("monday opening time"), { target: { value: "23:00" } });
    fireEvent.click(screen.getByText("Save timings"));
    await new Promise((r) => setTimeout(r, 0));
    expect(api.updateStationSchedule).not.toHaveBeenCalled();
  });
});
