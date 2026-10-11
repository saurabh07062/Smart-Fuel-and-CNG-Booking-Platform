import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/store/authStore";
import ConsoleAvatar from "./ConsoleAvatar";
import { pushToast } from "@/store/toastStore";
import { loginPathForRole } from "@/utils/authDestination";

export interface ConsoleTab<T extends string = string> {
  id: T;
  icon: string;
  label: string;
  /**
   * A count to show beside the label -- support conversations waiting for the
   * team, say. Absent or 0 renders nothing: a "0" badge is noise that trains
   * people to ignore the badge that matters.
   */
  badge?: number;
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
          {/* Named for the same reason as the nav: the text beside the mark is
              hidden on a collapsed rail, and what this button does -- leave
              the console for the public site -- is worth knowing before you
              press it. */}
          <button
            type="button"
            className="vm-logo"
            onClick={() => navigate("/")}
            aria-label={`${logoName}, ${logoSub} — go to the FuelMart home page`}
            title="Go to the FuelMart home page"
          >
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
                /*
                 * Named explicitly, because below the wide breakpoint the rail
                 * collapses to icons: the label span goes display:none and the
                 * icon is aria-hidden, which left every item in this nav with
                 * no accessible name at all -- a screen reader announced
                 * eleven buttons called "button". The label is also the
                 * tooltip, so a sighted user with a collapsed rail can tell
                 * the icons apart too.
                 *
                 * The badge is folded in rather than left to its own
                 * aria-label: a name on the button replaces everything inside
                 * it, so a separate one would simply go unread.
                 */
                aria-label={t.badge ? `${t.label}, ${t.badge} waiting` : t.label}
                title={t.label}
              >
                <i className={`fas ${t.icon}`} aria-hidden />
                <span>{t.label}</span>
                {Boolean(t.badge) && (
                  <span className="vm-nav-badge" aria-hidden>
                    {t.badge}
                  </span>
                )}
              </button>
            ))}
            {railExtra}
          </nav>

          <div className="vm-rail-foot">
            {/* Vendors and admins hold other people's data, so the policy is
                one click away for them too. */}
            <Link to="/privacy" className="pp-link" style={{ display: "block", padding: "6px 14px" }}>
              Privacy Policy
            </Link>
            <button
              type="button"
              className="vm-nav-item is-danger"
              onClick={handleLogout}
              /* "Logout", not "Log out": the accessible name has to contain
                 the visible text, or voice control cannot act on what the
                 user can read (WCAG 2.5.3, Label in Name). */
              aria-label="Logout"
              title="Logout"
            >
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
                {/* The avatar is the photo control: click it to set, change
                    or remove your own picture (ConsoleAvatar.tsx). */}
                <ConsoleAvatar />
              </div>
            </div>
          </header>

          <div className="vm-body">{children}</div>
        </main>
      </div>
    </div>
  );
}
