import type { Booking } from "@/types";

const STEPS = [
  ["Booked", "fa-calendar-check"],
  ["On the way", "fa-car-side"],
  ["At pump", "fa-gas-pump"],
  ["Completed", "fa-circle-check"],
] as const;

/**
 * How far along a booking is: 0 booked, 1 on the way (it is time to leave),
 * 2 at the pump (checked in or fueling), 3 completed.
 */
export function timelineStep(b: Pick<Booking, "status" | "arrivalTime">, leaveByPassed: boolean): number {
  if (b.status === "completed") return 3;
  if (b.status === "serving" || b.arrivalTime) return 2;
  if (leaveByPassed) return 1;
  return 0;
}

/** Booked -> On the way -> At pump -> Completed, with the current step highlighted. */
export default function BookingTimeline({ step }: { step: number }) {
  return (
    <ol className="flex items-start mb-4" aria-label="Booking progress">
      {STEPS.map(([label, icon], i) => {
        const done = i < step;
        const current = i === step;
        const color = done || current ? "var(--primary)" : "var(--muted)";
        return (
          <li key={label} className="flex-1 flex flex-col items-center text-center relative" aria-current={current ? "step" : undefined}>
            {i > 0 && (
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  top: 15,
                  right: "50%",
                  width: "100%",
                  height: 2,
                  background: i <= step ? "var(--primary)" : "var(--border)",
                }}
              />
            )}
            <span
              className="relative w-8 h-8 rounded-full flex items-center justify-center text-[12px]"
              style={{
                background: done ? "var(--primary)" : current ? "var(--primary-light)" : "var(--card)",
                color: done ? "#fff" : color,
                border: `2px solid ${done || current ? "var(--primary)" : "var(--border)"}`,
              }}
            >
              <i className={`fas ${done ? "fa-check" : icon}`} aria-hidden />
            </span>
            <span className="text-[11px] mt-1.5 font-semibold" style={{ color: current ? "var(--text)" : "var(--muted)" }}>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
