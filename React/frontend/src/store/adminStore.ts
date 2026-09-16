import { create } from "zustand";
import type { Station } from "@/types";
import * as api from "@/services/api/adminApi";
import type { AdminOrdersResponse, OrderFilters, SuperAdminDashboard } from "@/services/api/adminApi";

export type AdminTab =
  | "dashboard"
  | "stations"
  | "orders"
  | "verify"
  | "security"
  | "inventory"
  | "revenue"
  | "forecast"
  | "settings";

interface AdminState {
  tab: AdminTab;

  /** null = loading, [] = loaded-and-empty. The Vanilla distinction, kept. */
  stations: Station[] | null;
  orders: AdminOrdersResponse | null;
  orderFilters: OrderFilters;
  /** Real dashboard figures (GET /api/v1/admin/dashboard); null until loaded. */
  dashboard: SuperAdminDashboard | null;
  dashboardError: string | null;

  editingStationId: string | null;
  creatingStation: boolean;

  setTab: (tab: AdminTab) => Promise<void>;
  loadStations: () => Promise<void>;
  loadOrders: (filters?: OrderFilters) => Promise<void>;
  loadDashboard: () => Promise<void>;
  setOrderFilters: (f: OrderFilters) => void;
  /** Silent refetches for socket events: what is on screen stays until new data replaces it. */
  refreshOrdersLive: () => Promise<void>;
  refreshStationsLive: () => Promise<void>;
  setEditingStation: (id: string | null) => void;
  setCreatingStation: (v: boolean) => void;
  reset: () => void;
}

/** Tabs that render the dashboard figures (AdminDashboardTab). */
const DASHBOARD_TABS: AdminTab[] = ["dashboard", "inventory"];

/**
 * Admin console state -- Vanilla's `state.adminTab`, `state.adminStations`,
 * `state.adminOrders`, `state.editingStationId`, `state.creatingStation`.
 *
 * `stations: null` means "still loading" and `[]` means "loaded, none found",
 * exactly as switchAdminTab() set them; the station manager renders a
 * different screen for each, so collapsing them would show "No stations
 * found. Create one to get started." during every load.
 *
 * The dashboard's figures come from the server's aggregation of real bookings
 * and stations. They are re-read after booking and station socket events,
 * never adjusted on the client.
 */
export const useAdminStore = create<AdminState>((set, get) => ({
  tab: "dashboard",
  stations: null,
  orders: null,
  orderFilters: {},
  dashboard: null,
  dashboardError: null,
  editingStationId: null,
  creatingStation: false,

  setTab: async (tab) => {
    // Leaving the station manager drops any half-finished edit, so returning
    // lands on the list rather than a form for a station that may be gone.
    set({ tab, editingStationId: null, creatingStation: false });
    if (tab === "stations") await get().loadStations();
    if (tab === "orders") await get().loadOrders(get().orderFilters);
    if (DASHBOARD_TABS.includes(tab)) await get().loadDashboard();
  },

  loadStations: async () => {
    set({ stations: null });
    try {
      set({ stations: await api.fetchAllStations() });
    } catch {
      set({ stations: [] });
    }
  },

  loadOrders: async (filters) => {
    const f = filters ?? get().orderFilters;
    set({ orders: null, orderFilters: f });
    try {
      set({ orders: await api.fetchAdminOrders(f) });
    } catch {
      // Same shape as a real empty response, so the table renders its own
      // "No orders found" rather than throwing on `orders.stations`.
      set({ orders: { summary: {}, stations: [], total: 0 } });
    }
  },

  loadDashboard: async () => {
    set({ dashboardError: null });
    try {
      set({ dashboard: await api.fetchSuperAdminDashboard() });
    } catch {
      set({ dashboardError: "Could not load the dashboard from the server." });
    }
  },

  setOrderFilters: (orderFilters) => set({ orderFilters }),

  refreshOrdersLive: async () => {
    const { tab, orderFilters } = get();
    try {
      if (tab === "orders") set({ orders: await api.fetchAdminOrders(orderFilters) });
      else if (DASHBOARD_TABS.includes(tab)) set({ dashboard: await api.fetchSuperAdminDashboard() });
    } catch {
      /* keep what is on screen */
    }
  },

  refreshStationsLive: async () => {
    const s = get();
    try {
      // Stock and the live queue on the dashboard move with station events too.
      if (DASHBOARD_TABS.includes(s.tab)) {
        set({ dashboard: await api.fetchSuperAdminDashboard() });
        return;
      }
      // Never swap the list under a station form the admin is filling in.
      if (s.tab !== "stations" || s.editingStationId || s.creatingStation) return;
      set({ stations: await api.fetchAllStations() });
    } catch {
      /* keep what is on screen */
    }
  },

  setEditingStation: (editingStationId) => set({ editingStationId, creatingStation: false }),
  setCreatingStation: (creatingStation) => set({ creatingStation, editingStationId: null }),

  reset: () =>
    set({
      tab: "dashboard",
      stations: null,
      orders: null,
      orderFilters: {},
      dashboard: null,
      dashboardError: null,
      editingStationId: null,
      creatingStation: false,
    }),
}));
