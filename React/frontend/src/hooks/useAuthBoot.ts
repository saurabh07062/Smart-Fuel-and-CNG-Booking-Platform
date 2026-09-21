import { useEffect, useState } from "react";
import { useAuthStore } from "@/store/authStore";
import { getMe } from "@/services/api/authApi";
import { adoptBrowserSession } from "@/services/api/apiClient";
import type { User } from "@/types";

/**
 * Runs once at app start.
 *
 * The persisted profile (zustand/persist) can be stale -- a vendor approved
 * or suspended since the last visit, a session that ended -- so this
 * re-validates against GET /api/auth/me rather than trusting localStorage.
 * The session itself is in httpOnly cookies this page cannot read, so asking
 * the server is the only way to know. An expired access cookie is renewed
 * transparently (services/api/apiClient.ts refreshes on a 401); only a
 * session that cannot be renewed ends.
 *
 * A network failure is NOT a 401. The session is kept in that case and the
 * persisted profile is used as-is: the backend being briefly unreachable is
 * not evidence that the session is bad, and treating it as such logged people
 * out every time the API restarted (observed during Phase 5 testing).
 *
 * Returns `ready` so the router can hold the first paint until the check
 * resolves, avoiding a flash of the wrong screen (login -> dashboard).
 */
export function useAuthBoot(): { ready: boolean } {
  const [ready, setReady] = useState(false);
  const patchUser = useAuthStore((s) => s.patchUser);
  const endSession = useAuthStore((s) => s.endSession);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const login = useAuthStore((s) => s.login);

  useEffect(() => {
    let cancelled = false;

    async function verify() {
      if (!isAuthenticated) {
        // A new tab: signed in already if this browser is (another tab's
        // latest sign-in), as its own copy from now on.
        const user = await adoptBrowserSession<User>();
        if (cancelled) return;
        if (user) login(user);
        setReady(true);
        return;
      }
      const me = await getMe();
      if (cancelled) return;
      if (me.status === "ok") {
        patchUser(me.user);
      } else if (me.status === "unauthorized") {
        endSession();
      }
      // "unreachable": keep the persisted session and carry on. Individual
      // requests will show their own errors; the session is not the problem.
      setReady(true);
    }

    verify();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ready };
}
