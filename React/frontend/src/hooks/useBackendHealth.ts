import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/services/api/apiClient";

/**
 * Is the FuelMart backend answering, right now?
 *
 * One source of truth for every part of the app that shows connection state
 * (the status chip, the offline banner), so they cannot disagree and the
 * server is not pinged twice for the same question.
 *
 * "Reachable" means the server replied AT ALL -- a 401 or a 404 is a reply,
 * and proves it is there. Only a transport failure (no response) counts as
 * down, which is exactly the difference between "the backend is off" and
 * "you are not signed in".
 */
export interface BackendHealth {
  /** The device has a network connection (navigator.onLine). */
  online: boolean;
  /** The backend answered the last check. */
  reachable: boolean;
  /** A check is in flight. */
  checking: boolean;
  /**
   * A check has finished at least once. Until it has, nothing is known --
   * and claiming "connected" before asking is exactly the wrong answer to
   * show on a status chip.
   */
  checked: boolean;
  /** When the last successful reply arrived. */
  lastOkAt: Date | null;
  /** Check now (the Retry button). */
  check: () => Promise<boolean>;
}

const POLL_MS = 15000;

export function useBackendHealth(): BackendHealth {
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [reachable, setReachable] = useState(false);
  const [checked, setChecked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [lastOkAt, setLastOkAt] = useState<Date | null>(null);

  const ping = useCallback(async (): Promise<boolean> => {
    try {
      await apiClient.get("/health", { timeout: 6000 });
      return true;
    } catch (err) {
      return Boolean((err as { response?: unknown }).response);
    }
  }, []);

  const check = useCallback(async (): Promise<boolean> => {
    setChecking(true);
    const ok = await ping();
    setReachable(ok);
    setChecked(true);
    if (ok) setLastOkAt(new Date());
    setChecking(false);
    return ok;
  }, [ping]);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      const ok = await ping();
      if (!alive) return;
      setReachable(ok);
      setChecked(true);
      if (ok) setLastOkAt(new Date());
    };

    const goOnline = () => {
      setOnline(true);
      void run(); // the network is back: find out whether the server is too
    };
    const goOffline = () => {
      setOnline(false);
      setReachable(false);
      setChecked(true);
    };

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    void run();
    const timer = window.setInterval(() => {
      if (navigator.onLine !== false) void run();
    }, POLL_MS);

    return () => {
      alive = false;
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      window.clearInterval(timer);
    };
  }, [ping]);

  return { online, reachable, checking, checked, lastOkAt, check };
}
