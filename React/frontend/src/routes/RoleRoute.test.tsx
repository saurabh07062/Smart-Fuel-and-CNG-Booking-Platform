import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import RoleRoute from "./RoleRoute";
import { useAuthStore } from "@/store/authStore";
import type { User } from "@/types";

/**
 * The role gate must never answer with a blank screen.
 *
 * A guard that redirects to the page it is guarding hands the same route back
 * to itself, for ever: React renders nothing, and in the Android app that is a
 * white WebView with no console to look at. It happened for real -- registration
 * returned a user with no `role` (backend controllers/authController.js), the
 * gate refused the dashboard to a role it did not recognise, and the place it
 * sent them was the dashboard.
 *
 * The response was fixed at the source. These tests keep the gate itself unable
 * to produce that outcome, whatever the server sends -- a page a person can see
 * is always better than one they cannot.
 */

const customer = { id: "u1", name: "Asha", email: "a@b.test", role: "customer" } as User;

/** A user whose role did not survive the trip, as the broken response produced. */
const roleless = { id: "u1", name: "Asha", email: "a@b.test" } as unknown as User;

const renderAt = (path: string, user: User | null) => {
  useAuthStore.setState({ user, isAuthenticated: Boolean(user) });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/dashboard"
          element={
            <RoleRoute allow={["customer"]}>
              <p>Customer dashboard</p>
            </RoleRoute>
          }
        />
        <Route path="/login" element={<p>Sign in</p>} />
        <Route path="/vendor" element={<p>Vendor panel</p>} />
      </Routes>
    </MemoryRouter>,
  );
};

beforeEach(() => useAuthStore.setState({ user: null, isAuthenticated: false }));

describe("the role gate", () => {
  it("lets the right role through", () => {
    renderAt("/dashboard", customer);
    expect(screen.getByText("Customer dashboard")).toBeTruthy();
  });

  it("sends a signed-out visitor to sign in", () => {
    renderAt("/dashboard", null);
    expect(screen.getByText("Sign in")).toBeTruthy();
  });

  it("renders SOMETHING for a user whose role is missing, never a blank screen", () => {
    // The exact shape the old registration response produced. The gate's own
    // idea of "home" for this user is /dashboard -- the page being guarded --
    // so redirecting would loop and paint nothing.
    renderAt("/dashboard", roleless);

    expect(screen.getByText("Customer dashboard")).toBeTruthy();
    expect(document.body.textContent?.trim()).not.toBe("");
  });

  it("still redirects a role that belongs somewhere else", () => {
    // A vendor on a customer page goes to the vendor panel: a real redirect,
    // because it is not the page they are already on. The loop guard must not
    // have turned the gate into a no-op.
    const vendor = { ...customer, role: "vendor", vendorStatus: "active", activated: true } as User;
    renderAt("/dashboard", vendor);
    expect(screen.getByText("Vendor panel")).toBeTruthy();
    expect(screen.queryByText("Customer dashboard")).toBeNull();
  });

  it("an admin passes every gate, as the backend allows", () => {
    renderAt("/dashboard", { ...customer, role: "admin" } as User);
    expect(screen.getByText("Customer dashboard")).toBeTruthy();
  });
});
