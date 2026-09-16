import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";

/**
 * Sign-in, sign-out, session expiry and Back/Forward through the REAL route
 * table (AppRoutes, ProtectedRoute, RoleRoute), the real auth store, the real
 * Login and VendorSecretCode pages and the real logout buttons (ConsoleShell,
 * Sidebar). Only the API calls, the socket and the heavy page bodies are
 * stand-ins. Every test records each address the router visited, so "never
 * reached the customer login" is checked on the whole trip, not just the end.
 */

vi.mock("@/services/api/authApi", () => ({
  getMe: vi.fn(),
  login: vi.fn(),
  logoutRequest: vi.fn(async () => {}),
  register: vi.fn(),
  resendVerification: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
}));
vi.mock("@/services/api/vendorApi", () => ({ redeemVendorSecretCode: vi.fn() }));
vi.mock("@/services/socket/socket", () => ({ disconnectSocket: vi.fn(), getSocket: vi.fn() }));

// vi.mock factories are hoisted above every import and top-level variable,
// so the page stand-ins are built inside vi.hoisted with dynamic imports.
const { stub, customerDashboard, consolePage } = vi.hoisted(() => {
  const stub = (label: string) => async () => {
    const { createElement } = await import("react");
    return { default: () => createElement("h1", null, label) };
  };

  // The customer dashboard with the real customer Sidebar (its Logout button).
  const customerDashboard = async () => {
    const { createElement, Fragment } = await import("react");
    const { default: Sidebar } = await import("@/components/layout/Sidebar");
    return {
      default: () => createElement(Fragment, null, createElement(Sidebar), createElement("h1", null, "Customer dashboard")),
    };
  };

  // A console page with the real ConsoleShell (its Logout button).
  const consolePage = (heading: string, userRole: string, withVendorMgmtLink = false) => async () => {
    const { createElement } = await import("react");
    const { useNavigate: useNav } = await import("react-router-dom");
    const { default: ConsoleShell } = await import("@/components/console/ConsoleShell");
    function Page() {
      const navigate = useNav();
      return createElement(
        ConsoleShell,
        {
          logoIcon: "fa-store",
          logoName: heading,
          logoSub: "",
          tabs: [],
          activeTab: "dashboard",
          onTabChange: () => {},
          title: `${heading} console`, // the shell's own heading, distinct from the page body's
          subtitle: "",
          onRefresh: () => {},
          userRole,
          railExtra: withVendorMgmtLink
            ? createElement("button", { type: "button", onClick: () => navigate("/admin/vendors") }, "Vendor Management")
            : undefined,
          children: createElement("h1", null, heading),
        },
      );
    }
    return { default: Page };
  };

  return { stub, customerDashboard, consolePage };
});

vi.mock("@/pages/public/Landing", stub("Landing page"));
vi.mock("@/pages/auth/Register", stub("Register page"));
vi.mock("@/pages/auth/VerifyEmail", stub("Verify page"));
vi.mock("@/pages/auth/ForgotPassword", stub("Forgot page"));
vi.mock("@/pages/auth/ResetPassword", stub("Reset page"));
vi.mock("@/pages/customer/Stations", stub("Stations page"));
vi.mock("@/pages/customer/StationDetail", stub("Station detail page"));
vi.mock("@/pages/customer/MyVehicles", stub("Vehicles page"));
vi.mock("@/pages/customer/NearestPump", stub("Nearest pump page"));
vi.mock("@/pages/customer/Booking", stub("Booking page"));
vi.mock("@/pages/customer/Confirmation", stub("Confirmation page"));
vi.mock("@/pages/vendor/VendorRegister", stub("Vendor register page"));
vi.mock("@/pages/vendor/VendorTrack", stub("Vendor track page"));
vi.mock("@/pages/admin/SuperAdmin", stub("Super admin page"));
vi.mock("@/pages/customer/Dashboard", customerDashboard);
vi.mock("@/pages/vendor/VendorPanel", consolePage("Vendor dashboard", "Vendor"));
vi.mock("@/pages/admin/AdminPanel", consolePage("Admin dashboard", "Admin", true));
vi.mock("@/pages/admin/VendorManagement", consolePage("Vendor management", "Admin"));

import * as authApi from "@/services/api/authApi";
import * as vendorApi from "@/services/api/vendorApi";
import { useAuthStore } from "@/store/authStore";
import type { User } from "@/types";
import AppRoutes from "./AppRoutes";

const getMe = vi.mocked(authApi.getMe);
const loginRequest = vi.mocked(authApi.login);
const redeem = vi.mocked(vendorApi.redeemVendorSecretCode);

const VENDOR: User = { id: "v1", name: "Pump Owner", email: "owner@example.com", role: "vendor", vendorStatus: "active", activated: true };
const CUSTOMER: User = { id: "c1", name: "Asha Customer", email: "asha@example.com", role: "customer", vehicles: [] };
const ADMIN: User = { id: "a1", name: "Site Admin", email: "admin@example.com", role: "admin" };

let visited: string[] = [];

