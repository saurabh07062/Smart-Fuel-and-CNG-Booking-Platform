import { useEffect } from "react";
import { useAuthStore } from "@/store/authStore";
import { refreshSession } from "@/services/api/apiClient";

/**
 * Renew the session before the access cookie runs out.
 *
 * HTTP requests would survive without this -- an expired access cookie is
 * refreshed on the 401 (services/api/apiClient.ts). A Socket.IO reconnect
 * would not: its handshake simply arrives without a valid cookie and the
 * socket comes back anonymous, silently missing the user's own booking and
 * notification events. Renewing a little before the backend's 15-minute
 * access lifetime (ACCESS_TOKEN_TTL) keeps the cookie valid for it.
 *
 * Only while signed in and while the tab is visible; returning to a tab that
 * has been hidden longer than the interval renews at once.
 */
const RENEW_EVERY_MS = 10 * 60_000;

export function useSessionKeepAlive() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  useEffect(() => {
    if (!isAuthenticated) return;
    let last = Date.now();
    const renew = () => {
      last = Date.now();
      void refreshSession();
    };

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") renew();
    }, RENEW_EVERY_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible" && Date.now() - last >= RENEW_EVERY_MS) renew();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isAuthenticated]);
}
