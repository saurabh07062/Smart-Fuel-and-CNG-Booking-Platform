/**
 * The server's clock, as seen from this browser.
 *
 * Fueling countdowns are computed from the server's fuelingStartTime and the
 * booking's serviceDurationSeconds. Subtracting the DEVICE's Date.now() from
 * that would be wrong on a phone whose clock is a minute off -- the timer
 * would show too much or too little time. The API client records how far the
 * device clock is from each response's Date header (apiClient.ts), and
 * serverNow() corrects for it.
 *
 * The Date header has one-second resolution, so offsets under two seconds are
 * treated as none: that is noise, not a wrong clock.
 */
let offsetMs = 0;

const NOISE_MS = 2000;

/** Record a server timestamp (an HTTP Date header) against the device clock. */
export function recordServerDate(dateHeader: string | null | undefined, receivedAt = Date.now()): void {
  if (!dateHeader) return;
  const server = Date.parse(dateHeader);
  if (!Number.isFinite(server)) return;
  const diff = server - receivedAt;
  offsetMs = Math.abs(diff) < NOISE_MS ? 0 : diff;
}

/** Milliseconds since the epoch on the server's clock. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/** Tests only. */
export function _resetServerClock(): void {
  offsetMs = 0;
}
