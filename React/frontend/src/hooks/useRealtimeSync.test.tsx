import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

/**
 * The app-wide wiring from socket events to stores: what a customer's lists
 * see when a vendor adds, edits or removes a station, changes a price, stock
 * or queue, or when a booking changes -- without a page refresh.
 */
const socket = vi.hoisted(() => {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  return {
    handlers,
    emit: (event: string, payload: unknown) => handlers.get(event)?.forEach((h) => h(payload)),
  };
});
vi.mock("@/services/socket/socket", async (orig) => ({
  ...(await orig<typeof import("@/services/socket/socket")>()),
  onSocket: (event: string, handler: (p: unknown) => void) => {
    if (!socket.handlers.has(event)) socket.handlers.set(event, new Set());
    socket.handlers.get(event)!.add(handler);
    return () => socket.handlers.get(event)!.delete(handler);
  },
  onResync: () => () => {},
  getSocket: vi.fn(),
  disconnectSocket: vi.fn(),
}));
vi.mock("@/services/api/bookingApi", () => ({ fetchMyBookings: vi.fn(async () => []) }));
vi.mock("@/services/api/stationApi", () => ({ fetchStations: vi.fn(async () => []) }));
vi.mock("@/services/api/authApi", () => ({ logoutRequest: vi.fn() }));
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: (select: (s: unknown) => unknown) => select({ add: vi.fn(), load: vi.fn() }),
}));

import * as bookingApi from "@/services/api/bookingApi";
import { useRealtimeSync } from "./useRealtimeSync";
import { useStationStore } from "@/store/stationStore";
import { useBookingStore } from "@/store/bookingStore";
import { mapBackendStation } from "@/utils/station";
import type { Station, UiStation } from "@/types";

function Harness() {
  useRealtimeSync();
  const location = useLocation();
  return <p data-testid="path">{location.pathname}</p>;
}

let unmountHarness: (() => void) | null = null;
function renderHarness(path = "/dashboard") {
  unmountHarness?.();
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Harness />
    </MemoryRouter>,
  );
  unmountHarness = view.unmount;
  return view;
}

const raw = (over: Record<string, unknown> = {}) =>
  ({
    _id: "s1",
    name: "Baner Fuels",
    address: "Baner Road",
    status: "Active",
    fuelTypes: ["Petrol", "CNG"],
    prices: { petrol: 100, cng: 80 },
    queueLength: 0,
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...over,
  }) as unknown as Station & Record<string, unknown>;

const later = (n: number) => `2026-09-01T10:0${n}:00.000Z`;

beforeEach(() => {
  socket.handlers.clear();
  useStationStore.setState({ stations: [mapBackendStation(raw()) as UiStation], selected: null });
  useBookingStore.setState({ bookings: [], loading: false, error: null });
  renderHarness();
});

const station = () => useStationStore.getState().stations.find((s) => s.id === "s1");

