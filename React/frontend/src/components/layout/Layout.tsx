import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import Sidebar from "./Sidebar";
import BottomNav from "./BottomNav";
import TopHeader from "./TopHeader";
import { useNotificationStore } from "@/store/notificationStore";
import { useAuthStore } from "@/store/authStore";
import { useLiveQueueInfo } from "@/hooks/useLiveQueueInfo";
import ChatWidget from "@/components/chat/ChatWidget";
import { useChatRealtime } from "@/hooks/useChatRealtime";

interface Props {
  children: ReactNode;
  /**
   * Page title shown in the top bar, the way the admin console titles its
   * pages. When set, the top bar shows the title instead of station search.
   */
  title?: ReactNode;
  subtitle?: string;
  /** Adds the console's "Refresh" button to the top bar. */
  onRefresh?: () => void;
  /**
   * @deprecated Every customer page shares the same top bar now. Kept so
   * existing call sites still compile; it has no effect.
   */
  bare?: boolean;
}

/**
 * The customer-app shell: fixed sidebar (desktop), sticky top bar, the page,
 * and the bottom bar (mobile).
 *
 * The content column starts at the sidebar's edge and centres itself inside
 * the remaining width, so there is no dead gutter on wide screens.
 *
 * Styles: styles/customer.css (.cx-app, .cx-main, .cx-sidebar, .cx-topbar).
 */
export default function Layout({ children, title, subtitle, onRefresh }: Props) {
  const role = useAuthStore((s) => s.user?.role);
  const loadNotifications = useNotificationStore((s) => s.load);
  // Vehicles ahead / wait / start on every customer page, live.
  useLiveQueueInfo();
  // Support messages and the unread badge, live on every customer page: a reply
  // from the admin team should not wait for the customer to open the widget.
  useChatRealtime();

  // Loaded once per session for a signed-in customer; the socket keeps it
  // current after that. The endpoint is customer-only, so a vendor or admin
  // shell would just take a 403.
  useEffect(() => {
    if (role === "customer") void loadNotifications();
  }, [role, loadNotifications]);

  return (
    <div className="cx cx-app">
      <Sidebar />
      <div className="md:pl-64 min-w-0">
        <TopHeader title={title} subtitle={subtitle} onRefresh={onRefresh} />
        <main className="cx-main">
          {children}
          {/* The sidebar is hidden on phones (styles/customer.css), so the
              policy link lives here too -- on every customer page, in the app
              as well as the browser. */}
          <p className="cx-foot-legal">
            <Link to="/privacy" className="pp-link">
              Privacy Policy
            </Link>
          </p>
        </main>
      </div>
      <BottomNav />
      {/*
        The assistant, on every customer page. Fixed-position and rendered last
        so it sits above the shell without any page needing to know about it; it
        renders nothing at all for a signed-out visitor or a non-customer.
      */}
      <ChatWidget />
    </div>
  );
}
