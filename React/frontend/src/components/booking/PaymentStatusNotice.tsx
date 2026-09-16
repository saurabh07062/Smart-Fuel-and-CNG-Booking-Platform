import { useEffect, useState } from "react";
import { fetchPaymentStatus } from "@/services/payment/razorpay";

/**
 * Dashboard notice: online payment (Razorpay) is currently unavailable.
 *
 * Driven by GET /api/razorpay/status, so it disappears on its own the moment a
 * valid Razorpay key is configured on the server -- no frontend change needed
 * to switch online payment back on. Renders nothing while the status is still
 * unknown, so it never flashes for a correctly configured server.
 */
export default function PaymentStatusNotice() {
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPaymentStatus().then((s) => {
      if (!cancelled) setConfigured(s.configured);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (configured !== false) return null;

  return (
    <div className="cx-alert" role="status">
      <i className="fas fa-credit-card" aria-hidden />
      <p style={{ color: "var(--text2)" }}>
        <span className="font-semibold" style={{ color: "var(--text)" }}>
          Online payment is unavailable right now.
        </span>{" "}
        Wallet, card and UPI checkout are switched off for the moment. You can still book a slot and pay
        at the station.
      </p>
    </div>
  );
}
