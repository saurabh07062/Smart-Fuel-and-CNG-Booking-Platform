import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount every rendered tree and forget stored state between tests.
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

/**
 * jsdom implements no scrolling at all, so `scrollIntoView` and `scrollTo` are
 * simply absent and any component that follows its own content -- a chat thread
 * keeping the newest message in view -- throws on mount. Every real browser and
 * the Android WebView have both; these no-ops stand in for them.
 */
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function scrollIntoView() {};
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};

/**
 * jsdom never loads an <img>, so neither `load` nor `error` fires and any
 * code awaiting a picture's dimensions would hang. Fire `error` on the next
 * tick: "dimensions unknown", which is exactly how a browser that cannot
 * decode a file behaves, and what utils/imageUpload.ts is written to handle.
 * A test that cares about real dimensions stubs Image itself.
 */
Object.defineProperty(HTMLImageElement.prototype, "src", {
  configurable: true,
  set(this: HTMLImageElement, value: string) {
    this.setAttribute("src", value);
    queueMicrotask(() => this.dispatchEvent(new Event("error")));
  },
  get(this: HTMLImageElement) {
    return this.getAttribute("src") ?? "";
  },
});
