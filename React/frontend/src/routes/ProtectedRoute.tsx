import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuthStore } from "@/store/authStore";
import { loginPathFor } from "@/utils/authDestination";

interface Props {
  children: ReactNode;
}

/**
 * Requires a signed-in session.
 *
 * The session is an httpOnly cookie this page cannot read, so the signal is
 * the profile flag -- which is not taken on trust: useAuthBoot confirms it
 * with the server (GET /api/auth/me) before the first route renders, and a
 * session that ends later (expired, signed out elsewhere) clears it through
 * the API client (store/authStore.ts endSession). A cleared session therefore
 * lands here as signed out rather than on a dashboard where every request
 * 401s.
 *
 * This is a UX gate, not a security boundary: the real check is server-side
 * on every request. Its job is to send people somewhere useful rather than to
 * an empty screen.
 */
export default function ProtectedRoute({ children }: Props) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const location = useLocation();

  if (!isAuthenticated) {
    // To the sign-in page of the area they were opening (a vendor URL goes to
    // the vendor secret-code page, never the customer login), remembering
    // where they were headed. `replace`, so Back does not return to the
    // protected address and bounce here again.
    return <Navigate to={loginPathFor(location.pathname)} replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
