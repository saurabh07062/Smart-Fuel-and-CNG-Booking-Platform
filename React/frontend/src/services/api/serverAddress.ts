/**
 * Where the API lives.
 *
 * On the web the answer is "the same origin this page came from", so every
 * request is a relative "/api/..." path and there is nothing to configure.
 *
 * The Android app is different: its pages are files inside the APK, so there
 * is no origin to be relative to. It needs the server's address, and that
 * address is not knowable at build time -- the machine running FuelMart gets
 * a new IP on every Wi-Fi it joins. So the app ships with a default
 * (VITE_API_BASE) and lets a person change it, storing their choice on the
 * device. This is the one place that decides which of those applies.
 */

const KEY = "fm_server_base";

/** True in the build bundled into the APK (vite --mode native). */
export const IS_NATIVE_BUILD = import.meta.env.VITE_NATIVE === "1";

/** "http://10.0.0.5:5000" -> "http://10.0.0.5:5000"; "10.0.0.5" -> "http://10.0.0.5:5000". */
export function normaliseServerBase(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  // Plain http with no port means the backend's own port; https keeps its default.
  const port = url.port || (url.protocol === "http:" ? "5000" : "");
  return `${url.protocol}//${url.hostname}${port ? `:${port}` : ""}`;
}

/** The address saved on this device, or null when the default is in use. */
export function savedServerBase(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // private mode, or storage blocked
  }
}

/** Remember a new address (or clear it back to the built-in default). */
export function setServerBase(value: string | null): void {
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: this run still uses it via the caller's reload */
  }
}

/**
 * The origin API calls go to. Empty string on the web, which makes every
 * request relative and keeps cookies same-origin.
 */
export function serverBase(): string {
  if (!IS_NATIVE_BUILD) return "";
  const saved = savedServerBase();
  if (saved) return saved;
  const built = normaliseServerBase(String(import.meta.env.VITE_API_BASE ?? ""));
  // 10.0.2.2 is the host machine as seen from the Android emulator: a
  // sensible last resort, and obviously wrong on a real phone, which is what
  // the "Server address" screen is for.
  return built ?? "http://10.0.2.2:5000";
}

/** The base every axios instance uses: "/api" on the web, absolute in the app. */
export function apiBaseUrl(): string {
  return `${serverBase()}/api`;
}
