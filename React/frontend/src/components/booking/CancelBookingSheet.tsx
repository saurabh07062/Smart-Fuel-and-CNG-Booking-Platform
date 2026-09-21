import { useState } from "react";
import Modal from "@/components/common/Modal";

/** Must match backend bookingController.cancelBooking CANCEL_REASONS. */
export const CANCEL_REASONS = [
  ["plans_changed", "Plans changed"],
  ["wrong_slot", "Booked the wrong slot"],
  ["too_far", "Station is too far"],
  ["long_wait", "Queue is too long"],
  ["other", "Something else"],
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number][0];

interface Props {
  open: boolean;
  /** "Leave waitlist" wording for a waitlisted booking. */
  waitlisted?: boolean;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (reason: CancelReason | undefined) => void;
}

/**
 * Confirm a cancellation, optionally saying why. A reason is not required:
 * "Cancel booking" works without one.
 */
export default function CancelBookingSheet({ open, waitlisted = false, busy = false, onClose, onConfirm }: Props) {
  const [reason, setReason] = useState<CancelReason | undefined>(undefined);
  const what = waitlisted ? "Leave the waitlist?" : "Cancel this booking?";

  return (
    <Modal open={open} title={what} onClose={onClose}>
      <p className="text-[13px] mb-3" style={{ color: "var(--muted)" }}>
        {waitlisted
          ? "You will lose your place in the queue for this slot."
          : "Your slot will be released for someone else. Nothing is charged."}
      </p>
      <p className="text-[12px] font-bold mb-2">Why are you cancelling? (optional)</p>
      <div className="flex flex-wrap gap-2 mb-5" role="radiogroup" aria-label="Reason">
        {CANCEL_REASONS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={reason === value}
            className={`cx-chip ${reason === value ? "is-on" : ""}`}
            onClick={() => setReason(reason === value ? undefined : value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <button type="button" className="btn btn-outline btn-block" onClick={onClose} disabled={busy}>
          Keep it
        </button>
        <button type="button" className="btn btn-danger-outline btn-block" onClick={() => onConfirm(reason)} disabled={busy}>
          {busy ? "Cancelling…" : waitlisted ? "Leave waitlist" : "Cancel booking"}
        </button>
      </div>
    </Modal>
  );
}
