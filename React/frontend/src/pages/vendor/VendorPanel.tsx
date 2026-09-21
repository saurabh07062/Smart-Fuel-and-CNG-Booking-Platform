import { useEffect, useMemo } from "react";
import VendorShell from "@/components/vendor/VendorShell";
import DashboardTab from "@/components/vendor/tabs/DashboardTab";
import StationsTab from "@/components/vendor/tabs/StationsTab";
import BookingsTab from "@/components/vendor/tabs/BookingsTab";
import InventoryTab from "@/components/vendor/tabs/InventoryTab";
import RevenueTab from "@/components/vendor/tabs/RevenueTab";
import EmployeesTab from "@/components/vendor/tabs/EmployeesTab";
import ReportsTab from "@/components/vendor/tabs/ReportsTab";
import ProfileTab from "@/components/vendor/tabs/ProfileTab";
import { CustomersTab } from "@/components/vendor/tabs/ReviewsCustomersTabs";
import { useVendorStore } from "@/store/vendorStore";
import { useResync, useSocketEvent } from "@/hooks/useSocket";
import { SOCKET_EVENTS } from "@/services/socket/socketEvents";
import { coalesce } from "@/utils/coalesce";
import { fetchVendorStations } from "@/services/api/vendorApi";

/**
 * The vendor console -- port of renderVendorPanel() and its ten tabs.
 *
 * REAL-TIME: the vendor is in their own `vendor:<id>` room, so a booking made
 * by a customer arrives here as booking:created without any polling. The
 * handlers below refresh only what that event can change and only when the
 * relevant tab is open, so an event does not refetch nine tabs the vendor is
 * not looking at.
 */
export default function VendorPanel() {
  const tab = useVendorStore((s) => s.tab);
  const loading = useVendorStore((s) => s.loading);
  const error = useVendorStore((s) => s.error);
  const loadTab = useVendorStore((s) => s.loadTab);

  // First paint loads the tab the console opens on. A vendor with no station
  // yet (just approved) is taken to Stations, where the Add form opens.
  useEffect(() => {
    void loadTab("dashboard");
    void fetchVendorStations()
      .then((list) => {
        const s = useVendorStore.getState();
        if (list.length === 0 && s.tab === "dashboard") void s.setTab("stations");
      })
      .catch(() => {
        /* stay on the dashboard; its own error state covers a failed load */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Every event this vendor's room receives concerns one of their own
   * stations: a booking, its queue and slots, a price, stock or status change.
   * Each one silently refreshes only the open tab's live data (refreshLive
   * reads the tab and selected station from the store, so the subscriptions
   * stay stable), and a burst of events for one change costs at most two
   * requests (coalesce).
   */
  const refreshLive = useMemo(() => coalesce(() => useVendorStore.getState().refreshLive()), []);

  useSocketEvent(SOCKET_EVENTS.BOOKING_CREATED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.BOOKING_UPDATED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.BOOKING_CANCELLED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.BOOKING_COMPLETED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.QUEUE_UPDATED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.SLOT_UPDATED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.STATION_UPDATED, refreshLive);
  // A station added or removed elsewhere (another tab, or an admin).
  useSocketEvent(SOCKET_EVENTS.STATION_CREATED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.STATION_DELETED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.FUEL_PRICE_UPDATED, refreshLive);
  useSocketEvent(SOCKET_EVENTS.INVENTORY_UPDATED, refreshLive);
  // Events missed while disconnected are gone: refetch after a reconnect.
  useResync(refreshLive);

  const body = () => {
    if (loading) {
      return (
        <div className="flex flex-col items-center justify-center h-[60vh]">
          <i className="fas fa-spinner fa-spin text-4xl vm-accent-text mb-4" aria-hidden />
          <p className="vm-text-muted">Loading...</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-col items-center justify-center h-[60vh] text-center">
          <i className="fas fa-exclamation-triangle text-5xl text-red-400 mb-4" aria-hidden />
          <h3 className="text-xl font-bold vm-text mb-2">Error</h3>
          <p className="vm-text-muted mb-4">{error}</p>
          <button onClick={() => void loadTab(tab)} className="vm-btn vm-btn-primary">
            <i className="fas fa-redo mr-2" aria-hidden /> Retry
          </button>
        </div>
      );
    }

    switch (tab) {
      case "dashboard":
        return <DashboardTab />;
      case "stations":
        return <StationsTab />;
      case "bookings":
        return <BookingsTab />;
      case "inventory":
        return <InventoryTab />;
      case "revenue":
        return <RevenueTab />;
      case "employees":
        return <EmployeesTab />;
      case "customers":
        return <CustomersTab />;
      case "reports":
        return <ReportsTab />;
      case "profile":
        return <ProfileTab />;
      default:
        return <DashboardTab />;
    }
  };

  return <VendorShell>{body()}</VendorShell>;
}
