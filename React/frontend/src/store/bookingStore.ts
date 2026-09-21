import { create } from "zustand";
import type { Booking } from "@/types";
import { fetchMyBookings } from "@/services/api/bookingApi";
import { isNewer } from "@/services/socket/socket";
import { useAuthStore } from "./authStore";

interface BookingState {
  bookings: Booking[];
  loading: boolean;
  error: string | null;
  /** "View All" vs "Active only" on the dashboard. Ported from state.showAllBookings. */
  showAll: boolean;

  load: () => Promise<void>;
  setShowAll: (v: boolean) => void;
  /** Insert or merge one booking from a socket event. */
  upsert: (booking: Partial<Booking> & { _id?: string; id?: string }) => void;
  remove: (id: string) => void;
  clear: () => void;
}

/** Customer-only data is fetched only for a signed-in customer. */
export function isSignedInCustomer(): boolean {
  const { isAuthenticated, user } = useAuthStore.getState();
  return isAuthenticated && user?.role === "customer";
}

const idOf =(b: { _id?: string; id?: string } | null | undefined) => String(b?._id ?? b?.id ?? "");

export const useBookingStore = create<BookingState>((set) => ({
  bookings: [],
  loading: false,
  error: null,
  showAll: false,

  load: async () => {
    // A customer's own bookings. The app-wide live-update wiring calls this on
    // every booking event and reconnect -- which vendors, admins and signed-out
    // visitors also receive -- and asking then only produced 403/401s
    // (/api/customer/bookings is customer-only). Nothing to load for them.
    if (!isSignedInCustomer()) return;
    set({ loading: true, error: null });
    try {
      const bookings = await fetchMyBookings();
      set({ bookings, loading: false });
    } catch {
      // A failed refresh must not blank a list the user is already reading,
      // so the previous bookings are kept and only the error is surfaced.
      set({ loading: false, error: "Could not load your bookings." });
    }
  },

  setShowAll: (showAll) => set({ showAll }),

  /**
   * Merge, never replace.
   *
   * A booking event carries only what changed (a status, a completion time),
   * so overwriting the row would blank the station, fuel and amount the card
   * renders. The timestamp guard drops an event older than what is held --
   * a reconnect resync can race the events that follow it.
   */
  upsert: (payload) =>
    set((s) => {
      const id = idOf(payload);
      if (!id) return s;

      const idx = s.bookings.findIndex((b) => idOf(b) === id);
      if (idx === -1) {
        return { bookings: [payload as Booking, ...s.bookings] };
      }

      const prev = s.bookings[idx];
      if (!isNewer(payload as Record<string, unknown>, prev as unknown as Record<string, unknown>)) {
        return s;
      }

      const patch = Object.fromEntries(
        Object.entries(payload).filter(([, v]) => v !== undefined),
      ) as Partial<Booking>;

      const next = s.bookings.slice();
      next[idx] = { ...prev, ...patch };
      return { bookings: next };
    }),

  remove: (id) => set((s) => ({ bookings: s.bookings.filter((b) => idOf(b) !== String(id)) })),

  clear: () => set({ bookings: [], error: null, showAll: false }),
}));

/** Read one booking without subscribing a component to the whole list. */
export function getBooking(id: string): Booking | undefined {
  return useBookingStore.getState().bookings.find((b) => idOf(b) === String(id));
}
