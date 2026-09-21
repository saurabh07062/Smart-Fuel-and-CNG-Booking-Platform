import { useEffect, useRef, useState } from "react";
import type { Booking, UiStation } from "@/types";
import { drawQr } from "@/services/qr/qrcode";
import { resolveBookingStation } from "@/utils/station";
import { pushToast } from "@/store/toastStore";

interface Props {
  booking: Booking;
  stations?: UiStation[];
}

/**
 * The pass the attendant checks: a scannable QR plus the 4-digit PIN.
 *
 * The PIN half is a straight port of the Vanilla card. The QR half restores
 * `generateQR()` from js/utils.js, which was DEAD CODE in the Vanilla app:
 * it looked for `#qr-canvas`, and no page ever rendered that element, so it
 * returned on its first line every time.
 *
 * That mattered, because the other half of the feature shipped and worked --
 * the admin console's Scan & Verify tab decodes a QR and reads `id` out of
 * it. An attendant could scan, but no customer had anything to scan. The
 * payload below is the exact shape generateQR() built, so the existing
 * scanner reads it without any change on that side.
 */
export default function BookingQrCard({ booking: b, stations = [] }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [qrFailed, setQrFailed] = useState(false);
  // Bumped by "Retry" to draw the QR again.
  const [attempt, setAttempt] = useState(0);

  // Keep the screen from dimming while the pass is open (where supported),
  // so the attendant can scan it. Released on leaving the page.
  useEffect(() => {
    type WakeLock = { release: () => Promise<void> };
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<WakeLock> } };
    let lock: WakeLock | null = null;
    let done = false;
    nav.wakeLock
      ?.request("screen")
      .then((l) => {
        if (done) void l.release();
        else lock = l;
      })
      .catch(() => {});
    return () => {
      done = true;
      void lock?.release().catch(() => {});
    };
  }, []);

  const bookingId = String(b._id);
  const st = resolveBookingStation(b, stations);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // The payload generateQR() built, field for field.
    const payload = JSON.stringify({
      id: bookingId,
      station: st.name,
      address: st.address,
      date: b.bookingDate,
      time: b.timeSlot,
      fuel: b.fuelType,
      vehicle: b.vehiclePlate,
      status: b.status,
    });

    let cancelled = false;
    void drawQr(canvas, payload, 180).then((ok) => {
      if (!cancelled) setQrFailed(!ok);
    });
    return () => {
      cancelled = true;
    };
  }, [bookingId, st.name, st.address, b.bookingDate, b.timeSlot, b.fuelType, b.vehiclePlate, b.status, attempt]);

  const copyPin = async () => {
    if (!b.verificationCode) return;
    try {
      await navigator.clipboard.writeText(b.verificationCode);
      pushToast("PIN copied", "success");
    } catch {
      pushToast("Could not copy. The PIN is " + b.verificationCode, "info");
    }
  };

  /** The QR with the PIN and slot under it, saved as a PNG for offline use at the pump. */
  const saveImage = () => {
    const qr = canvasRef.current;
    if (!qr || qrFailed) return;
    const out = document.createElement("canvas");
    out.width = 320;
    out.height = 400;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(qr, 40, 30, 240, 240);
    ctx.fillStyle = "#0b0b0f";
    ctx.textAlign = "center";
    ctx.font = "bold 34px monospace";
    ctx.fillText((b.verificationCode || "----").split("").join(" "), 160, 315);
    ctx.font = "14px sans-serif";
    ctx.fillText(st.name.slice(0, 36), 160, 348);
    ctx.fillText(`${b.bookingDate} · ${b.timeSlot} · ${b.fuelType}`, 160, 370);
    const a = document.createElement("a");
    a.href = out.toDataURL("image/png");
    a.download = `fuelmart-pass-${b.verificationCode || bookingId.slice(-6)}.png`;
    a.click();
  };

  return (
    <div className="card p-5 text-center" style={{ animation: "slideUp .5s ease" }}>
      <p className="cx-eyebrow mb-1">Your QR pass</p>
      <p className="text-[11px] font-mono mb-3" style={{ color: "var(--muted)" }}>
        {bookingId}
      </p>

      <div
        className="rounded-xl p-3 inline-block mb-3 bg-white"
        style={{ border: "1px solid var(--border)", minHeight: 186, minWidth: 186 }}
      >
        {/* Kept mounted even on failure so the ref stays valid for a retry. */}
        <canvas ref={canvasRef} width={180} height={180} hidden={qrFailed} />
        {qrFailed && (
          <div
            className="flex flex-col items-center justify-center text-center px-3"
            style={{ width: 180, height: 180, color: "var(--muted)" }}
          >
            <i className="fas fa-qrcode text-3xl mb-2" aria-hidden />
            <p className="text-[11px] mb-2">QR didn't load. The PIN below works too.</p>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setAttempt((n) => n + 1)}>
              <i className="fas fa-rotate" aria-hidden /> Retry
            </button>
          </div>
        )}
      </div>

      <div
        className="rounded-xl p-3.5 mb-3"
        style={{ background: "var(--bg2)", border: "1px solid var(--border)" }}
      >
        <p className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: "var(--muted)" }}>
          Passcode / Attendant PIN
        </p>
        <div className="flex items-center justify-center gap-2">
          <p className="text-3xl font-bold tracking-[0.25em] font-mono" style={{ color: "var(--primary)" }}>
            {b.verificationCode || "----"}
          </p>
          {b.verificationCode && (
            <button type="button" className="cx-icon-btn" onClick={() => void copyPin()} aria-label="Copy PIN" title="Copy PIN">
              <i className="fas fa-copy" aria-hidden />
            </button>
          )}
        </div>
      </div>

      {!qrFailed && (
        <button type="button" className="btn btn-outline btn-sm mb-3" onClick={saveImage}>
          <i className="fas fa-download" aria-hidden /> Save image
        </button>
      )}

      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Show this PIN or scan QR when you arrive at the pump.
      </p>
    </div>
  );
}
