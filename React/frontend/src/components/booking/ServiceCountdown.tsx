import { useEffect, useState } from "react";
import type { Booking } from "@/types";
import { fallbackServiceSeconds } from "@/constants/booking";
import { useBookingStore } from "@/store/bookingStore";

interface Props {
  booking: Booking;
}

/**
 * The live countdown shown while a booking is "serving".
 *
 * THIS DOES NOT COMPLETE THE BOOKING. backend/src/services/booking/bookingSweep.js's
 * sweepInProgressBookings is the sole authority: it polls every 5s and flips
 * the booking to "completed" once fuelingStartTime + serviceDurationSeconds
 * has elapsed. This component only *displays* the countdown to that event.
 *
 * Because the remaining time is recomputed from the server's own
 * fuelingStartTime on every tick -- never decremented from a local counter --
 * it stays correct across a refresh, a backgrounded tab, or a slow frame, and
 * it can never show 00:00 before the backend would actually be allowed to
 * complete the booking.
 *
 * Durations come from the booking's serviceDurationSeconds, which the server
 * stamps from backend/config/fuelDurations.js (CNG 300s, petrol/diesel 40s).
 * The client-side fallback is only for older documents that predate the field.
 */
export default function ServiceCountdown({ booking }: Props) {
  const loadBookings = useBookingStore((s) => s.load);

  const startMs = booking.fuelingStartTime
    ? new Date(booking.fuelingStartTime).getTime()
    : Date.now();
  const durationSec = booking.serviceDurationSeconds || fallbackServiceSeconds(booking.fuelType);
  const dueMs = startMs + durationSec * 1000;

  const [remainingSec, setRemainingSec] = useState(() =>
    Math.max(0, Math.ceil((dueMs - Date.now()) / 1000)),
  );

  useEffect(() => {
    const tick = () => setRemainingSec(Math.max(0, Math.ceil((dueMs - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [dueMs]);

  /**
   * Safety net, matching the Vanilla poll.
   *
   * The booking:updated socket event normally refetches within milliseconds
   * of the sweep completing the booking. This 2s poll only starts once the
   * countdown has actually run out, and covers the case where that event was
   * missed (a brief disconnect). It stops as soon as the status is no longer
   * "serving", because this component unmounts with the card.
   */
  useEffect(() => {
    if (remainingSec > 0) return;
    const id = window.setInterval(() => void loadBookings(), 2000);
    return () => window.clearInterval(id);
  }, [remainingSec > 0, loadBookings]);

  const mm = String(Math.floor(remainingSec / 60)).padStart(2, "0");
  const ss = String(remainingSec % 60).padStart(2, "0");
  const finished = remainingSec <= 0;

  return (
    <>
      <div className="text-center mb-6" style={{ animation: "slideUp .4s ease" }}>
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-3"
          style={{ background: "var(--status-warn-bg)", border: "1px solid var(--status-warn)" }}
        >
          <i
            className="fas fa-gas-pump text-3xl"
            style={{ color: "var(--status-warn)", animation: "pulse 1.6s ease-in-out infinite" }}
            aria-hidden
          />
        </div>
        <h1
          className="text-2xl font-bold"
          style={{ fontFamily: "'Space Grotesk'", color: "var(--text)" }}
        >
          {finished ? "Finalizing your service..." : `${booking.fuelType} Service In Progress`}
        </h1>
        <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
          Sit tight — your vehicle is being fueled at the nozzle right now.
        </p>
      </div>

      <div
        className="card p-6 mb-5 text-center"
        style={{ animation: "slideUp .5s ease", borderColor: "var(--status-warn)" }}
      >
        <p className="text-[11px] font-bold uppercase tracking-widest mb-2" style={{ color: "var(--muted)" }}>
          Time Remaining
        </p>
        <p
          className="text-5xl font-bold tracking-tight font-mono"
          style={{ color: "var(--status-warn)" }}
          role="timer"
          aria-live="off"
        >
          {mm}:{ss}
        </p>
        <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>
          This updates live from the station&apos;s system — no need to refresh.
        </p>
      </div>
    </>
  );
}
