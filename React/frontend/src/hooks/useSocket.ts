import { useEffect } from "react";
import {
  getSocket,
  onSocket,
  onResync,
  onConnectionChange,
  watchStation,
  unwatchStation,
} from "@/services/socket/socket";
import { useRealtimeStore } from "@/store/realtimeStore";

/**
 * Open the connection and mirror its state into the store.
 * Mounted once, at the App root.
 */
export function useSocketConnection() {
  const setConnected = useRealtimeStore((s) => s.setConnected);
  useEffect(() => {
    getSocket();
    return onConnectionChange(setConnected);
  }, [setConnected]);
}

/**
 * Subscribe to one event for the lifetime of a component.
 *
 * The returned unsubscribe is what prevents the duplicate-listener bug: React
 * 18 StrictMode mounts effects twice in development, so a subscription
 * without cleanup fires every handler twice and would, for instance, add two
 * bookings for one event.
 */
export function useSocketEvent<T = unknown>(
  event: string,
  handler: (payload: T) => void,
  deps: unknown[] = [],
) {
  useEffect(() => {
    return onSocket<T>(event, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, ...deps]);
}

/** Refetch a fresh baseline over HTTP after every reconnect. */
export function useResync(fn: () => void, deps: unknown[] = []) {
  useEffect(() => {
    return onResync(fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Follow one station's live price, availability and queue while mounted. */
export function useWatchStation(stationId?: string | null) {
  useEffect(() => {
    if (!stationId) return;
    watchStation(stationId);
    return () => unwatchStation(stationId);
  }, [stationId]);
}

/**
 * The server refuses a socket more than 25 station rooms
 * (backend/src/services/notification/realtime.js, MAX_WATCHED). Honouring that here means the
 * 26th station is dropped deliberately and visibly, rather than the server
 * silently ignoring the emit.
 */
export const MAX_WATCHED_STATIONS = 25;

/**
 * Follow every station currently on screen.
 *
 * This is what makes a vendor's price change reach a customer browsing the
 * list -- price, availability and queue events are emitted to `station:<id>`,
 * and a socket receives them only if it has joined that room.
 *
 * Worth stating plainly: the Vanilla app defined rtWatchStation() and never
 * called it from anywhere, so no customer ever joined a station room and live
 * price updates never actually reached the browse or detail pages. This hook
 * is the missing call, not a new mechanism -- the events, rooms and server
 * code are unchanged.
 */
export function useWatchStations(stationIds: string[]) {
  // Sorted and joined so the effect re-runs when the SET changes, not when
  // the array identity does -- a re-render producing an equal list must not
  // churn every room membership.
  const key = stationIds.slice(0, MAX_WATCHED_STATIONS).sort().join(",");

  useEffect(() => {
    if (!key) return;
    const ids = key.split(",");
    ids.forEach(watchStation);
    return () => ids.forEach(unwatchStation);
  }, [key]);
}
