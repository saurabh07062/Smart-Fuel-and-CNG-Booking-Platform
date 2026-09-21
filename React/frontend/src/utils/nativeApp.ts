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

/** The customer app's own pages; anything else goes to sign-in. */
export function isCustomerAppPath(pathname: string): boolean {
  return /^\/(login|register|forgot-password|reset-password|dashboard|stations|booking|confirmation|nearest-pump|my-vehicles)?(\/|$)/.test(pathname);
}
