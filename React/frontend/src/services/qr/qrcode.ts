/**
 * Client-side QR rendering.
 *
 * The library is loaded from the same CDN the Vanilla app used
 * (qrcode -- see QR_SRC for the version), on demand, rather than added as an npm dependency: it is
 * needed on exactly two cards and only once a booking exists, so bundling it
 * would put ~50KB in front of every page for a feature most visits never
 * reach. The loader is the same shape as the QR *scanner* loader in
 * AdminVerifyTab.
 */

interface QRCodeLib {
  toCanvas: (
    canvas: HTMLCanvasElement,
    text: string,
    opts: Record<string, unknown>,
  ) => Promise<void>;
  toDataURL: (text: string, opts: Record<string, unknown>) => Promise<string>;
}

declare global {
  interface Window {
    QRCode?: QRCodeLib;
  }
}

/**
 * qrcode@1.5.1, NOT the 1.5.3 the Vanilla app points at: 1.5.3 was published
 * without its browser build, so that URL answers 404 -- which is part of why
 * the Vanilla booking QR never rendered. 1.5.1 is the newest release that
 * still ships build/qrcode.min.js, with the same toCanvas/toDataURL API.
 */
const QR_SRC = "https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js";

let scriptPromise: Promise<QRCodeLib | null> | null = null;

export function loadQrCode(): Promise<QRCodeLib | null> {
  if (window.QRCode) return Promise.resolve(window.QRCode);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<QRCodeLib | null>((resolve) => {
    const el = document.createElement("script");
    el.src = QR_SRC;
    el.async = true;
    el.onload = () => resolve(window.QRCode ?? null);
    el.onerror = () => {
      // Allow a later retry rather than caching the failure forever.
      scriptPromise = null;
      resolve(null);
    };
    document.body.appendChild(el);
  });

  return scriptPromise;
}

/** The Vanilla render options, unchanged, so the codes look identical. */
export const QR_OPTIONS = {
  margin: 1,
  errorCorrectionLevel: "M",
  color: { dark: "#0F172A", light: "#FFFFFF" },
} as const;

/**
 * Draw `text` into `canvas`. Resolves false when the library could not be
 * loaded, so the caller can show a real fallback instead of an empty box.
 */
export async function drawQr(
  canvas: HTMLCanvasElement,
  text: string,
  width: number,
): Promise<boolean> {
  const lib = await loadQrCode();
  if (!lib) return false;
  try {
    await lib.toCanvas(canvas, text, { ...QR_OPTIONS, width });
    return true;
  } catch {
    return false;
  }
}
