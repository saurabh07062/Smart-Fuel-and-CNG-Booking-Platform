import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { User } from "@/types";
import { configureSession } from "@/services/api/apiClient";
import { logoutRequest } from "@/services/api/authApi";
import { disconnectSocket, getSocket } from "@/services/socket/socket";
import { pushToast } from "./toastStore";

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  /** The server has just set the session cookies (login, registration, vendor code). */
  login: (user: User) => void;
  /** Sign this device out: the server revokes the session and clears its cookies. */
  logout: () => Promise<void>;
  /** The session ended on its own -- expired or revoked elsewhere: forget it here. */
  endSession: () => void;
  patchUser: (patch: Partial<User>) => void;
}

/**
 * Reset the per-identity stores.
 *
 * Imported lazily inside the call rather than at module scope: bookingStore
 * and notificationStore both import from services that import this file, and
 * a static import here would close that cycle.
 */
function clearSessionStores() {
  void import("./bookingStore").then((m) => m.useBookingStore.getState().clear());
  void import("./notificationStore").then((m) => m.useNotificationStore.getState().clear());
  void import("./bookingDraftStore").then((m) => m.useBookingDraftStore.getState().reset());
  // The next person must set their own location before choosing a fuel.
  void import("./locationStore").then((m) => m.useLocationStore.getState().resetSession());
}

/**
 * A fresh connection, so its handshake carries the cookies the browser holds
 * now -- the new session, or none. App-wide realtime (live prices, booking
 * updates, notifications) must follow the identity immediately, not only on
 * pages that happen to call getSocket().
 */
function reconnectSocket() {
  disconnectSocket();
  getSocket();
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,

      login: (user) => {
        // Every sign-in starts with "Use my location", then the fuel question.
        void import("./locationStore").then((m) => m.useLocationStore.getState().resetSession());
        set({ user, isAuthenticated: true });
        reconnectSocket();
      },

      logout: async () => {
        // Signed out on screen at once. Everything per-identity goes with the
        // session: leaving it would show this user's bookings and
        // notifications to whoever signs in next on this device.
        disconnectSocket();
        clearSessionStores();
        set({ user: null, isAuthenticated: false });
        // The server revokes the refresh token and clears both cookies. Only
        // then reconnect: a socket opened before that would still carry the
        // old access cookie and rejoin this user's private room.
        await logoutRequest();
        reconnectSocket();
      },

      endSession: () => {
        if (!get().isAuthenticated) return;
        clearSessionStores();
        set({ user: null, isAuthenticated: false });
        reconnectSocket();
        pushToast("Your session has ended. Please sign in again.", "warning");
      },

      patchUser: (patch) =>
        set((s) => (s.user ? { user: { ...s.user, ...patch } } : s)),
    }),
    {
      name: "fm-auth",
      // Per tab (sessionStorage): each tab can be signed in as a different
      // account (utils/tabId.ts, backend services/security/session.js).
      storage: createJSONStorage(() => sessionStorage),
      // Only the profile is persisted -- it is not a credential. Whether the
      // session is still valid is asked of the server on every start
      // (hooks/useAuthBoot.ts), because the cookies cannot be read here.
      partialize: (s) => ({ user: s.user, isAuthenticated: s.isAuthenticated }),
    },
  ),
);

// The API client refreshes an expired access cookie only while signed in,
// and hands back here when the session cannot be renewed.
configureSession({
  isSignedIn: () => useAuthStore.getState().isAuthenticated,
  onExpired: () => useAuthStore.getState().endSession(),
});


// The profile used to be kept in localStorage, shared by every tab.
try {
  localStorage.removeItem("fm-auth");
} catch {
  /* storage blocked */
}