/** Records every address, and gives the test browser Back / Forward buttons. */
function HistoryProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  if (visited[visited.length - 1] !== location.pathname) visited.push(location.pathname);
  return (
    <>
      <div data-testid="location">{location.pathname}</div>
      <button type="button" onClick={() => navigate(-1)}>
        Browser Back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        Browser Forward
      </button>
    </>
  );
}

function signIn(user: User | null) {
  useAuthStore.setState({ user, isAuthenticated: Boolean(user) });
}

/** Mount the app with a browser history (the last entry is the open page). */
function openApp(history: string[]) {
  return render(
    <MemoryRouter initialEntries={history} initialIndex={history.length - 1}>
      <AppRoutes />
      <HistoryProbe />
    </MemoryRouter>,
  );
}

const at = () => screen.getByTestId("location").textContent;
const expectAt = (path: string) => waitFor(() => expect(at()).toBe(path));
const back = () => fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
const forward = () => fireEvent.click(screen.getByRole("button", { name: "Browser Forward" }));
const logoutButton = () => screen.getByRole("button", { name: /^logout$/i });

async function submitCustomerLogin(email: string) {
  const form = (await screen.findByRole("button", { name: "Sign In" })).closest("form")!;
  fireEvent.change(form.querySelector('input[type="email"]')!, { target: { value: email } });
  fireEvent.change(form.querySelector('input[type="password"]')!, { target: { value: "not-a-real-password" } });
  fireEvent.submit(form);
}

beforeEach(() => {
  vi.clearAllMocks();
  visited = [];
  signIn(null);
  getMe.mockImplementation(async () => {
    const user = useAuthStore.getState().user;
    return user ? { status: "ok", user } : { status: "unauthorized" };
  });
});

