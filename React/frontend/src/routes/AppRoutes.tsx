import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useAuthBoot } from "@/hooks/useAuthBoot";
import { useAuthStore } from "@/store/authStore";
import { authDestination } from "@/utils/authDestination";
import ProtectedRoute from "./ProtectedRoute";
import RoleRoute from "./RoleRoute";
import Loader from "@/components/common/Loader";

// Public
import Landing from "@/pages/public/Landing";
// Auth
import Login from "@/pages/auth/Login";
import Register from "@/pages/auth/Register";
import VerifyEmail from "@/pages/auth/VerifyEmail";
import ForgotPassword from "@/pages/auth/ForgotPassword";
import ResetPassword from "@/pages/auth/ResetPassword";
// Customer
import Dashboard from "@/pages/customer/Dashboard";
import Stations from "@/pages/customer/Stations";
import StationDetail from "@/pages/customer/StationDetail";
import MyVehicles from "@/pages/customer/MyVehicles";
import NearestPump from "@/pages/customer/NearestPump";
import Booking from "@/pages/customer/Booking";
import Confirmation from "@/pages/customer/Confirmation";
// Vendor
import VendorRegister from "@/pages/vendor/VendorRegister";
import VendorSecretCode from "@/pages/vendor/VendorSecretCode";
import VendorTrack from "@/pages/vendor/VendorTrack";
import VendorPanel from "@/pages/vendor/VendorPanel";
// Admin
import AdminPanel from "@/pages/admin/AdminPanel";
import VendorManagement from "@/pages/admin/VendorManagement";
import SuperAdmin from "@/pages/admin/SuperAdmin";

/**
 * "/" as the Vanilla app treated it: the email-verification link
 * (`/?verify=<token>`, emailService.js) wins over everything; a guest gets the
 * landing page; a signed-in user goes to their role's home.
 */
function HomeRoute() {
  const { search } = useLocation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const verify = new URLSearchParams(search).get("verify");
  if (verify) return <VerifyEmail token={verify} />;
  return isAuthenticated ? <Navigate to={authDestination(user)} replace /> : <Landing />;
}

/**
 * Application route table.
 *
 * Real paths (BrowserRouter), not the Vanilla app's #hash routing -- see
 * main.tsx for why. /vendor/secret-code in particular matches the real path
 * the approval email already links to (backend/src/services/notification/emailService.js),
 * so that link keeps working without a redirect shim.
 *
 * Public: /, /login, /register, /forgot-password, /reset-password,
 * /vendor-register, /vendor/secret-code, /vendor/track. Everything else sits behind ProtectedRoute, and role-specific
 * screens additionally behind RoleRoute.
 *
 * Every guest-only route below defers to authDestination(user) rather than
 * hardcoding "/dashboard" -- see src/utils/authDestination.ts for the race
 * condition that caused (an admin logging in landed on the customer
 * dashboard because this route table's own redirect fired before Login.tsx's
 * role-aware navigate() call did).
 */
