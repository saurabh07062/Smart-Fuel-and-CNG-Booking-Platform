import { useEffect, useRef, useState } from "react";
import * as api from "@/services/api/adminApi";
import { pushToast } from "@/store/toastStore";
import { toApiError } from "@/services/api/apiClient";

/**
 * Minimal surface of html5-qrcode's Html5QrcodeScanner, loaded from the CDN
 * at runtime. Typed here rather than pulled in as a dependency because the
 * Vanilla app loads the same script tag -- adding the npm package would
 * change what ships, not just how it is written.
 */
interface Html5QrcodeScannerLike {
  render: (
    onSuccess: (decodedText: string) => void,
    onFailure: (error: string) => void,
  ) => void;
  clear: () => Promise<void>;
}

declare global {
  interface Window {
    Html5QrcodeScanner?: new (
      elementId: string,
      config: { fps: number; qrbox: { width: number; height: number } },
      verbose: boolean,
    ) => Html5QrcodeScannerLike;
  }
}

const SCANNER_SRC = "https://unpkg.com/html5-qrcode";

let scriptPromise: Promise<boolean> | null = null;

/** Load the scanner library once, on demand. */
function loadScannerScript(): Promise<boolean> {
  if (window.Html5QrcodeScanner) return Promise.resolve(true);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<boolean>((resolve) => {
    const el = document.createElement("script");
    el.src = SCANNER_SRC;
    el.async = true;
    el.onload = () => resolve(true);
    el.onerror = () => {
      // Allow a later retry rather than caching the failure forever.
      scriptPromise = null;
      resolve(false);
    };
    document.body.appendChild(el);
  });
  return scriptPromise;
}

/**
 * Port of the Scan & Verify tab: startAdminScanner(), stopAdminScanner(),
 * onScanSuccess(), verifyBookingByCode() and verifyBooking().
 *
 * The camera is a real resource, and the Vanilla page only released it via
 * switchAdminTab()'s `else stopAdminScanner()` branch -- so navigating away
 * with the app's own router (rather than switching tab) left the camera on.
 * Here the teardown is the component's own cleanup, which runs however the
 * tab is left.
 */
export default function AdminVerifyTab() {
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const scannerRef = useRef<Html5QrcodeScannerLike | null>(null);

  const stopScanner = () => {
    const s = scannerRef.current;
    scannerRef.current = null;
    setScanning(false);
    if (s) void s.clear().catch(() => undefined);
  };

  // Release the camera whenever this tab unmounts, for any reason.
  useEffect(() => stopScanner, []);

  const verify = async (input: { bookingId?: string; verificationCode?: string }) => {
    setBusy(true);
    try {
      // Scanning is the check-in. The backend decides: nozzle free -> fueling
      // starts and completes on its own when the fuel's service time is up;
      // nozzle busy -> the car waits and starts automatically when released.
      const data = await api.verifyBooking(input);
      pushToast(
        data.msg || (data.queued ? "Checked in. Waiting for the nozzle." : "Checked in. Fueling has started."),
        data.queued ? "info" : "success",
      );
      setCode("");
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setBusy(false);
    }
  };

  const startScanner = async () => {
    if (scannerRef.current) return;
    const ok = await loadScannerScript();
    if (!ok || !window.Html5QrcodeScanner) {
      pushToast("QR Scanner library not loaded.", "error");
      return;
    }

    const scanner = new window.Html5QrcodeScanner(
      "qr-reader",
      { fps: 10, qrbox: { width: 250, height: 250 } },
      false,
    );
    scannerRef.current = scanner;
    setScanning(true);

    scanner.render(
      (decodedText) => {
        stopScanner();
        try {
          const data = JSON.parse(decodedText) as { id?: string };
          if (data.id) void verify({ bookingId: data.id });
          else pushToast("Invalid QR format", "error");
        } catch {
          pushToast("Invalid QR code", "error");
        }
      },
      () => {
        /* background decode failures fire constantly; ignored, as in the original */
      },
    );
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
      <div className="vm-panel" style={{ padding: 22, display: "flex", flexDirection: "column" }}>
        <div className="flex items-center gap-3 mb-6">
          <i className="fas fa-camera text-[#0CE0ED]" aria-hidden />
          <h3 className="vm-panel-title">Scan QR Code</h3>
        </div>
        <div
          id="qr-reader"
          className="vm-bg-surface rounded-xl overflow-hidden min-h-[300px] flex items-center justify-center"
        />
        <button
          onClick={scanning ? stopScanner : () => void startScanner()}
          className="vm-btn vm-btn-ghost"
          style={{ width: "100%", marginTop: 16 }}
        >
          {scanning ? "Stop Camera" : "Start Camera"}
        </button>
      </div>

      <div className="col-span-1 vm-bg-surface rounded-2xl border vm-border p-6 flex flex-col justify-center items-center">
        <div className="flex items-center gap-3 mb-6">
          <i className="fas fa-keyboard text-[#0CE0ED]" aria-hidden />
          <h3 className="vm-panel-title">Manual 4-Digit Code</h3>
        </div>
        <p className="vm-text-muted text-sm mb-6 text-center">
          Enter the customer's 4-digit code to check them in. Fueling starts now and the booking completes
          automatically when the fuel's service time is up.
        </p>
        <input
          type="text"
          maxLength={4}
          aria-label="Verification code"
          className="w-48 text-center text-4xl font-mono tracking-[0.3em] font-bold vm-bg-ground border vm-border rounded-xl px-4 py-6 vm-text mb-6"
          placeholder="----"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button
          onClick={() => {
            if (code.length !== 4) {
              pushToast("Please enter a 4-digit code", "error");
              return;
            }
            void verify({ verificationCode: code });
          }}
          disabled={busy}
          className="vm-btn vm-btn-primary"
          style={{ width: 192 }}
        >
          {busy ? "Checking in…" : "Check In"}
        </button>
      </div>
    </div>
  );
}
