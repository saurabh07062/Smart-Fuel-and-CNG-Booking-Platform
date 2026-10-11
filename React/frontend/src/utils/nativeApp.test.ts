import { describe, it, expect } from "vitest";
import { isCustomerAppPath } from "./nativeApp";

/**
 * The Android app's route allowlist.
 *
 * Anything this returns false for is sent to /login by the gate in
 * routes/AppRoutes.tsx. That makes it a quiet trap: a page can be built,
 * routed and linked, work perfectly in the browser, and still be unreachable
 * in the APK -- looking like a broken link rather than a missing entry.
 *
 * It happened twice. Fleet booking was linked from the dashboard and from the
 * "Yes, fleet booking" sheet, and bounced to sign-in inside the app. The
 * privacy policy did the same, which is worse: the one page somebody should
 * be able to read BEFORE they hand over any data.
 *
 * So every customer page gets a line here. If you add a page to the app and
 * this test fails, the fix is the allowlist, not the test.
 */

describe("the customer app's reachable pages", () => {
  const pages = [
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password",
    "/privacy",
    "/dashboard",
    "/stations",
    "/booking",
    "/fleet-booking",
    "/confirmation",
    "/nearest-pump",
    "/my-vehicles",
    "/simulation",
  ];

  it.each(pages)("%s is reachable in the app", (path) => {
    expect(isCustomerAppPath(path)).toBe(true);
  });

  it("their sub-paths are reachable too", () => {
    // A station or a booking is opened by id, so the gate has to let the
    // whole branch through, not only the bare path.
    expect(isCustomerAppPath("/stations/65f1c0ffee")).toBe(true);
    expect(isCustomerAppPath("/confirmation/65f1c0ffee")).toBe(true);
  });

  it("the root is reachable, because that is the app's opening screen", () => {
    expect(isCustomerAppPath("/")).toBe(true);
  });

  it("the policy is reachable, which is the whole point of a privacy policy", () => {
    // Signed out and before signing up: if this ever returns false again, a
    // person cannot read what happens to their data before giving it.
    expect(isCustomerAppPath("/privacy")).toBe(true);
  });

  it("vendor and admin pages are not, because the app is for customers", () => {
    for (const path of ["/vendor", "/vendor/track", "/admin", "/admin/login", "/superadmin"]) {
      expect(isCustomerAppPath(path)).toBe(false);
    }
  });

  it("an unknown path is not", () => {
    expect(isCustomerAppPath("/something-nobody-built")).toBe(false);
  });
});
