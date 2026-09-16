import { create } from "zustand";
import type {
  InventoryAlert,
  PriceHistoryEntry,
  VendorBooking,
  VendorCustomer,
  VendorDashboard,
  VendorEmployee,
  VendorReports,
  VendorRevenue,
  VendorStation,
} from "@/services/api/vendorApi";
import * as api from "@/services/api/vendorApi";

export type VendorTab =
  | "dashboard"
  | "stations"
  | "bookings"
  | "inventory"
  | "revenue"
  | "employees"
  | "customers"
  | "reports"
  | "profile";

interface VendorState {
  tab: VendorTab;
  loading: boolean;
  error: string | null;

  dashboard: VendorDashboard | null;
  stations: VendorStation[];
  /** Which station's bookings are being viewed, or null for the picker. */
  selectedStation: string | null;
  stationBookings: VendorBooking[];
  revenue: VendorRevenue | null;
  employees: VendorEmployee[];
  customers: VendorCustomer[];
  reports: VendorReports | null;
  profile: api.VendorProfile | null;
  inventoryAlerts: InventoryAlert[];
  priceHistory: PriceHistoryEntry[];
  /** Station whose price-history modal is open. */
  priceHistoryFor: string | null;

  setTab: (tab: VendorTab) => Promise<void>;
  loadTab: (tab: VendorTab) => Promise<void>;
  loadStations: () => Promise<void>;
  viewStationBookings: (stationId: string) => Promise<void>;
  backToStationList: () => void;
  openPriceHistory: (stationId: string) => Promise<void>;
  closePriceHistory: () => void;
  loadInventoryAlerts: () => Promise<void>;
  /**
   * Silent refresh of the open tab's live data after a socket event: no
   * loading spinner, no error screen, only the data the event can change.
   */
  refreshLive: () => Promise<void>;
  setProfile: (p: api.VendorProfile) => void;
  reset: () => void;
}

/** Turn any API rejection into the one message the console shows. */
function messageFor(err: unknown): string {
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status === 401 || status === 403) {
    return "Your vendor session has expired or this account is not activated. Sign in again.";
  }
  return (
    (err as { response?: { data?: { msg?: string } } })?.response?.data?.msg ??
    "Could not load this data."
  );
}

/**
 * Vendor panel state -- Vanilla's `state.vendorPanel`.
 *
 * Each tab loads its own data on the way in, exactly as switchVendorTab()
 * did. The Vanilla version set `loading = true` and then called render()
 * before every fetch; here the flag lives with the data it describes, so a
 * tab cannot render its "click to load" empty state while a request for it
 * is already in flight.
 */
export const useVendorStore = create<VendorState>((set, get) => ({
  tab: "dashboard",
  loading: false,
  error: null,

  dashboard: null,
  stations: [],
  selectedStation: null,
  stationBookings: [],
  revenue: null,
  employees: [],
  customers: [],
  reports: null,
  profile: null,
  inventoryAlerts: [],
  priceHistory: [],
  priceHistoryFor: null,

  setTab: async (tab) => {
    // Leaving the bookings tab drops the drill-down, so returning to it lands
    // on the station picker rather than a stale station's booking list.
    set({ tab, error: null, ...(tab !== "bookings" ? { selectedStation: null } : {}) });
    await get().loadTab(tab);
  },

  loadTab: async (tab) => {
    set({ loading: true, error: null });
    try {
      switch (tab) {
        case "dashboard":
          set({ dashboard: await api.fetchVendorDashboard() });
          break;
        // Three tabs are all driven by the station list, as in the original.
        case "stations":
        case "bookings":
        case "inventory":
          set({ stations: await api.fetchVendorStations() });
          break;
        case "revenue":
          set({ revenue: await api.fetchVendorRevenue() });
          break;
        case "employees":
          // The add-employee form needs the station list for its dropdown, so
          // both are fetched. The Vanilla page rendered that select from
          // vp.stations and only loaded employees, leaving the dropdown empty
          // whenever Employees was opened before Stations.
          set({
            employees: await api.fetchVendorEmployees(),
            stations: get().stations.length ? get().stations : await api.fetchVendorStations(),
          });
          break;
        case "customers":
          set({ customers: await api.fetchVendorCustomers() });
          break;
        case "reports":
          set({ reports: await api.fetchVendorReports() });
          break;
        case "profile":
          set({ profile: await api.fetchVendorProfile() });
          break;
      }
      set({ loading: false });
    } catch (err) {
      set({ loading: false, error: messageFor(err) });
    }
  },

  loadStations: async () => {
    try {
      set({ stations: await api.fetchVendorStations() });
    } catch (err) {
      set({ error: messageFor(err) });
    }
  },

  viewStationBookings: async (stationId) => {
    set({ selectedStation: stationId, loading: true, error: null });
    try {
      set({ stationBookings: await api.fetchStationBookings(stationId), loading: false });
    } catch (err) {
      set({ loading: false, error: messageFor(err) });
    }
  },

  backToStationList: () => set({ selectedStation: null, stationBookings: [] }),

  openPriceHistory: async (stationId) => {
    try {
      set({ priceHistory: await api.fetchPriceHistory(stationId), priceHistoryFor: stationId });
    } catch (err) {
      set({ error: messageFor(err) });
    }
  },

  closePriceHistory: () => set({ priceHistoryFor: null, priceHistory: [] }),

  loadInventoryAlerts: async () => {
    try {
      set({ inventoryAlerts: await api.fetchInventoryAlerts() });
    } catch (err) {
      set({ error: messageFor(err) });
    }
  },

  refreshLive: async () => {
    const { tab, selectedStation } = get();
    try {
      if (tab === "dashboard") {
        set({ dashboard: await api.fetchVendorDashboard() });
      } else if (tab === "bookings" && selectedStation) {
        const rows = await api.fetchStationBookings(selectedStation);
        // The vendor may have gone back to the picker or opened another station meanwhile.
        if (get().tab === "bookings" && get().selectedStation === selectedStation) set({ stationBookings: rows });
      } else if (tab === "revenue") {
        // Revenue is re-read from the server after every booking event, never
        // adjusted on the client, so a repeated event cannot count anything twice.
        set({ revenue: await api.fetchVendorRevenue() });
      } else if (tab === "reports") {
        set({ reports: await api.fetchVendorReports() });
      } else if (tab === "customers") {
        set({ customers: await api.fetchVendorCustomers() });
      } else if (tab === "stations" || tab === "bookings" || tab === "inventory") {
        set({ stations: await api.fetchVendorStations() });
      }
    } catch {
      /* a live refresh never replaces the tab with an error; the next event or resync retries */
    }
  },

  setProfile: (profile) => set({ profile }),

  reset: () =>
    set({
      tab: "dashboard",
      loading: false,
      error: null,
      dashboard: null,
      stations: [],
      selectedStation: null,
      stationBookings: [],
      revenue: null,
      employees: [],
      customers: [],
      reports: null,
      profile: null,
      inventoryAlerts: [],
      priceHistory: [],
      priceHistoryFor: null,
    }),
}));
