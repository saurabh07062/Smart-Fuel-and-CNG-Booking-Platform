/**
 * Wrap an async refresh so a burst of events costs at most two requests.
 *
 * One business change arrives as several socket events (a booking brings
 * booking:created, queue:updated and slot:updated together). Calling the
 * returned function while a refresh is already in flight does not start a
 * second one: it marks the data dirty, and exactly one more refresh runs when
 * the current one finishes -- so the last event is never missed and nothing
 * is fetched in parallel. No timers, no debounce delay.
 *
 * A failed refresh is swallowed: a live update must never replace what is on
 * screen with an error. The next event or reconnect resync tries again.
 */
export function coalesce(task: () => Promise<unknown>): () => void {
  let running = false;
  let again = false;

  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        try {
          await task();
        } catch {
          /* keep what is on screen */
        }
      } while (again);
    } finally {
      running = false;
    }
  };

  return () => void run();
}
