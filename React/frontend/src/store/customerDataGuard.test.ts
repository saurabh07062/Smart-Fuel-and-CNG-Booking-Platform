import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Customer-only endpoints (/api/customer/bookings, /api/customer/notifications)
 * are requested only for a signed-in customer. A vendor, admin or signed-out
 * tab used to call them on every booking event and reconnect and got 403/401.
 */
vi.mock("@/services/api/bookingApi", () => ({ fetchMyBookings: vi.fn(async () => []) }));
vi.mock("@/services/api/customerApi", () => ({ fetchNotifications: vi.fn(async () => []) }));
vi.mock("@/services/api/authApi", () => ({ logoutRequest: vi.fn() }));
vi.mock("@/services/socket/socket", () => ({ disconnectSocket: vi.fn(), getSocket: vi.fn(), isNewer: () => true }));

import * as bookingApi from "@/services/api/bookingApi";
import * as customerApi from "@/services/api/customerApi";
import { useAuthStore } from "./authStore";
import { useBookingStore } from "./bookingStore";
import { useNotificationStore } from "./notificationStore";

const signIn = (user: Record<string, unknown> | null) =>
  useAuthStore.setState({ user: user as never, isAuthenticated: Boolean(user) });

beforeEach(() => vi.clearAllMocks());

describe("customer data is fetched only for customers", () => {
  for (const [who, user] of [
    ["a signed-out visitor", null],
    ["a vendor", { id: "v1", role: "vendor" }],
    ["an admin", { id: "a1", role: "admin" }],
  ] as const) {
    it(`${who}: no request`, async () => {
      signIn(user);
      await useBookingStore.getState().load();
      await useNotificationStore.getState().load();
      expect(bookingApi.fetchMyBookings).not.toHaveBeenCalled();
      expect(customerApi.fetchNotifications).not.toHaveBeenCalled();
      expect(useBookingStore.getState().loading).toBe(false);
    });
  }

  it("a customer: both load", async () => {
    signIn({ id: "c1", role: "customer" });
    await useBookingStore.getState().load();
    await useNotificationStore.getState().load();
    expect(bookingApi.fetchMyBookings).toHaveBeenCalledTimes(1);
    expect(customerApi.fetchNotifications).toHaveBeenCalledTimes(1);
  });
});
