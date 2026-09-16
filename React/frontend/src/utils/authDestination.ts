import type { Role, User } from "@/types";

/**
 * Each role signs in on its own page, and is only ever sent back to that page.
 *
 * There used to be ONE answer to "not signed in": "/login", the customer
 * sign-in. ProtectedRoute and RoleRoute sent every signed-out visitor there
 * whatever they were trying to open, so a vendor whose session had ended --
 * signed out, expired, or simply pressing Back onto /vendor after logging
 * out -- landed on the customer login instead of the vendor secret-code page.
 */
export const LOGIN_PATHS: Record<Role, string> = {
  customer: "/login",
  vendor: "/vendor/secret-code",
  admin: "/admin/login",
};

/** The sign-in page for a role (logout sends each role back to its own). */
export function loginPathForRole(role: Role | null | undefined): string {
  return LOGIN_PATHS[role ?? "customer"] ?? LOGIN_PATHS.customer;
}

/**
 * The sign-in page for a protected address, from the address alone -- the
 * signed-out visitor has no role to go by. /vendor… is vendor, /admin… admin,
 * everything else customer.
 */
export function loginPathFor(pathname: string): string {
  if (/^\/vendor(\/|$)/.test(pathname)) return LOGIN_PATHS.vendor;
  if (/^\/admin(\/|$)/.test(pathname)) return LOGIN_PATHS.admin;
  return LOGIN_PATHS.customer;
}

/**
 * Where a signed-in user belongs, decided ONLY by their role/status.
 *
 * This must be the single source of truth for "send them home" logic.
 * It used to be duplicated: Login.tsx computed it one way after a manual
 * navigate(), while AppRoutes.tsx's guest-only routes ("/login", "/register",
 * "/") independently hardcoded `<Navigate to="/dashboard">`.
 *
 * Because Zustand's `login()` sets isAuthenticated synchronously, AppRoutes
 * re-renders and evaluates its own hardcoded redirect BEFORE Login.tsx's
 * follow-up navigate() call runs -- so an admin logging in was bounced to
 * /dashboard by the /login route itself, and Login's own correct destination
 * for admins (/admin) never got the chance to apply. Sharing one function
 * removes the second guess entirely: there is nothing left to race.
 */
export function authDestination(user: User | null, fallback = "/dashboard"): string {
  if (!user) return "/login";

  if (user.role === "admin") return "/admin";

  if (user.role === "vendor") {
    if (user.vendorStatus !== "active") return "/vendor/track";
    if (user.activated === false) return "/vendor/secret-code";
    return "/vendor";
  }

  return fallback;
}
