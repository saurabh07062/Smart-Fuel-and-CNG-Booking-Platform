import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuthStore } from "@/store/authStore";
import { authDestination, loginPathFor } from "@/utils/authDestination";
import type { Role } from "@/types";

interface Props {
  allow: Role[];
  children: ReactNode;
  /** Vendor pages additionally require an approved AND activated account. */
  requireActivatedVendor?: boolean;
}

/**
 * Restricts a route to particular roles.
 *
 * The role is read from the user object the SERVER returned at login. It is
 * never inferred from a localStorage flag -- which is precisely how the
 * Vanilla app could be talked into a privileged view:
 *
 *     localStorage.setItem("fm-superadmin", "true")
 *
 * was, on its own, enough to set state.isSuperAdmin and open the admin-only
 * pages. There was no server call and no token involved. That path is not
 * reproduced here.
 *
 * An admin passes every gate, matching the backend: middleware/requireRole.js
 * and middleware/vendor.js both grant admins an override so they can open a
 * vendor's panel to support someone who is stuck.
 */
export default function RoleRoute({ allow, children, requireActivatedVendor }: Props) {
  const user = useAuthStore((s) => s.user);
  const { pathname } = useLocation();

  if (!user) return <Navigate to={loginPathFor(pathname)} replace />;

  // Admin override, mirroring the backend.
  if (user.role === "admin") return <>{children}</>;

  if (!allow.includes(user.role)) {
    // Another role's page: send them to their own home, never to a sign-in
    // page (they are signed in) and never into that role's area.
    const home = authDestination(user);
    /**
     * Unless home IS this page.
     *
     * Then redirecting would hand the same route back to this same gate, which
     * would redirect again -- a loop that renders nothing at all. A white
     * screen is the worst possible way to report a problem, and in the Android
     * app it is the only thing the person sees.
     *
     * It happened for real: registration returned a user with no `role`
     * (backend controllers/authController.js), so `allow.includes(undefined)`
     * was false while authDestination sent customers to /dashboard -- the very
     * address being guarded. The response is fixed; this makes the gate
     * incapable of producing a blank screen whatever the server sends, because
     * a page that renders is something a person can act on.
     */
    if (home !== pathname) return <Navigate to={home} replace />;
    return <>{children}</>;
  }

  /**
   * A vendor who is approved but has not redeemed their secret code has no
   * dashboard yet -- the same two conditions middleware/vendor.js enforces on
   * the API. Sending them to their tracking page tells them what to do next;
   * the dashboard would just 403 on every request.
   */
  if (import.meta.env.VITE_APP_MODE !== "customer" && requireActivatedVendor && user.role === "vendor") {
    if (user.vendorStatus !== "active") return <Navigate to="/vendor/track" replace />;
    if (user.activated === false) return <Navigate to="/vendor/secret-code" replace />;
  }

  return <>{children}</>;
}
