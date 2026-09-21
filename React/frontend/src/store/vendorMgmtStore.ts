import { create } from "zustand";
import * as api from "@/services/api/adminApi";
import type { ManagedVendor, VendorDetail, VendorMgmtStats } from "@/services/api/adminApi";

export type VmTab =
  | "dashboard"
  | "vendors"
  | "pending"
  | "active"
  | "suspended"
  | "rejected"
  | "revenue"
  | "stations";

export type VmFilter = "all" | "pending" | "under_review" | "active" | "suspended" | "rejected";

interface VendorMgmtState {
  tab: VmTab;
  loading: boolean;
  error: string | null;

  stats: VendorMgmtStats | null;
  vendors: ManagedVendor[];

  filter: VmFilter;
  search: string;
  /** Cards read better for triage; the table is there for scanning by revenue. */
  listView: "grid" | "table";

  /** null = the list; a vendor = the detail view. */
  selectedVendor: VendorDetail | null;
  detailLoading: boolean;

  load: () => Promise<void>;
  /** Refetch after a live event without the loading state; a failure keeps what is shown. */
  refreshLive: () => Promise<void>;
  setTab: (tab: VmTab) => void;
  setFilter: (filter: VmFilter) => void;
  setSearch: (search: string) => void;
  setListView: (view: "grid" | "table") => void;
  viewDetail: (id: string) => Promise<void>;
  backToList: () => void;
  reset: () => void;
}

/**
 * Vendor Management state -- Vanilla's `state.vendorMgmt`.
 *
 * Stats and the vendor list are always fetched together (vmLoadDashboard did
 * exactly this with Promise.all), because every tab is a different view over
 * the same two payloads: the status tabs filter `vendors` client-side and the
 * dashboard reads `stats`. Fetching per tab would re-request the same data.
 */
export const useVendorMgmtStore = create<VendorMgmtState>((set) => ({
  tab: "dashboard",
  loading: false,
  error: null,
  stats: null,
  vendors: [],
  filter: "all",
  search: "",
  listView: "grid",
  selectedVendor: null,
  detailLoading: false,

  refreshLive: async () => {
    try {
      const [stats, vendors] = await Promise.all([api.fetchVendorMgmtStats(), api.fetchManagedVendors()]);
      set({ stats, vendors });
    } catch {
      /* keep what is on screen; the next event retries */
    }
  },

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [stats, vendors] = await Promise.all([
        api.fetchVendorMgmtStats(),
        api.fetchManagedVendors(),
      ]);
      set({ stats, vendors, loading: false });
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      set({
        loading: false,
        error:
          status === 401 || status === 403
            ? "This view needs an administrator session. Sign in as an admin and try again."
            : "Failed to load vendor data. Is the backend running?",
      });
    }
  },

  // Switching tab always returns to the list: a detail view left open would
  // otherwise survive into a tab that is meant to show a different set.
  setTab: (tab) => set({ tab, selectedVendor: null }),

  setFilter: (filter) => set({ filter }),
  setSearch: (search) => set({ search }),
  setListView: (listView) => set({ listView }),

  viewDetail: async (id) => {
    set({ detailLoading: true });
    try {
      set({ selectedVendor: await api.fetchVendorDetail(id), detailLoading: false });
    } catch {
      set({ detailLoading: false, error: "Could not load that vendor." });
    }
  },

  backToList: () => set({ selectedVendor: null }),

  reset: () =>
    set({
      tab: "dashboard",
      loading: false,
      error: null,
      stats: null,
      vendors: [],
      filter: "all",
      search: "",
      listView: "grid",
      selectedVendor: null,
      detailLoading: false,
    }),
}));

/**
 * vmFilterVendors(). Status filter plus a case-insensitive search across the
 * four fields the original searched: name, business name, email, vendor code.
 */
export function filterVendors(
  vendors: ManagedVendor[],
  filter: VmFilter,
  search: string,
): ManagedVendor[] {
  let out = vendors;

  if (filter !== "all") {
    out =
      // "pending" deliberately includes under_review: both are open
      // applications and the Pending Approvals tab is where they get decided.
      filter === "pending"
        ? out.filter((v) => v.vendorStatus === "pending" || v.vendorStatus === "under_review")
        : out.filter((v) => v.vendorStatus === filter);
  }

  const q = search.trim().toLowerCase();
  if (q) {
    out = out.filter((v) =>
      [v.name, v.businessName, v.email, v.vendorCode]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(q)),
    );
  }

  return out;
}

/** The status a tab pins, or "all" when the chips are free to drive it. */
export function filterForTab(tab: VmTab): VmFilter {
  if (tab === "pending" || tab === "active" || tab === "suspended" || tab === "rejected") {
    return tab;
  }
  return "all";
}
