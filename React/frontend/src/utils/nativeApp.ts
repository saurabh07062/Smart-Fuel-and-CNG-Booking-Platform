import { Capacitor } from "@capacitor/core";

/**
 * Running inside the FuelMart customer Android app (React/mobile, Capacitor)
 * rather than a browser. The app is for customers only: vendor and admin
 * pages are not offered there (routes/ProtectedRoute.tsx, pages/auth/Login.tsx).
 */
export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/**
 * The customer app's own pages; anything else goes to sign-in.
 *
 * This is an ALLOWLIST, which means a page added to the app is invisible here
 * until it is added to this line as well -- the gate sends it to /login
 * instead, and the page looks broken rather than missing. Two had drifted out
 * of it:
 *
 *   fleet-booking   the multiple-vehicle flow, which the dashboard and the
 *                   "Yes, fleet booking" sheet both link to
 *   privacy         the privacy policy, which has to be readable BEFORE
 *                   somebody signs up, so bouncing it to sign-in defeats it
 *
 * If you add a customer page, add it here too.
 */
export function isCustomerAppPath(pathname: string): boolean {
  return /^\/(login|register|forgot-password|reset-password|privacy|dashboard|stations|booking|fleet-booking|confirmation|nearest-pump|my-vehicles|simulation)?(\/|$)/.test(pathname);
}
