import { BOOKING_STEPS } from "@/constants/booking";

/**
 * Port of the progress bar in renderBooking(). Reuses .progress-step /
 * .step-num / .progress-line from components.css, and the same rule that a
 * completed step shows a tick instead of its number.
 */
export default function StepProgress({ step }: { step: number }) {
  return (
    <div className="flex items-center mb-8 px-2">
      {BOOKING_STEPS.map((label, i) => {
        const cls = i < step ? "done" : i === step ? "active" : "";
        return (
          <div className={`progress-step ${cls}`} key={label}>
            <div className="step-num">
              {i < step ? <i className="fas fa-check text-xs" aria-hidden /> : i + 1}
            </div>
            <span
              className="text-[10px] font-medium hidden md:block"
              style={{ color: i <= step ? "var(--text)" : "var(--muted)" }}
            >
              {label}
            </span>
            {i < BOOKING_STEPS.length - 1 && <div className="progress-line" />}
          </div>
        );
      })}
    </div>
  );
}