describe("Vendor", () => {
  it("1. Vendor login → Vendor dashboard → Back leaves the sign-in form behind", async () => {
    redeem.mockResolvedValue({ msg: "Secret code verified.", user: VENDOR });
    openApp(["/vendor/track", "/vendor/secret-code"]);

    fireEvent.change(await screen.findByLabelText("Registered Email"), { target: { value: VENDOR.email } });
    fireEvent.change(screen.getByLabelText("Secret Code"), { target: { value: "ABCD-EFGH-JKLM" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock Vendor Panel" }));
    await screen.findByRole("heading", { name: "Vendor dashboard" });
    expect(at()).toBe("/vendor");

    back();
    await expectAt("/vendor/track"); // the page before signing in, not a sign-in form
    forward();
    await screen.findByRole("heading", { name: "Vendor dashboard" });
    expect(visited).not.toContain("/login");
  });

  it("a signed-in vendor pressing Back onto the secret-code page is sent to the dashboard", async () => {
    signIn(VENDOR);
    openApp(["/vendor/secret-code"]);
    await screen.findByRole("heading", { name: "Vendor dashboard" });
    expect(at()).toBe("/vendor");
    expect(visited).not.toContain("/login");
  });

  it("a vendor who still has to redeem a code can open the secret-code page (no redirect loop)", async () => {
    signIn({ ...VENDOR, activated: false });
    openApp(["/vendor"]);
    await screen.findByLabelText("Secret Code");
    expect(at()).toBe("/vendor/secret-code");
  });

  it("3. Vendor refresh keeps the dashboard, and navigation still works", async () => {
    signIn(VENDOR);
    const first = openApp(["/vendor/track", "/vendor"]);
    await screen.findByRole("heading", { name: "Vendor dashboard" });
    first.unmount(); // refresh: the app starts again from the persisted profile

    openApp(["/vendor/track", "/vendor"]);
    await screen.findByRole("heading", { name: "Vendor dashboard" });
    expect(getMe).toHaveBeenCalled();
    back();
    await expectAt("/vendor/track");
    forward();
    await expectAt("/vendor");
    expect(visited).not.toContain("/login");
  });

  it("3b. Refresh after the vendor session died server-side goes to the vendor sign-in", async () => {
    signIn(VENDOR);
    getMe.mockResolvedValue({ status: "unauthorized" });
    openApp(["/vendor"]);
    await screen.findByLabelText("Secret Code");
    expect(at()).toBe("/vendor/secret-code");
    expect(visited).not.toContain("/login");
  });

  it("4. Vendor logout → vendor sign-in; Back does not reopen the dashboard or the customer login", async () => {
    signIn(VENDOR);
    openApp(["/vendor/track", "/vendor"]);
    await screen.findByRole("heading", { name: "Vendor dashboard" });

    fireEvent.click(logoutButton());
    await expectAt("/vendor/secret-code");
    expect(useAuthStore.getState().isAuthenticated).toBe(false);

    back();
    await expectAt("/vendor/track");
    forward();
    await expectAt("/vendor/secret-code");
    expect(visited).not.toContain("/login");
    expect(screen.queryByRole("heading", { name: "Vendor dashboard" })).toBeNull();
  });

  it("4b. After vendor logout, an older /vendor entry in history goes to the vendor sign-in", async () => {
    signIn(VENDOR);
    openApp(["/vendor", "/vendor/track"]);
    await expectAt("/vendor/track");
    signIn(null); // signed out (e.g. in another tab)
    back();
    await expectAt("/vendor/secret-code");
    expect(visited).not.toContain("/login");
  });

  it("8. An expired vendor session sends the vendor to the vendor sign-in", async () => {
    signIn(VENDOR);
    openApp(["/vendor"]);
    await screen.findByRole("heading", { name: "Vendor dashboard" });

    // What apiClient does when a 401 cannot be refreshed.
    act(() => useAuthStore.getState().endSession());
    await expectAt("/vendor/secret-code");
    expect(visited).not.toContain("/login");
  });

  it("9. Opening a protected vendor URL signed out goes to the vendor sign-in", async () => {
    openApp(["/vendor"]);
    await screen.findByLabelText("Secret Code");
    expect(at()).toBe("/vendor/secret-code");
    expect(visited).not.toContain("/login");
  });
});

describe("Customer", () => {
  it("5. Customer login → dashboard → Back does not show the login form again", async () => {
    loginRequest.mockResolvedValue({ ok: true, data: { user: CUSTOMER } } as never);
    openApp(["/", "/login"]);
    await submitCustomerLogin(CUSTOMER.email);
    await screen.findByRole("heading", { name: "Customer dashboard" });

    back(); // "/" for a signed-in customer is their dashboard
    await screen.findByRole("heading", { name: "Customer dashboard" });
    expect(at()).toBe("/dashboard");
  });

  it("6. Customer logout → customer login; Back does not reopen the dashboard", async () => {
    signIn(CUSTOMER);
    openApp(["/", "/dashboard"]);
    await screen.findByRole("heading", { name: "Customer dashboard" });

    fireEvent.click(logoutButton());
    await expectAt("/login");
    back();
    await screen.findByRole("heading", { name: "Landing page" });
    expect(screen.queryByRole("heading", { name: "Customer dashboard" })).toBeNull();
  });

  it("an expired customer session and a signed-out /dashboard go to the customer login", async () => {
    signIn(CUSTOMER);
    const view = openApp(["/dashboard"]);
    await screen.findByRole("heading", { name: "Customer dashboard" });
    act(() => useAuthStore.getState().endSession());
    await expectAt("/login");
    view.unmount();

    openApp(["/stations"]);
    await expectAt("/login");
  });
});

describe("Admin", () => {
  it("7. Admin login → admin dashboard → Back", async () => {
    loginRequest.mockResolvedValue({ ok: true, data: { user: ADMIN } } as never);
    openApp(["/", "/admin/login"]);
    await submitCustomerLogin(ADMIN.email);
    await screen.findByRole("heading", { name: "Admin dashboard" });

    back();
    await screen.findByRole("heading", { name: "Admin dashboard" });
    expect(at()).toBe("/admin");
    expect(visited).not.toContain("/login");
  });

  it("2. Admin dashboard → Vendor Management → Back returns to the dashboard", async () => {
    signIn(ADMIN);
    openApp(["/admin"]);
    fireEvent.click(await screen.findByRole("button", { name: "Vendor Management" }));
    await screen.findByRole("heading", { name: "Vendor management" });
    expect(at()).toBe("/admin/vendors");

    back();
    await screen.findByRole("heading", { name: "Admin dashboard" });
    forward();
    await screen.findByRole("heading", { name: "Vendor management" });
  });

  it("admin logout, admin expiry and signed-out admin URLs go to the admin sign-in", async () => {
    signIn(ADMIN);
    const view = openApp(["/admin"]);
    await screen.findByRole("heading", { name: "Admin dashboard" });
    fireEvent.click(logoutButton());
    await expectAt("/admin/login");
    view.unmount();

    signIn(ADMIN);
    const expired = openApp(["/admin/vendors"]);
    await screen.findByRole("heading", { name: "Vendor management" });
    act(() => useAuthStore.getState().endSession());
    await expectAt("/admin/login");
    expired.unmount();

    openApp(["/admin/global"]);
    await expectAt("/admin/login");
    expect(visited).not.toContain("/login");
  });
});

describe("10. Roles stay in their own area", () => {
  it("a signed-in customer opening vendor or admin URLs goes to their own dashboard", async () => {
    signIn(CUSTOMER);
    const view = openApp(["/vendor"]);
    await expectAt("/dashboard");
    view.unmount();
    openApp(["/admin/vendors"]);
    await expectAt("/dashboard");
    expect(visited).not.toContain("/vendor/secret-code");
  });

  it("a signed-in vendor opening customer pages or the customer login goes to the vendor dashboard", async () => {
    signIn(VENDOR);
    for (const path of ["/login", "/dashboard", "/booking", "/admin"]) {
      const view = openApp([path]);
      await expectAt("/vendor");
      await screen.findByRole("heading", { name: "Vendor dashboard" });
      view.unmount();
    }
  });

  it("signed out, the customer login and the vendor sign-in are separate pages", async () => {
    openApp(["/login", "/vendor/secret-code"]);
    await screen.findByLabelText("Secret Code");
    back();
    await screen.findByRole("button", { name: "Sign In" });
    expect(at()).toBe("/login");
    forward();
    await screen.findByLabelText("Secret Code");
    expect(at()).toBe("/vendor/secret-code");
  });
});