describe("live updates reach the customer's stores", () => {
  it("station created: appears in the list once", () => {
    const fresh = raw({ _id: "s2", name: "New Pump" });
    act(() => {
      socket.emit("station:created", fresh);
      socket.emit("station:created", fresh);
    });
    expect(useStationStore.getState().stations.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("station updated: name and pump photos change in place", () => {
    act(() =>
      socket.emit("station:updated", {
        _id: "s1",
        name: "Baner Fuels & CNG",
        pumpImages: { petrol: "/uploads/stations/p.png", cng: "/uploads/stations/c.png" },
        updatedAt: later(1),
      }),
    );
    expect(station()?.name).toBe("Baner Fuels & CNG");
    expect(station()?.pumpImages).toEqual({ petrol: "/uploads/stations/p.png", cng: "/uploads/stations/c.png" });
  });

  it("price updated: the displayed price changes", () => {
    act(() =>
      socket.emit("fuelPrice:updated", { _id: "s1", prices: { petrol: 104.5, cng: 80 }, fuelType: "petrol", newPrice: 104.5, updatedAt: later(2) }),
    );
    expect(station()?.uiPrices.Petrol).toBe(104.5);
  });

  it("availability, queue and stock updates are applied", () => {
    act(() => {
      socket.emit("fuelAvailability:updated", { _id: "s1", fuelAvailability: { petrol: false }, updatedAt: later(3) });
      socket.emit("queue:updated", { _id: "s1", queueLength: 6, waitMinutes: 18, updatedAt: later(4) });
    });
    expect(station()?.fuelAvailability).toEqual({ petrol: false });
    expect(station()?.queueLength).toBe(6);
    expect(station()?.queueStatus).toBeTruthy();
  });

  it("an older event never overwrites newer data", () => {
    act(() => socket.emit("station:updated", { _id: "s1", name: "Newest", updatedAt: later(5) }));
    act(() => socket.emit("station:updated", { _id: "s1", name: "Stale", updatedAt: later(1) }));
    expect(station()?.name).toBe("Newest");
  });

  it("station deleted: removed from the list (the payload carries only the id)", () => {
    act(() => socket.emit("station:deleted", { id: "s1" }));
    expect(station()).toBeUndefined();
  });

  it("a signed-in vendor who is suspended sees it at once; an admin's own session is untouched", async () => {
    const { useAuthStore } = await import("@/store/authStore");
    useAuthStore.setState({ user: { id: "v1", role: "vendor", vendorStatus: "active", activated: true } as never, isAuthenticated: true });
    renderHarness();
    act(() => socket.emit("vendor:statusChanged", { vendorId: "v1", vendorStatus: "suspended", activated: true }));
    expect(useAuthStore.getState().user?.vendorStatus).toBe("suspended");

    // The same event about another vendor changes nothing here.
    act(() => socket.emit("vendor:statusChanged", { vendorId: "v2", vendorStatus: "rejected" }));
    expect(useAuthStore.getState().user?.vendorStatus).toBe("suspended");

    useAuthStore.setState({ user: { id: "a1", role: "admin" } as never, isAuthenticated: true });
    act(() => socket.emit("vendor:statusChanged", { vendorId: "a1", vendorStatus: "suspended" }));
    expect(useAuthStore.getState().user?.vendorStatus).toBeUndefined();
  });

  it("fueling starts: the customer is taken to that booking's countdown page, once", async () => {
    const { useAuthStore } = await import("@/store/authStore");
    useAuthStore.setState({ user: { id: "c1", role: "customer" } as never, isAuthenticated: true });
    renderHarness("/stations");
    expect(screen.getByTestId("path").textContent).toBe("/stations");

    act(() => socket.emit("booking:updated", { _id: "b9", user: "c1", status: "serving", updatedAt: later(1) }));
    expect(screen.getByTestId("path").textContent).toBe("/confirmation/b9");

    // Later events for the same fill (queue refreshes, refetches) do not pull them back.
    act(() => socket.emit("booking:updated", { _id: "b9", user: "c1", status: "serving", updatedAt: later(2) }));
    expect(screen.getByTestId("path").textContent).toBe("/confirmation/b9");
  });

  it("not for someone else's booking, a status other than serving, or a vendor/admin session", async () => {
    const { useAuthStore } = await import("@/store/authStore");

    useAuthStore.setState({ user: { id: "c1", role: "customer" } as never, isAuthenticated: true });
    renderHarness("/dashboard");
    act(() => {
      socket.emit("booking:updated", { _id: "x1", user: "someone-else", status: "serving", updatedAt: later(1) });
      socket.emit("booking:updated", { _id: "x2", user: "c1", status: "upcoming", updatedAt: later(1) });
    });
    expect(screen.getByTestId("path").textContent).toBe("/dashboard");

    for (const role of ["vendor", "admin"]) {
      useAuthStore.setState({ user: { id: "c1", role } as never, isAuthenticated: true });
      renderHarness("/vendor");
      act(() => socket.emit("booking:updated", { _id: `v-${role}`, user: "c1", status: "serving", updatedAt: later(1) }));
      expect(screen.getByTestId("path").textContent).toBe("/vendor");
    }
  });

  it("booking created or updated: shown at once, then refetched from the server", async () => {
    const { useAuthStore } = await import("@/store/authStore");
    useAuthStore.setState({ user: { id: "c1", role: "customer" } as never, isAuthenticated: true });
    vi.mocked(bookingApi.fetchMyBookings).mockResolvedValue([]);
    act(() => socket.emit("booking:created", { _id: "b1", status: "upcoming", fuelType: "Petrol", updatedAt: later(1) }));
    expect(useBookingStore.getState().bookings.map((b) => b._id)).toEqual(["b1"]);
    expect(bookingApi.fetchMyBookings).toHaveBeenCalled();
  });
});
