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
    return <Navigate to={authDestination(user)} replace />;
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
