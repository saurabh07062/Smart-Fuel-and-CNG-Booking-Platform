import { useMemo } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/store/authStore";
import { useBookingStore } from "@/store/bookingStore";
import { isSlotElapsed } from "@/utils/format";
import { pushToast } from "@/store/toastStore";

const MAIN = [
  { to: "/dashboard", icon: "fa-chart-simple", label: "Dashboard", end: true },
  { to: "/stations", icon: "fa-map-location-dot", label: "Find Stations", end: false },
  { to: "/booking", icon: "fa-gas-pump", label: "Book Fuel", end: false },
];

const navClass = ({ isActive }: { isActive: boolean }) => `cx-nav-item ${isActive ? "active" : ""}`;

/**
 * Desktop sidebar, in the Admin Panel's rail style: the red brand mark, a
 * tinted active item, and Logout pinned to the foot. The signed-in user is
 * shown in the top bar, as it is in the admin console.
 *
 * Counts sit beside the items where a number helps: live bookings the QR
 * pass covers, and saved vehicles.
 */
export default function Sidebar() {
  const logout = useAuthStore((s) => s.logout);
  const vehicleCount = useAuthStore((s) => s.user?.vehicles?.length ?? 0);
  const bookings = useBookingStore((s) => s.bookings);
  const navigate = useNavigate();

  const activeCount = useMemo(
    () =>
      bookings.filter(
        (b) =>
          ["upcoming", "serving", "waitlisted"].includes(b.status) &&
          !isSlotElapsed(b.bookingDate, b.timeSlot),
      ).length,
    [bookings],
  );

  const handleLogout = () => {
    logout();
    // The customer sign-in; replace so Back does not reopen the signed-out page.
    navigate("/login", { replace: true });
    pushToast("Logged out successfully", "info");
  };

  return (
    <aside className="cx-sidebar" aria-label="Main navigation">
      <button type="button" className="cx-brand" onClick={() => navigate("/dashboard")}>
        <span className="cx-brand-mark">
          <i className="fas fa-gas-pump" aria-hidden />
        </span>
        <span>
          <span className="cx-brand-name">FuelMart</span>
          <span className="cx-brand-sub">Customer Portal</span>
        </span>
      </button>

      <nav className="flex-1 overflow-y-auto">
        <div className="space-y-0.5">
          {MAIN.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
              <i className={`fas ${item.icon}`} aria-hidden />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </div>

        <p className="cx-nav-label">Account</p>
        <div className="space-y-0.5">
          <NavLink to="/confirmation" className={navClass}>
            <i className="fas fa-qrcode" aria-hidden />
            <span>My QR Pass</span>
            {activeCount > 0 && (
              <span className="cx-nav-badge" aria-label={`${activeCount} active`}>
                {activeCount}
              </span>
            )}
          </NavLink>
          <NavLink to="/my-vehicles" className={navClass}>
            <i className="fas fa-car-side" aria-hidden />
            <span>My Vehicles</span>
            {vehicleCount > 0 && <span className="cx-nav-badge is-soft">{vehicleCount}</span>}
          </NavLink>
        </div>
      </nav>

      <div className="cx-sidebar-foot">
        <button type="button" className="cx-nav-item is-danger" onClick={handleLogout}>
          <i className="fas fa-right-from-bracket" aria-hidden />
          <span>Logout</span>
        </button>
      </div>
    </aside>
  );
}