export default function AppRoutes() {
  const { ready } = useAuthBoot();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);

  if (!ready) {
    return <Loader full label="Loading FuelMart…" />;
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to={authDestination(user)} replace /> : <Login />}
      />
      {/* The admin sign-in address: the same sign-in form (the role comes from
          the server), so admin logout and an expired admin session come back
          here rather than to the customer login. */}
      <Route
        path="/admin/login"
        element={isAuthenticated ? <Navigate to={authDestination(user)} replace /> : <Login />}
      />
      <Route
        path="/register"
        element={isAuthenticated ? <Navigate to={authDestination(user)} replace /> : <Register />}
      />
      <Route
        path="/forgot-password"
        element={isAuthenticated ? <Navigate to={authDestination(user)} replace /> : <ForgotPassword />}
      />
      {/* Public even when signed in: the link arrives by email, and a reset
          signs every device out anyway (ResetPassword.tsx). */}
      <Route path="/reset-password" element={<ResetPassword />} />

      {/* The vendor sign-in page: an approved vendor reaches it signed out,
          from their email. Guest-only like /login -- a signed-in user pressing
          Back onto it goes to their own home instead of a sign-in form. The
          one exception is a vendor who still has to redeem a code:
          authDestination sends them HERE, so redirecting would loop. */}
      <Route
        path="/vendor/secret-code"
        element={
          isAuthenticated && !(user?.role === "vendor" && user.activated === false) ? (
            <Navigate to={authDestination(user)} replace />
          ) : (
            <VendorSecretCode />
          )
        }
      />
      {/* Public: vendor onboarding (Vanilla #vendor-register). */}
      <Route path="/vendor-register" element={<VendorRegister />} />

      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <RoleRoute allow={["customer"]}>
              <Dashboard />
            </RoleRoute>
          </ProtectedRoute>
        }
      />

      {/* Customer module (Phase 5). /stations/:id is a real address rather
          than a view of state.selectedStation, so a reload or a shared link
          shows the station that was actually chosen. */}
      <Route
        path="/stations"
        element={
          <ProtectedRoute>
            <RoleRoute allow={["customer"]}>
              <Stations />
            </RoleRoute>
          </ProtectedRoute>
        }
      />
      <Route
        path="/stations/:id"
        element={
          <ProtectedRoute>
            <RoleRoute allow={["customer"]}>
              <StationDetail />
            </RoleRoute>
          </ProtectedRoute>
        }
      />
      {/* Phase 7. /booking carries its selection in query parameters, so a
          station card, the predicted-pump result and "Book with This" all
          link to a real address instead of pushing router state. */}
      <Route
        path="/booking"
        element={
          <ProtectedRoute>
            <RoleRoute allow={["customer"]}>
              <Booking />
            </RoleRoute>
          </ProtectedRoute>
        }
      />
      {/* Bare /confirmation is the sidebar's "My QR Pass" -- whichever pass is
          current. /confirmation/:id always shows that one booking. */}
      <Route
        path="/confirmation"
        element={
          <ProtectedRoute>
            <RoleRoute allow={["customer"]}>
              <Confirmation />
            </RoleRoute>
          </ProtectedRoute>
        }
      />
      <Route
        path="/confirmation/:id"
        element={
          <ProtectedRoute>
            <RoleRoute allow={["customer"]}>
              <Confirmation />
            </RoleRoute>
          </ProtectedRoute>
        }
      />

      {/* Phase 6. A real address, recoverable from localStorage, so a refresh
          or a bookmark shows the last search instead of an empty page. */}
      <Route
        path="/nearest-pump"
        element={
          <ProtectedRoute>
            <RoleRoute allow={["customer"]}>
              <NearestPump />
            </RoleRoute>
          </ProtectedRoute>
        }
      />
      <Route
        path="/my-vehicles"
        element={
          <ProtectedRoute>
            <RoleRoute allow={["customer"]}>
              <MyVehicles />
            </RoleRoute>
          </ProtectedRoute>
        }
      />

      <Route
        path="/vendor"
        element={
          <ProtectedRoute>
            <RoleRoute allow={["vendor"]} requireActivatedVendor>
              <VendorPanel />
            </RoleRoute>
          </ProtectedRoute>
        }
      />
      {/* Public, as in Vanilla (its route guard protects only vendor-panel):
          a vendor who has just applied is not signed in, and
          GET /api/activation/vendors/:id/status needs no token. */}
      <Route path="/vendor/track" element={<VendorTrack />} />

      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <RoleRoute allow={["admin"]}>
              <AdminPanel />
            </RoleRoute>
          </ProtectedRoute>
        }
      />

      {/* Phase 10. Vendor Management and Super Admin are separate consoles in
          the Vanilla app (their own pages, their own rails), so they get their
          own addresses rather than becoming tabs of /admin. */}
      <Route
        path="/admin/vendors"
        element={
          <ProtectedRoute>
            <RoleRoute allow={["admin"]}>
              <VendorManagement />
            </RoleRoute>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/global"
        element={
          <ProtectedRoute>
            <RoleRoute allow={["admin"]}>
              <SuperAdmin />
            </RoleRoute>
          </ProtectedRoute>
        }
      />

      <Route path="/" element={<HomeRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
