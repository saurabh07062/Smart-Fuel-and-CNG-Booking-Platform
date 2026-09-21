import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useAuthBoot } from "@/hooks/useAuthBoot";
import { useAuthStore } from "@/store/authStore";
import { authDestination } from "@/utils/authDestination";
import ProtectedRoute from "./ProtectedRoute";
import RoleRoute from "./RoleRoute";
import Loader from "@/components/common/Loader";
import { isCustomerAppPath } from "@/utils/nativeApp";

/**
 * The website (every page), or the customer app build (VITE_APP_MODE=customer,
 * `npm run build:customer`): customer sign-in and booking only. In the customer
 * build this is the constant false, so every vendor and admin page below is
 * compiled out -- their code is not in the app at all.
 */
const WEBSITE = import.meta.env.VITE_APP_MODE !== "customer";
const NoPage: React.ComponentType = () => null;

// Pages load on demand (one chunk per page), so a customer never downloads
// the vendor or admin consoles. The landing and login pages stay in the main
// bundle: they are the first screen for most visits.
// Public
const Landing = WEBSITE ? lazy(() => import("@/pages/public/Landing")) : NoPage;
// Auth
import Login from "@/pages/auth/Login";
const Register = lazy(() => import("@/pages/auth/Register"));
const VerifyEmail = lazy(() => import("@/pages/auth/VerifyEmail"));
const ForgotPassword = lazy(() => import("@/pages/auth/ForgotPassword"));
const ResetPassword = lazy(() => import("@/pages/auth/ResetPassword"));
// Customer
const Dashboard = lazy(() => import("@/pages/customer/Dashboard"));
const Stations = lazy(() => import("@/pages/customer/Stations"));
const StationDetail = lazy(() => import("@/pages/customer/StationDetail"));
const MyVehicles = lazy(() => import("@/pages/customer/MyVehicles"));
const NearestPump = lazy(() => import("@/pages/customer/NearestPump"));
const Booking = lazy(() => import("@/pages/customer/Booking"));
const Confirmation = lazy(() => import("@/pages/customer/Confirmation"));
// Vendor
const VendorRegister = WEBSITE ? lazy(() => import("@/pages/vendor/VendorRegister")) : NoPage;
const VendorSecretCode = WEBSITE ? lazy(() => import("@/pages/vendor/VendorSecretCode")) : NoPage;
const VendorTrack = WEBSITE ? lazy(() => import("@/pages/vendor/VendorTrack")) : NoPage;
const VendorPanel = WEBSITE ? lazy(() => import("@/pages/vendor/VendorPanel")) : NoPage;
// Admin
const AdminPanel = WEBSITE ? lazy(() => import("@/pages/admin/AdminPanel")) : NoPage;
const VendorManagement = WEBSITE ? lazy(() => import("@/pages/admin/VendorManagement")) : NoPage;
const SuperAdmin = WEBSITE ? lazy(() => import("@/pages/admin/SuperAdmin")) : NoPage;

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
  if (isAuthenticated) return <Navigate to={authDestination(user)} replace />;
  // The customer app opens straight on sign-in; the landing page is for the website.
  return WEBSITE ? <Landing /> : <Navigate to="/login" replace />;
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
    <CustomerAppGate>
    <Suspense fallback={<Loader full />}>
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to={authDestination(user)} replace /> : <Login />}
      />
      {/* The admin sign-in address: the same sign-in form (the role comes from
          the server), so admin logout and an expired admin session come back
          here rather than to the customer login. */}
      {WEBSITE && (
      <Route
        path="/admin/login"
        element={isAuthenticated ? <Navigate to={authDestination(user)} replace /> : <Login />}
      />
      )}
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
      {WEBSITE && (
        <>
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
        </>
      )}

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

      {WEBSITE && (
        <>
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
        </>
      )}

      <Route path="/" element={<HomeRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
    </CustomerAppGate>
  );
}

/**
 * The customer app build (the Android app in React/mobile) is for customers
 * only: a vendor or admin who signs in is told to use the website, and any
 * other path goes to sign-in. On the website this does nothing.
 */
function CustomerAppGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const role = useAuthStore((s) => s.user?.role);
  const logout = useAuthStore((s) => s.logout);
  if (WEBSITE) return <>{children}</>;
  if (isAuthenticated && role && role !== "customer") {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div className="max-w-sm">
          <i className="fas fa-mobile-screen text-4xl mb-4" style={{ color: "var(--primary)" }} aria-hidden />
          <h1 className="text-xl font-bold mb-2">This app is for customers</h1>
          <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>
            Vendor and admin accounts are managed on the FuelMart website. Sign out to use a customer account here.
          </p>
          <button type="button" className="btn btn-primary btn-block" onClick={() => void logout()}>
            <i className="fas fa-right-from-bracket" aria-hidden /> Sign out
          </button>
        </div>
      </div>
    );
  }
  if (!isCustomerAppPath(location.pathname)) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
