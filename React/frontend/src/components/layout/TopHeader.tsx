import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import NotificationPanel from "@/components/common/NotificationPanel";
import { useAuthStore } from "@/store/authStore";
import { useUiStore } from "@/store/uiStore";
import { avatarUrl } from "@/utils/avatar";
import { pushToast } from "@/store/toastStore";
import { selectUnreadCount, useNotificationStore } from "@/store/notificationStore";

interface Props {
  /** When set, the bar shows this page title instead of station search. */
  title?: string;
  subtitle?: string;
  onRefresh?: () => void;
}

/** Close a popover on outside click or Escape, while it is open. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref, close]);
}

/**
 * The sticky top bar shared by every customer page, in the Admin Panel's
 * topbar style: page title and subtitle on the left, Refresh and the
 * signed-in user (name, role, avatar) on the right.
 *
 * Pages without a title get station search in that slot instead. On
 * /stations the search filters the list as you type (kept in ?q=); anywhere
 * else Enter takes you to the filtered list.
 */
export default function TopHeader({ title, subtitle, onRefresh }: Props) {
  const unreadCount = useNotificationStore(selectUnreadCount);
  const notificationsOpen = useNotificationStore((s) => s.panelOpen);
  const setNotificationsOpen = useNotificationStore((s) => s.setPanelOpen);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const darkMode = useUiStore((s) => s.darkMode);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const menuOpen = useUiStore((s) => s.profileMenuOpen);
  const setMenuOpen = useUiStore((s) => s.setProfileMenuOpen);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params, setParams] = useSearchParams();

  const onStations = pathname === "/stations";
  const [query, setQuery] = useState(onStations ? params.get("q") ?? "" : "");

  // Follow the URL (back/forward, the chip's clear button) on the stations page.
  useEffect(() => {
    if (onStations) setQuery(params.get("q") ?? "");
  }, [onStations, params]);

  const menuRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);
  useDismiss(menuOpen, menuRef, () => setMenuOpen(false));
  useDismiss(notificationsOpen, bellRef, () => setNotificationsOpen(false));

  const photo = avatarUrl(user);

  const onQueryChange = (value: string) => {
    setQuery(value);
    if (onStations) setParams(value.trim() ? { q: value } : {}, { replace: true });
  };

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    navigate(q ? `/stations?q=${encodeURIComponent(q)}` : "/stations");
  };

  const handleLogout = () => {
    setMenuOpen(false);
    logout();
    // The customer sign-in; replace so Back does not reopen the signed-out page.
    navigate("/login", { replace: true });
    pushToast("Logged out successfully", "info");
  };

  const menuRow = (icon: string, label: string, sub: string, onClick?: () => void) => (
    <button
      type="button"
      className="w-full text-left px-3 py-2.5 flex items-center gap-3 rounded-lg transition-colors hover-row"
      style={{ color: "var(--text)" }}
      onClick={onClick}
      role="menuitem"
    >
      <span className="icon-btn" style={{ width: 34, height: 34, pointerEvents: "none" }}>
        <i className={`fas ${icon} text-[13px]`} aria-hidden />
      </span>
      <div>
        <p className="text-[13px] font-semibold">{label}</p>
        <p className="text-[11px]" style={{ color: "var(--muted)" }}>
          {sub}
        </p>
      </div>
    </button>
  );

  return (
    <header className="cx-topbar">
      <div className="cx-topbar-inner">
        <button
          type="button"
          className="cx-brand-mark md:hidden"
          style={{ width: 34, height: 34, fontSize: 14 }}
          onClick={() => navigate("/dashboard")}
          aria-label="FuelMart home"
        >
          <i className="fas fa-gas-pump" aria-hidden />
        </button>

        {title ? (
          <div className="min-w-0 flex-1">
            <h1 className="cx-top-title">{title}</h1>
            {subtitle && <p className="cx-top-sub hidden sm:block">{subtitle}</p>}
          </div>
        ) : (
          <form className="cx-search" role="search" onSubmit={submitSearch}>
            <i className="fas fa-magnifying-glass" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search stations by name or area"
              aria-label="Search stations"
            />
          </form>
        )}

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {onRefresh && (
            <button type="button" className="btn btn-outline hidden sm:inline-flex" onClick={onRefresh}>
              <i className="fas fa-rotate" aria-hidden /> Refresh
            </button>
          )}
          {!title && (
            <button
              type="button"
              className="btn btn-primary btn-sm hidden lg:inline-flex"
              onClick={() => navigate("/booking")}
            >
              <i className="fas fa-calendar-plus" aria-hidden /> Book Fuel
            </button>
          )}

          <div className="relative" ref={bellRef}>
            <button
              type="button"
              className="cx-icon-btn"
              title="Notifications"
              aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
              aria-expanded={notificationsOpen}
              onClick={() => setNotificationsOpen(!notificationsOpen)}
            >
              <i className="far fa-bell" aria-hidden />
              {unreadCount > 0 && <span className="cx-dot-badge" />}
            </button>
            {notificationsOpen && (
              <div className="cx-popover">
                <NotificationPanel />
              </div>
            )}
          </div>

          <button
            type="button"
            className="cx-icon-btn hidden sm:inline-flex"
            onClick={toggleTheme}
            title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
            aria-label="Toggle theme"
          >
            <i className={`fas fa-${darkMode ? "sun" : "moon"}`} aria-hidden />
          </button>

          <div className="relative" ref={menuRef}>
            <button
              type="button"
              className="cx-userbtn"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="Account menu"
            >
              <span className="hidden md:block">
                <span className="cx-user-name">{user?.name?.split(" ")[0] ?? "Guest"}</span>
                <span className="cx-user-role">{user ? "Customer" : "Guest session"}</span>
              </span>
              <img src={photo} alt="" />
            </button>

            {menuOpen && (
              <div
                className="absolute right-0 w-72 overflow-hidden z-50"
                role="menu"
                style={{
                  top: "calc(100% + 12px)",
                  background: "var(--card)",
                  borderRadius: "var(--radius-lg)",
                  boxShadow: "var(--shadow-xl)",
                  border: "1px solid var(--border)",
                  animation: "fadeIn 0.15s ease",
                }}
              >
                <div
                  className="p-4 flex items-center gap-3"
                  style={{ background: "linear-gradient(135deg,#cb202d,#e23744)" }}
                >
                  <img
                    src={photo}
                    alt=""
                    className="w-12 h-12 rounded-full object-cover"
                    style={{ border: "2px solid rgba(255,255,255,0.4)" }}
                  />
                  <div className="min-w-0">
                    <p className="font-semibold text-[15px] leading-tight text-white truncate">
                      {user ? user.name : "Guest"}
                    </p>
                    <p className="text-xs text-white/75 truncate mt-0.5">{user?.email ?? ""}</p>
                  </div>
                </div>

                <div className="p-2 space-y-0.5">
                  {menuRow("fa-user", "My Profile", "Account settings and more")}
                  {menuRow("fa-car-side", "My Vehicles", "Manage saved vehicles", () => {
                    setMenuOpen(false);
                    navigate("/my-vehicles");
                  })}
                  {menuRow("fa-lock", "Change Password", "Update your password")}
                  <div className="sm:hidden">
                    {menuRow(
                      darkMode ? "fa-sun" : "fa-moon",
                      darkMode ? "Light mode" : "Dark mode",
                      "Switch the app theme",
                      toggleTheme,
                    )}
                  </div>
                  <div className="px-1 pt-1.5 pb-0.5">
                    <button type="button" className="btn btn-primary btn-sm w-full" onClick={handleLogout}>
                      <i className="fas fa-arrow-right-from-bracket" aria-hidden /> Log Out
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
