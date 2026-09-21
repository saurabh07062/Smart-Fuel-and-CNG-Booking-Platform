/**
 * This browser tab's id, sent as X-FM-Tab so the server keeps a separate
 * session per tab (backend services/security/session.js): a vendor in one tab
 * and a customer in another. sessionStorage is per tab and survives a reload,
 * so a refreshed tab keeps its account.
 */
const KEY = "fm-tab-id";

function newId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
}

let cached: string | null = null;

export function tabId(): string {
  if (cached) return cached;
  try {
    const stored = sessionStorage.getItem(KEY);
    if (stored && /^[a-z0-9]{8,24}$/.test(stored)) return (cached = stored);
    cached = newId();
    sessionStorage.setItem(KEY, cached);
  } catch {
    // Storage blocked: an id for this page load only.
    cached = cached || newId();
  }
  return cached;
}

export const TAB_HEADER = "X-FM-Tab";
