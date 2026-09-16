import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import ConsoleShell, { type ConsoleTab } from "@/components/console/ConsoleShell";
import AdminStationsTab from "@/components/admin/AdminStationsTab";
import AdminOrdersTab from "@/components/admin/AdminOrdersTab";
import AdminVerifyTab from "@/components/admin/AdminVerifyTab";
import AdminDashboardTab from "@/components/admin/AdminDashboardTab";
import AdminSettingsTab from "@/components/admin/AdminSettingsTab";
import AdminSecurityTab from "@/components/admin/AdminSecurityTab";
import AdminForecastTab from "@/components/admin/AdminForecastTab";
import { useAdminStore, type AdminTab } from "@/store/adminStore";
import { useResync, useSocketEvent } from "@/hooks/useSocket";
import { coalesce } from "@/utils/coalesce";
import { SOCKET_EVENTS } from "@/services/socket/socketEvents";

/** ADMIN_TABS, in the Vanilla order with the Vanilla icons. */
const TABS: ConsoleTab<AdminTab>[] = [
  { id: "dashboard", icon: "fa-chart-simple", label: "Dashboard" },
  { id: "stations", icon: "fa-gas-pump", label: "Manage Stations" },
  { id: "orders", icon: "fa-box", label: "Orders" },
  { id: "verify", icon: "fa-qrcode", label: "Scan & Verify" },
  { id: "security", icon: "fa-shield-halved", label: "Security" },
  { id: "inventory", icon: "fa-boxes-stacked", label: "Inventory" },
  { id: "revenue", icon: "fa-indian-rupee-sign", label: "Revenue" },
  { id: "forecast", icon: "fa-chart-line", label: "Forecasting" },
  { id: "settings", icon: "fa-gear", label: "Settings" },
];

/** ADMIN_COPY. */
const COPY: Record<AdminTab, string> = {
  dashboard: "Today's activity across every station",
  stations: "Add, edit and take stations offline",
  orders: "Every booking placed on the platform",
  verify: "Scan a customer's QR or enter their 4-digit code",
  security: "Booking requests the risk engine blocked or flagged",
  inventory: "Fuel stock levels by station",
  revenue: "What the network is earning",
  forecast: "Projected demand from booking history",
  settings: "Prices, location and platform configuration",
};

/**
 * The admin console -- port of renderAdminDashboard() and switchAdminTab().
 *
 * REAL-TIME: an admin is in the `admin` room, which receives every booking
 * event on the platform. The Orders tab refreshes from those rather than
 * polling, so a customer booking or a vendor status change appears without
 * the admin pressing Refresh.
 */
export default function AdminPanel() {
  const navigate = useNavigate();
  const tab = useAdminStore((s) => s.tab);
  const setTab = useAdminStore((s) => s.setTab);
  const loadOrders = useAdminStore((s) => s.loadOrders);
  const loadStations = useAdminStore((s) => s.loadStations);
  const loadDashboard = useAdminStore((s) => s.loadDashboard);
  const reset = useAdminStore((s) => s.reset);

  useEffect(() => {
    void setTab("dashboard");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Refresh only what the event can change, and only when it is on screen --
   * an event must not refetch seven tabs the admin is not looking at.
   * Current tab is read from the store inside the handler so the
   * subscription itself stays stable.
   */
  // Silent and coalesced (utils/coalesce.ts): the table keeps showing its rows
  // while fresh ones load, and a burst of events costs at most two requests.
  const onBookingEvent = useMemo(() => coalesce(() => useAdminStore.getState().refreshOrdersLive()), []);

  useSocketEvent(SOCKET_EVENTS.BOOKING_CREATED, onBookingEvent);
  useSocketEvent(SOCKET_EVENTS.BOOKING_UPDATED, onBookingEvent);
  useSocketEvent(SOCKET_EVENTS.BOOKING_CANCELLED, onBookingEvent);
  useSocketEvent(SOCKET_EVENTS.BOOKING_COMPLETED, onBookingEvent);

  // A station created, edited, deleted, re-priced, restocked or with a moved
  // queue anywhere on the platform changes what the station manager shows.
  const onStationEvent = useMemo(() => coalesce(() => useAdminStore.getState().refreshStationsLive()), []);

  useSocketEvent(SOCKET_EVENTS.STATION_CREATED, onStationEvent);
  useSocketEvent(SOCKET_EVENTS.STATION_UPDATED, onStationEvent);
  useSocketEvent(SOCKET_EVENTS.STATION_DELETED, onStationEvent);
  useSocketEvent(SOCKET_EVENTS.FUEL_PRICE_UPDATED, onStationEvent);
  useSocketEvent(SOCKET_EVENTS.INVENTORY_UPDATED, onStationEvent);
  useSocketEvent(SOCKET_EVENTS.QUEUE_UPDATED, onStationEvent);

  // Events missed while disconnected are gone: refetch after a reconnect.
  useResync(() => {
    onBookingEvent();
    onStationEvent();
  }, [onBookingEvent, onStationEvent]);

  const refresh = () => {
    if (tab === "stations") void loadStations();
    else if (tab === "dashboard" || tab === "inventory") void loadDashboard();
    else void loadOrders();
  };

  const body = () => {
    switch (tab) {
      case "stations":
        return <AdminStationsTab />;
      case "orders":
        return <AdminOrdersTab />;
      case "verify":
        return <AdminVerifyTab />;
      case "security":
        return <AdminSecurityTab />;
      case "settings":
        return <AdminSettingsTab />;
      case "forecast":
        // Real data: GET /api/v1/admin/analytics (gated forecast + sales).
        return <AdminForecastTab />;
      case "revenue":
        // Still a placeholder from the Vanilla console.
        return (
          <div className="flex flex-col items-center justify-center h-[60vh]">
            <i className="fas fa-tools text-6xl mb-4 opacity-50 vm-text-muted" aria-hidden />
            <h3 className="text-xl font-bold vm-text-muted">Under Construction</h3>
            <p className="vm-text-muted mt-2">This module is coming in the next update.</p>
          </div>
        );
      case "inventory":
      case "dashboard":
      default:
        return <AdminDashboardTab tab={tab} />;
    }
  };

  return (
    <ConsoleShell
      logoIcon="fa-user-shield"
      logoName="Admin Panel"
      logoSub="Secure Access"
      tabs={TABS}
      activeTab={tab}
      onTabChange={(t) => void setTab(t)}
      title="FuelMart Admin"
      subtitle={COPY[tab]}
      onRefresh={refresh}
      onBeforeLogout={reset}
      railExtra={
        <button
          type="button"
          className="vm-nav-item"
          onClick={() => navigate("/admin/vendors")}
          style={{
            marginTop: 8,
            borderTop: "1px solid var(--z-line)",
            paddingTop: 14,
            borderRadius: "0 0 10px 10px",
          }}
        >
          <i className="fas fa-store" aria-hidden />
          <span>Vendor Management</span>
        </button>
      }
    >
      {body()}
    </ConsoleShell>
  );
}
