import { useEffect } from "react";
import type { Booking } from "@/types";
import { useBookingStore } from "@/store/bookingStore";
import { useFuelingCountdown } from "@/hooks/useFuelingCountdown";

interface Props {
  booking: Booking;
}

/**
 * The live countdown shown while a booking is "serving".
 *
 * THIS DOES NOT COMPLETE THE BOOKING. The server does, at exactly
 * fuelingStartTime + serviceDurationSeconds (backend services/queue/serviceTimer.js,
 * with the in-progress sweep as a backstop), then sends booking:completed and
 * this page switches to the completed view.
 *
 * The remaining time is recomputed from the server's own values against the
 * server's clock on every tick (hooks/useFuelingCountdown.ts), so a refresh, a
 * reconnect or a wrong phone clock cannot restart or skew it.
 *
 * Durations are stamped by the server (backend config/fuelDurations.js):
 * Petrol/Diesel 40 seconds, CNG 5 minutes.
 */
export default function ServiceCountdown({ booking }: Props) {
  const loadBookings = useBookingStore((s) => s.load);
  const { remainingSec, label, progress, finished } = useFuelingCountdown(booking);

  /**
   * Safety net, matching the Vanilla poll.
   *
   * The booking:updated socket event normally refetches within milliseconds
   * of the sweep completing the booking. This 2s poll only starts once the
   * countdown has actually run out, and covers the case where that event was
   * missed (a brief disconnect). It stops as soon as the status is no longer
   * "serving", because this component unmounts with the card.
   */
  const timeLeft = remainingSec > 0;
  useEffect(() => {
    if (timeLeft) return;
    const id = window.setInterval(() => void loadBookings(), 2000);
    return () => window.clearInterval(id);
  }, [timeLeft, loadBookings]);


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
          {label}
        </p>
        <div
          className="h-2 rounded-full mt-4 overflow-hidden"
          style={{ background: "var(--status-warn-bg)" }}
          role="progressbar"
          aria-label="Fueling progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${progress * 100}%`, background: "var(--status-warn)", transition: "width .25s linear" }}
          />
        </div>
        <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>
          {finished
            ? "Completing your booking now…"
            : "Fueling completes automatically — no need to refresh or press anything."}
        </p>
      </div>
    </>
  );
}
