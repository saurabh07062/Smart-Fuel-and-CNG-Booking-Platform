import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import type { ApiError } from "@/types";
import { recordServerDate } from "@/utils/serverClock";
import { TAB_HEADER, tabId } from "@/utils/tabId";

/**
 * The single Axios instance every API module uses.
 *
 * Base URL is "/api" rather than "http://localhost:5000/api": Vite proxies
 * /api to the backend in dev (vite.config.ts), and in production the app is
 * served behind the same origin. Hardcoding the host is what forces a code
 * change at deploy time -- the Vanilla app has that string in ~30 places.
 *
 * The session lives in httpOnly cookies the server sets on login
 * (backend/src/services/security/session.js): fm_access, a 15-minute access
 * token sent with every request, and fm_refresh, sent only to /api/auth. No
 * script can read either -- which is the point -- so nothing here stores,
 * reads or attaches a token: the browser sends the cookies itself.
 */
export const apiClient = axios.create({
  baseURL: "/api",
  timeout: 20000,
  withCredentials: true,
  // Which tab this is: the server keeps a separate session per tab.
  headers: { [TAB_HEADER]: tabId() },
});

// Keep the device's view of the server clock current (utils/serverClock.ts):
// fueling countdowns are timed from server timestamps.
apiClient.interceptors.response.use((response) => {
  const date = response.headers?.date;
  if (typeof date === "string") recordServerDate(date);
  return response;
});

// Tokens this app kept in localStorage before sessions moved to httpOnly
// cookies. Nothing reads them any more; removed so none lingers on a device.
try {
  ["fm-token", "fm-vendor-token", "fm-admin-token"].forEach((key) => localStorage.removeItem(key));
} catch {
  /* storage blocked: nothing to remove */
}

/**
 * How the client knows whether a session is expected, and whom to tell when
 * it has ended. Configured by store/authStore.ts -- this module cannot import
 * the store without a cycle.
 */
const sessionHooks = {
  isSignedIn: () => false,
  onExpired: () => {},
};

export function configureSession(hooks: Partial<typeof sessionHooks>) {
  Object.assign(sessionHooks, hooks);
}

// Refreshing must not pass through the 401 handler below.
const sessionClient = axios.create({ baseURL: "/api", timeout: 20000, withCredentials: true, headers: { [TAB_HEADER]: tabId() } });

/**
 * A tab opened after someone signed in, in another tab, starts with that
 * sign-in and takes its own copy of it (the server "forks" the browser's
 * latest session for this tab). From then on, sign-ins in other tabs do not
 * change this one. Resolves the account, or null when there is none.
 */
export async function adoptBrowserSession<T>(): Promise<T | null> {
  try {
    // X-FM-Adopt: signed out is a normal answer here ({ user: null }), not a 401.
    const { data } = await sessionClient.post<{ user?: T | null }>("/auth/refresh", undefined, { headers: { "X-FM-Adopt": "1" } });
    return data?.user ?? null;
  } catch {
    return null;
  }
}
let refreshing: Promise<boolean> | null = null;

/**
 * Exchange the refresh cookie for a new session. Every caller that needs one
 * at the same moment shares a single request. Resolves true when the session
 * is good again -- including when another tab refreshed a moment earlier
 * (REFRESH_IN_PROGRESS): the browser already holds that tab's new cookies.
 * Signed out, it resolves false without asking the server.
 */
export function refreshSession(): Promise<boolean> {
  if (!sessionHooks.isSignedIn()) return Promise.resolve(false);
  if (!refreshing) {
    refreshing = sessionClient
      .post("/auth/refresh")
      .then(
        () => true,
        (err: AxiosError<{ reason?: string }>) => err.response?.data?.reason === "REFRESH_IN_PROGRESS",
      )
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

type RetriableConfig = InternalAxiosRequestConfig & { _sessionRetried?: boolean };

// These answer 401 about the credentials themselves; retrying after a
// refresh would only loop.
const SESSION_ROUTES = /^\/?auth\/(login|register|refresh|logout)(\/|\?|$)/;

/**
 * An expired access cookie is not an expired session: on a 401, refresh once
 * and replay the request. Only when the refresh fails too is the session over.
 */
apiClient.interceptors.response.use(undefined, async (error: AxiosError) => {
  const config = error.config as RetriableConfig | undefined;
  if (
    error.response?.status !== 401 ||
    !config ||
    config._sessionRetried ||
    SESSION_ROUTES.test(config.url ?? "")
  ) {
    return Promise.reject(error);
  }
  config._sessionRetried = true;
  if (await refreshSession()) return apiClient(config);
  if (sessionHooks.isSignedIn()) sessionHooks.onExpired();
  return Promise.reject(error);
});

/**
 * Normalise every failure into one shape.
 *
 * Without this each caller has to cope with err.response?.data?.msg, a bare
 * string, or a network error with no response at all -- which is why the
 * Vanilla app shows "Network error" for several things that are not.
 */
export function toApiError(err: unknown): ApiError {
  const ax = err as AxiosError<ApiError>;
  if (ax?.response?.data) {
    const d = ax.response.data;
    return {
      msg: d.msg || "Something went wrong.",
      reason: d.reason,
      code: d.code,
      field: d.field,
      suggestion: d.suggestion ?? null,
    };
  }
  if (ax?.request) {
    return { msg: "Could not reach the server. Check your connection.", reason: "NETWORK" };
  }
  return { msg: "Something went wrong.", reason: "UNKNOWN" };
}

/** Resolve a stored /uploads path to a URL an <img src> can use. */
export function uploadUrl(value?: string | null): string | null {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (/^(https?:|data:|blob:)/i.test(v)) return v;
  if (v.startsWith("/uploads/")) return v; // proxied in dev, same-origin in prod
  return null;
}
