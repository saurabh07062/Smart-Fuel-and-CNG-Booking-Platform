import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import CancelBookingSheet from "./CancelBookingSheet";
import BookingTimeline, { timelineStep } from "./BookingTimeline";
import ToastHost from "@/components/common/ToastHost";
import { TOAST_MS, pushToast, useToastStore } from "@/store/toastStore";
import { avatarUrl, initialsOf } from "@/utils/avatar";
import { addRecentSearch, clearRecentSearches, getRecentSearches } from "@/utils/recentSearches";

describe("Cancel booking sheet", () => {
  it("cancels with the chosen reason, or with none", () => {
    const onConfirm = vi.fn();
    const { rerender } = render(<CancelBookingSheet open onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("radio", { name: "Queue is too long" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
    expect(onConfirm).toHaveBeenLastCalledWith("long_wait");

    // Tapping the chosen reason again clears it.
    fireEvent.click(screen.getByRole("radio", { name: "Queue is too long" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
    expect(onConfirm).toHaveBeenLastCalledWith(undefined);

    rerender(<CancelBookingSheet open waitlisted onClose={() => {}} onConfirm={onConfirm} />);
    expect(screen.getByRole("button", { name: "Leave waitlist" })).toBeTruthy();
  });

  it("'Keep it' closes without cancelling", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(<CancelBookingSheet open onClose={onClose} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("Booking timeline", () => {
  it("follows the booking's status", () => {
    expect(timelineStep({ status: "upcoming", arrivalTime: null }, false)).toBe(0);
    expect(timelineStep({ status: "upcoming", arrivalTime: null }, true)).toBe(1);
    expect(timelineStep({ status: "upcoming", arrivalTime: "2026-01-01T10:00:00Z" }, true)).toBe(2);
    expect(timelineStep({ status: "serving", arrivalTime: null }, false)).toBe(2);
    expect(timelineStep({ status: "completed", arrivalTime: null }, false)).toBe(3);
  });

  it("marks the current step", () => {
    render(<BookingTimeline step={1} />);
    expect(screen.getByText("On the way").closest("li")?.getAttribute("aria-current")).toBe("step");
  });
});

describe("Toasts", () => {
  beforeEach(() => useToastStore.setState({ toasts: [] }));

  it("shows one at a time, then the next", () => {
    vi.useFakeTimers();
    try {
      render(<ToastHost />);
      act(() => {
        pushToast("First", "info");
        pushToast("Second", "success");
      });
      expect(screen.getByText("First")).toBeTruthy();
      expect(screen.queryByText("Second")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(TOAST_MS);
      });
      expect(screen.queryByText("First")).toBeNull();
      expect(screen.getByText("Second")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a tap dismisses the current toast", () => {
    render(<ToastHost />);
    act(() => pushToast("Tap me", "info"));
    fireEvent.click(screen.getByText("Tap me"));
    expect(screen.queryByText("Tap me")).toBeNull();
  });
});

describe("Recent searches", () => {
  beforeEach(() => clearRecentSearches());

  it("keeps the last five, newest first, without duplicates", () => {
    for (const q of ["Wagholi", "Kharadi", "wagholi", "Viman Nagar", "Hadapsar", "Baner", "Aundh"]) addRecentSearch(q);
    expect(getRecentSearches()).toEqual(["Aundh", "Baner", "Hadapsar", "Viman Nagar", "wagholi"]);
    addRecentSearch("   ");
    expect(getRecentSearches()).toHaveLength(5);
  });
});

describe("Avatar", () => {
  it("initials from the name", () => {
    expect(initialsOf("Saurabh Yadav")).toBe("SY");
    expect(initialsOf("saurabh")).toBe("S");
    expect(initialsOf("  Ram  Kumar  Singh ")).toBe("RS");
    expect(initialsOf("")).toBe("?");
  });

  it("no photo: the initials image, never a stock picture", () => {
    const url = avatarUrl({ name: "Saurabh Yadav", profileImage: null } as never);
    expect(url.startsWith("data:image/svg+xml")).toBe(true);
    expect(decodeURIComponent(url)).toContain(">SY<");
  });

  it("an uploaded photo wins", () => {
    expect(avatarUrl({ name: "S", profileImage: "/uploads/profiles/p.png" } as never)).toBe("/uploads/profiles/p.png");
  });
});

describe("App colour", () => {
  it("green is stamped on <html> and remembered; red is the default", async () => {
    const { useUiStore } = await import("@/store/uiStore");
    expect(useUiStore.getState().accent).toBe("red");
    useUiStore.getState().setAccent("green");
    expect(document.documentElement.getAttribute("data-accent")).toBe("green");
    expect(JSON.parse(localStorage.getItem("fm-ui") ?? "{}").state.accent).toBe("green");
    useUiStore.getState().setAccent("red");
    expect(document.documentElement.getAttribute("data-accent")).toBe("red");
  });
});

describe("Nozzle note under the live queue", () => {
  it("follows the station's own nozzle setup", async () => {
    const { nozzleNote } = await import("./FuelQueuePreview");
    expect(nozzleNote("Diesel", { total: 2, online: 1 })).toBe(
      "Diesel has a dedicated nozzle for online bookings and a separate nozzle for walk-in customers.",
    );
    expect(nozzleNote("Petrol", { total: 4, online: 1 })).toBe(
      "Petrol has a dedicated nozzle for online bookings and 3 separate nozzles for walk-in customers.",
    );
    expect(nozzleNote("Petrol", { total: 1, online: 1 })).toBe(
      "Petrol has one nozzle, shared by online bookings and walk-in customers.",
    );
    expect(nozzleNote("CNG", { total: 2, online: 2 })).toBe("CNG has 2 nozzles, shared by online bookings and walk-in customers.");
    expect(nozzleNote("CNG", { total: 2, online: 0 })).toBe("CNG nozzles currently serve walk-in customers only.");
    expect(nozzleNote("Diesel", null)).toBe("Diesel has its own nozzle, shared by online bookings and walk-in customers.");
  });
});
