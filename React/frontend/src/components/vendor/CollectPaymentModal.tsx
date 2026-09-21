import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { formatINR } from "@/utils/vendorFormat";

export type CollectionMethod = "cash" | "upi";

interface Props {
  open: boolean;
  /** e.g. "#A1B2C3D4" */
  bookingRef: string;
  amount: number;
  busy?: boolean;
  /** Title line: "Fueling started" after a PIN check-in, else "Collect payment". */
  title?: string;
  onCollect: (method: CollectionMethod) => void;
  /** "Later": leave it owed; the table's Collect button records it afterwards. */
  onLater: () => void;
}

const METHODS: [CollectionMethod, string, string, string][] = [
  ["cash", "Cash", "Customer paid in cash", "fa-money-bill-wave"],
  ["upi", "Online (UPI)", "Scanned the station's UPI QR", "fa-qrcode"],
];

/**
 * How was the pump payment collected? Asked right after a PIN check-in starts
 * fueling, and by the bookings table's Collect button. One of the two methods
 * must be chosen before "Record payment"; the server validates it again.
 */
export default function CollectPaymentModal({ open, bookingRef, amount, busy = false, title, onCollect, onLater }: Props) {
  const [method, setMethod] = useState<CollectionMethod | null>(null);

  // A fresh choice for each booking.
  useEffect(() => {
    if (open) setMethod(null);
  }, [open, bookingRef]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Collect payment"
    >
      <div className="vm vm-bg-surface rounded-2xl border vm-border p-6 max-w-md w-full">
        {title && (
          <p className="text-[12px] font-bold text-emerald-400 mb-1">
            <i className="fas fa-circle-check mr-1" aria-hidden /> {title}
          </p>
        )}
        <h3 className="text-lg font-bold">How was the payment collected?</h3>
        <p className="text-sm vm-text-muted mt-1 mb-4">
          Booking {bookingRef} · <b className="vm-text">{formatINR(amount)}</b> due at the pump
        </p>

        <div className="grid grid-cols-2 gap-3 mb-5" role="radiogroup" aria-label="Payment method">
          {METHODS.map(([value, label, hint, icon]) => {
            const on = method === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setMethod(value)}
                disabled={busy}
                className={`rounded-xl border p-3 text-left transition-colors ${on ? "border-emerald-500 bg-emerald-600/15" : "vm-border vm-bg-ground"}`}
              >
                <i className={`fas ${icon} text-lg ${on ? "text-emerald-400" : "vm-text-muted"}`} aria-hidden />
                <span className="block font-bold text-sm mt-2">{label}</span>
                <span className="block text-[11px] vm-text-muted">{hint}</span>
              </button>
            );
          })}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onLater}
            disabled={busy}
            className="flex-1 h-10 rounded-lg border vm-border vm-text-muted text-sm font-bold"
          >
            Later
          </button>
          <button
            type="button"
            onClick={() => method && onCollect(method)}
            disabled={!method || busy}
            className="flex-1 h-10 rounded-lg bg-emerald-600 text-white text-sm font-bold disabled:opacity-50"
          >
            {busy ? "Recording…" : "Record payment"}
          </button>
        </div>
        {!method && <p className="text-[11px] vm-text-muted mt-2 text-center">Choose Cash or Online (UPI) to record it.</p>}
      </div>
    </div>,
    document.body,
  );
}
