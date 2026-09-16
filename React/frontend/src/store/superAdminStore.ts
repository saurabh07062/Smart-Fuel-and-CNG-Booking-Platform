import { create } from "zustand";
import * as api from "@/services/api/adminApi";
import type { SuperAdminDashboard } from "@/services/api/adminApi";

export type SaTab = "dashboard" | "vendors" | "revenue";

interface SuperAdminState {
  tab: SaTab;
  data: SuperAdminDashboard | null;
  loading: boolean;
  error: string | null;

  setTab: (tab: SaTab) => void;
  load: () => Promise<void>;
  reset: () => void;
}

/**
 * Super Admin state.
 *
 * The Vanilla page carried a `superAdminLoading` flag purely to break a
 * render loop: renderSuperAdmin() called fetchSuperAdminData() whenever
 * `superadminData` was null, and that function called render() -- so a failed
 * request spun forever. Fetching from an effect instead of from a render
 * removes the loop rather than guarding it, and `loading` here is only used
 * to show the skeleton.
 */
export const useSuperAdminStore = create<SuperAdminState>((set) => ({
  tab: "dashboard",
  data: null,
  loading: false,
  error: null,

  setTab: (tab) => set({ tab }),

  load: async () => {
    set({ loading: true, error: null });
    try {
      set({ data: await api.fetchSuperAdminDashboard(), loading: false });
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      set({
        loading: false,
        error:
          status === 401 || status === 403
            ? "This view needs an administrator session. Sign in as an admin and try again."
            : status
              ? "The server could not return the global dashboard."
              : "Could not reach the server. Is the backend running?",
      });
    }
  },

  reset: () => set({ tab: "dashboard", data: null, loading: false, error: null }),
}));
