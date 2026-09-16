import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "@/store/authStore";
import { avatarUrl } from "@/utils/avatar";
import { pushToast } from "@/store/toastStore";
import { loginPathForRole } from "@/utils/authDestination";

export interface ConsoleTab<T extends string = string> {
  id: T;
  icon: string;
  label: string;
}

interface Props<T extends string> {
  /** Rail brand block. */
  logoIcon: string;
  logoName: string;
  logoSub: string;

  tabs: ConsoleTab<T>[];
  activeTab: T;
  onTabChange: (tab: T) => void;

  /** Topbar heading and the line under it. */
  title: string;
  subtitle: string;

  onRefresh: () => void;
  /** Extra rail items below the tabs (e.g. Admin's "Vendor Management" link). */
  railExtra?: ReactNode;
  /** Replaces the default user block when a page shows something else. */
  userRole?: string;
  /** Runs before the session is cleared, so a page can reset its own store. */
  onBeforeLogout?: () => void;

  children: ReactNode;
}

/**
 * The operator console chrome shared by all four console pages.
 *
 * In the Vanilla app this markup is copy-pasted into renderVendorPanel(),
 * renderAdminDashboard(), renderVendorManagementPage() and renderSuperAdmin()
 * -- four near-identical copies of the same rail, topbar and body, which is
 * why a change to one of them (the mobile-header removal, the theme fix)
 * had to be made four times.
 *
 * Every class name is the existing console.css one, unchanged: the rail still
 * collapses to a 68px icon strip under 900px, so there is no separate mobile
 * markup path here either.
 */
export default function ConsoleShell<T extends string>({
  logoIcon,
  logoName,
  logoSub,
  tabs,
  activeTab,
  onTabChange,
  title,
  subtitle,
  onRefresh,
  railExtra,
  userRole = "Admin",
  onBeforeLogout,
  children,
}: Props<T>) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const handleLogout = () => {
    // Read before the session is cleared: a vendor goes back to the vendor
    // sign-in, an admin to the admin sign-in. `replace`, so Back does not
    // reopen the console page they just signed out of.
    const loginPath = loginPathForRole(user?.role);
    onBeforeLogout?.();
    logout();
    navigate(loginPath, { replace: true });
    pushToast("Logged out successfully", "info");
  };

  return (
    <div className="vm">
      <div className="vm-shell">
        <aside className="vm-rail">
          <button type="button" className="vm-logo" onClick={() => navigate("/")}>
            <span className="vm-logo-mark">
              <i className={`fas ${logoIcon}`} aria-hidden />
            </span>
            <span className="vm-logo-text">
              <span className="vm-logo-name">{logoName}</span>
              <span className="vm-logo-sub">{logoSub}</span>
            </span>
          </button>

          <nav className="vm-nav">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`vm-nav-item ${activeTab === t.id ? "is-active" : ""}`}
                onClick={() => onTabChange(t.id)}
                aria-current={activeTab === t.id ? "page" : undefined}
              >
                <i className={`fas ${t.icon}`} aria-hidden />
                <span>{t.label}</span>
              </button>
            ))}
            {railExtra}
          </nav>

          <div className="vm-rail-foot">
            <button type="button" className="vm-nav-item is-danger" onClick={handleLogout}>
              <i className="fas fa-right-from-bracket" aria-hidden />
              <span>Logout</span>
            </button>
          </div>
        </aside>

        <main className="vm-main">
          <header className="vm-topbar">
            <div>
              <h1 className="vm-title">{title}</h1>
              <p className="vm-subtitle">{subtitle}</p>
            </div>
            <div className="vm-topbar-right">
              {/* The Vanilla button called render(), which only redrew from
                  state the app already held. Refetching is what "Refresh"
                  actually promises. */}
              <button type="button" className="vm-btn vm-btn-ghost" onClick={onRefresh}>
                <i className="fas fa-rotate" aria-hidden /> Refresh
              </button>
              <div className="vm-user">
                <div>
                  <div className="vm-user-name">{user?.name ?? "Administrator"}</div>
                  <div className="vm-user-role">{userRole}</div>
                </div>
                <img src={avatarUrl(user)} alt="" className="vm-avatar" />
              </div>
            </div>
          </header>

          <div className="vm-body">{children}</div>
        </main>
      </div>
    </div>
  );
}
