import { useEffect, useRef, useState } from "react";
import type { Booking, UiStation } from "@/types";
import { drawQr } from "@/services/qr/qrcode";
import { resolveBookingStation } from "@/utils/station";

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
  }, [bookingId, st.name, st.address, b.bookingDate, b.timeSlot, b.fuelType, b.vehiclePlate, b.status]);

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
            <p className="text-[11px]">QR unavailable — use the PIN below</p>
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
        <p className="text-3xl font-bold tracking-[0.25em] font-mono" style={{ color: "var(--primary)" }}>
          {b.verificationCode || "----"}
        </p>
      </div>

      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Show this PIN or scan QR when you arrive at the pump.
      </p>
    </div>
  );
}
