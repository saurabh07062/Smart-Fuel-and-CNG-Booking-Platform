import type { ReactNode } from "react";
import ConsoleShell, { type ConsoleTab } from "@/components/console/ConsoleShell";
import { useAuthStore } from "@/store/authStore";
import { useVendorStore, type VendorTab } from "@/store/vendorStore";

/** The rail's items, in the Vanilla order with the Vanilla icons. (Reviews is hidden for now.) */
const TABS: ConsoleTab<VendorTab>[] = [
  { id: "dashboard", icon: "fa-tachometer-alt", label: "Dashboard" },
  { id: "stations", icon: "fa-gas-pump", label: "My Stations" },
  { id: "bookings", icon: "fa-calendar-check", label: "Bookings" },
  { id: "inventory", icon: "fa-boxes", label: "Inventory" },
  { id: "revenue", icon: "fa-wallet", label: "Revenue" },
  { id: "employees", icon: "fa-users", label: "Employees" },
  { id: "customers", icon: "fa-user-friends", label: "Customers" },
  { id: "reports", icon: "fa-chart-bar", label: "Reports" },
  { id: "profile", icon: "fa-cog", label: "Profile" },
];

/** VP_COPY -- the subtitle under the business name, per tab. */
const COPY: Record<VendorTab, string> = {
  dashboard: "Today's activity across your stations",
  stations: "The stations you own and their live status",
  bookings: "Customers booked in at your pumps",
  inventory: "Fuel stock, and what is running low",
  revenue: "What your stations are earning",
  employees: "Staff with access to your panel",
  customers: "People who have fuelled with you",
  reports: "Demand forecasting and history",
  profile: "Your business details and payout settings",
};

/**
 * The vendor console's chrome -- port of renderVendorPanel()'s shell.
 *
 * The rail/topbar markup itself now lives in ConsoleShell, shared with the
 * three admin consoles, because all four pages render the same structure in
 * the Vanilla app. This file keeps what is genuinely vendor-specific: the ten
 * tabs, their copy, and showing the business name as the title.
 */
export default function VendorShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const tab = useVendorStore((s) => s.tab);
  const setTab = useVendorStore((s) => s.setTab);
  const loadTab = useVendorStore((s) => s.loadTab);
  const resetVendor = useVendorStore((s) => s.reset);

  return (
    <ConsoleShell
      logoIcon="fa-store"
      logoName="Vendor Panel"
      logoSub="Station Owner"
      tabs={TABS}
      activeTab={tab}
      onTabChange={(t) => void setTab(t)}
      title={user?.businessName || "Fuel Station Owner"}
      subtitle={COPY[tab]}
      onRefresh={() => void loadTab(tab)}
      userRole="Vendor"
      onBeforeLogout={resetVendor}
    >
      {children}
    </ConsoleShell>
  );
}
