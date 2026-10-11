import { IS_NATIVE_BUILD } from "@/services/api/serverAddress";

/**
 * This browser tab's id, sent as X-FM-Tab so the server keeps a separate
 * session per tab (backend services/security/session.js): a vendor in one tab
 * and a customer in another. sessionStorage is per tab and survives a reload,
 * so a refreshed tab keeps its account.
 *
 * THE ANDROID APP HAS NO TABS.
 *
 * It has one screen, and its session cookies (fm_access_<tab>) are kept by
 * Android's own cookie jar, which survives the app being closed. The id that
 * NAMES those cookies was in sessionStorage, which does not: killing the app
 * destroys the WebView, so the next launch invented a new id and asked for a
 * cookie that had never been set -- while the real session sat in the jar,
 * unreachable, under the old name. Every restart looked like a sign-out.
 *
 * So the app stores its one id where the cookies' lifetime is: localStorage,
 * which the WebView keeps on disk. The website is unchanged -- there, one id
 * per tab is the entire point.
 */
const KEY = "fm-tab-id";

/** localStorage in the app (survives a restart), sessionStorage per tab on the web. */
const store = (): Storage => (IS_NATIVE_BUILD ? localStorage : sessionStorage);

function newId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
}

let cached: string | null = null;

export function tabId(): string {
  if (cached) return cached;
  try {
    const stored = store().getItem(KEY);
    if (stored && /^[a-z0-9]{8,24}$/.test(stored)) return (cached = stored);
    cached = newId();
    store().setItem(KEY, cached);
  } catch {
    // Storage blocked: an id for this page load only.
    cached = cached || newId();
  }
  return cached;
}

export const TAB_HEADER = "X-FM-Tab";
