import { useCallback, useState } from "react";
import BookingModeSheet, { type BookingModeTarget } from "@/components/booking/BookingModeSheet";

/**
 * "One vehicle or several?" for any screen that starts a booking.
 *
 * Returns the question's element and an `ask()` to open it. A caller keeps its
 * own Book button exactly where it was and swaps one line -- the navigate --
 * for `ask({...})`, so the station cards, the nearest-pump card, the station
 * page and the dashboard all pose the same question in the same words without
 * any of them owning it.
 *
 * Every route it can take already exists; this hook only decides which.
 */
export function useBookingMode() {
  const [target, setTarget] = useState<BookingModeTarget | null>(null);

  const ask = useCallback((next: BookingModeTarget) => setTarget(next), []);
  const close = useCallback(() => setTarget(null), []);

  return {
    ask,
    /** Render this once in the screen's tree. */
    sheet: <BookingModeSheet target={target} onClose={close} />,
  };
}
