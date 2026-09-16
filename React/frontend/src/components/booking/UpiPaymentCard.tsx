import { useEffect, useRef, useState } from "react";
import type { Booking } from "@/types";
import { fetchUpiPayment, type UpiPayment } from "@/services/api/bookingApi";
import { drawQr } from "@/services/qr/qrcode";
import { formatCurrency } from "@/utils/format";

/**
 * Port of loadUpiPayment() in js/utils.js -- the scan-to-pay card on the
 * confirmation page.
 *
 * The QR carries the exact amount so the customer does not type it at the
 * pump, which is where wrong-amount disputes come from.
 *
 * Falling back quietly to "pay the attendant" is deliberate and preserved:
 * no UPI configured, an already-paid booking, or a station that does not take
 * UPI are all things the customer cannot act on, and the booking is still
 * valid. None of them are surfaced as errors.
 */
export default function UpiPaymentCard({ booking }: { booking: Booking }) {
  const [payment, setPayment] = useState<UpiPayment | null>(null);
  const [checked, setChecked] = useState(false);
  const [canvasDrawn, setCanvasDrawn] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const bookingId = String(booking._id);

  useEffect(() => {
    let cancelled = false;
    void fetchUpiPayment(bookingId).then((p) => {
      if (cancelled) return;
      setPayment(p);
      setChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [bookingId]);

  /**
   * The server pre-renders the QR as a PNG data URI. Relying on the CDN-hosted
   * library meant a blocked or slow CDN produced a blank white box at the pump
   * with no way to pay -- the image always works, so it is preferred and the
   * canvas is only drawn when the server could not render one.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !payment || payment.qrDataUri) return;

    let cancelled = false;
    void drawQr(canvas, payment.uri, 200).then((ok) => {
      if (!cancelled) setCanvasDrawn(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [payment]);

  // Nothing is shown until the check resolves, so the cash fallback does not
  // flash on screen while the request is still in flight.
  if (!checked) return null;

  const hasQr = !!payment && (!!payment.qrDataUri || canvasDrawn);

  // No QR by any route: send them to cash rather than showing an empty box.
  if (!payment || !hasQr) {
    return (
      <div className="card p-4 text-center rounded-2xl">
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          <i className="fas fa-money-bill-wave mr-2" aria-hidden />
          Pay the attendant with Cash/UPI when you arrive.
        </p>
        {/* Kept mounted while the draw is still being attempted. */}
        <canvas ref={canvasRef} width={200} height={200} hidden />
      </div>
    );
  }

  return (
    <div className="card p-6 text-center rounded-2xl" style={{ animation: "slideUp .55s ease" }}>
      <p className="text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>
        SCAN TO PAY AT THE PUMP
      </p>
      <p className="text-sm font-bold mb-3">{payment.payeeName}</p>

      <div className="inline-block p-4 rounded-2xl mb-3 bg-white" style={{ minHeight: 200, minWidth: 200 }}>
        {payment.qrDataUri ? (
          <img
            src={payment.qrDataUri}
            alt="UPI payment QR code"
            width={200}
            height={200}
            className="block mx-auto"
          />
        ) : (
          <canvas ref={canvasRef} width={200} height={200} className="mx-auto" />
        )}
      </div>

      <p className="text-2xl font-bold mb-1" style={{ fontFamily: "'Space Grotesk'", color: "var(--primary)" }}>
        {formatCurrency(payment.amount)}
      </p>
      <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
        UPI ID: {payment.vpa}
      </p>

      <a href={payment.uri} className="btn btn-primary w-full mb-2">
        <i className="fas fa-mobile-screen mr-2" aria-hidden />
        Open in a UPI app
      </a>
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Google Pay, PhonePe, Paytm or any bank app
      </p>
    </div>
  );
}
