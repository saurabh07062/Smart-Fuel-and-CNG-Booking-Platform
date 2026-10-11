import type { AxiosAdapter, AxiosRequestConfig } from "axios";
import { CapacitorHttp } from "@capacitor/core";

/**
 * How the Android app talks to the server.
 *
 * The bundled app's pages come from the device, not from FuelMart's origin,
 * so a normal browser request would be cross-origin: the browser would
 * demand CORS, and it would refuse to send or store the session cookies
 * (they cannot be `Secure` over plain http to an IP address). The session
 * would be lost on every call.
 *
 * Capacitor's native HTTP does the request in Android, outside the WebView:
 * no CORS preflight, and cookies are kept by the native cookie jar, so the
 * existing cookie session works exactly as it does on the web. This adapter
 * makes axios use it, so every existing API module is unchanged.
 *
 * It is installed ONLY in the native build (services/api/apiClient.ts). The
 * website keeps XMLHttpRequest.
 */

/** Axios sends objects; the native bridge wants JSON it can serialise. */
function bodyFor(config: AxiosRequestConfig): unknown {
  const { data } = config;
  if (data == null) return undefined;
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  // FormData cannot cross the bridge; the app's uploads (profile photo,
  // vehicle image) keep working because CapacitorHttp accepts a plain object
  // and multipart is only used by vendor/admin screens, which the customer
  // app does not carry.
  return data;
}

function headersFor(config: AxiosRequestConfig): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = config.headers as Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value == null) continue;
    if (typeof value === "object") continue; // axios's per-method buckets
    out[key] = String(value);
  }
  return out;
}

/** Build the absolute URL axios would have requested. */
function urlFor(config: AxiosRequestConfig): string {
  const base = (config.baseURL ?? "").replace(/\/+$/, "");
  const path = config.url ?? "";
  if (/^https?:\/\//i.test(path)) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * A JSON string body, parsed. Anything else is returned untouched.
 *
 * Deliberately narrow: only a string that begins with `{` or `[` is tried, and
 * a parse failure returns the original. Plain-text bodies and HTML error pages
 * stay exactly as they arrived, so nothing is hidden or guessed at.
 */
function parseIfJson(data: unknown): unknown {
  if (typeof data !== "string") return data;
  const text = data.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return data;
  try {
    return JSON.parse(text);
  } catch {
    return data;
  }
}

export const capacitorAdapter: AxiosAdapter = async (config) => {
  const response = await CapacitorHttp.request({
    url: urlFor(config),
    method: (config.method ?? "get").toUpperCase(),
    headers: headersFor(config),
    params: (config.params as Record<string, string>) ?? undefined,
    data: bodyFor(config),
    // The session cookies the server set on login.
    webFetchExtra: { credentials: "include" },
    connectTimeout: config.timeout,
    readTimeout: config.timeout,
  });

  const status = response.status;
  const result = {
    // CapacitorHttp parses a JSON body when the response says so, and hands
    // back the raw string when it does not (a proxy that drops Content-Type, an
    // error page). Axios callers all expect the parsed object -- `data.user`
    // on a string is simply undefined, which is how a successful registration
    // could read as "no user" and send a signed-in person to the login screen.
    // Parse it here so every API module sees the same shape it sees on the web.
    data: parseIfJson(response.data),
    status,
    statusText: String(status),
    headers: (response.headers ?? {}) as Record<string, string>,
    config,
    request: null,
  };

  // Axios decides success from validateStatus; honour it so every existing
  // catch block (401 refresh, 409 conflicts) behaves as it does on the web.
  const ok = config.validateStatus ? config.validateStatus(status) : status >= 200 && status < 300;
  if (ok) return result as never;

  const error = new Error(`Request failed with status code ${status}`) as Error & {
    response?: unknown;
    config?: unknown;
    isAxiosError?: boolean;
  };
  error.isAxiosError = true;
  error.config = config;
  error.response = result;
  throw error;
};
