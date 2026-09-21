import { useEffect, useState } from "react";
import type { Booking } from "@/types";
import { fallbackServiceSeconds } from "@/constants/booking";
import { serverNow } from "@/utils/serverClock";

export interface FuelingCountdown {
  /** Whole seconds left, never below 0. */
  remainingSec: number;
  totalSec: number;
  /** 0..1 of the fill done. */
  progress: number;
  finished: boolean;
  /** "00:34", "04:59". */
  label: string;
}

/**
 * Time left on a fill, for display only -- the SERVER completes the booking
 * (backend services/queue/serviceTimer.js) at fuelingStartTime +
 * serviceDurationSeconds.
 *
 * Recomputed from those two server values on every tick, against the server's
 * clock (utils/serverClock.ts), never counted down from a local number: a page
 * refresh, a reconnect, a backgrounded tab or a wrong device clock all show
 * the same remaining time, and the countdown cannot restart.
 */
export function useFuelingCountdown(
  booking: Pick<Booking, "fuelingStartTime" | "serviceDurationSeconds" | "fuelType">,
): FuelingCountdown {
  const startMs = booking.fuelingStartTime ? new Date(booking.fuelingStartTime).getTime() : null;
  const totalSec = booking.serviceDurationSeconds || fallbackServiceSeconds(booking.fuelType);
  const dueMs = startMs === null ? null : startMs + totalSec * 1000;

  const compute = () => (dueMs === null ? totalSec : Math.max(0, Math.ceil((dueMs - serverNow()) / 1000)));
  const [remainingSec, setRemainingSec] = useState(compute);

  useEffect(() => {
    const tick = () => setRemainingSec(compute());
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dueMs, totalSec]);

  const mm = String(Math.floor(remainingSec / 60)).padStart(2, "0");
  const ss = String(remainingSec % 60).padStart(2, "0");
  return {
    remainingSec,
    totalSec,
    progress: totalSec > 0 ? Math.min(1, Math.max(0, 1 - remainingSec / totalSec)) : 1,
    finished: remainingSec <= 0,
    label: `${mm}:${ss}`,
  };
}
