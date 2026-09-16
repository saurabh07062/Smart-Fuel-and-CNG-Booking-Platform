import { io, type Socket } from "socket.io-client";
import { refreshSession } from "@/services/api/apiClient";

/**
 * One Socket.IO connection for the whole application.
 *
 * A module-level singleton rather than a value in React state, because React
 * 18 StrictMode mounts every component twice in development -- a connection
 * created in an effect would open, close and reopen, and the duplicate
 * listeners that causes are the single most common bug in a socket migration.
 *
 * The handshake carries the httpOnly session cookie
 * (backend/src/services/notification/realtime.js), so changing identity --
 * login, logout -- means reconnecting (store/authStore.ts), not re-emitting.
 */

let socket: Socket | null = null;
let everConnected = false;

/** Callbacks run after each RE-connect, to refetch a fresh baseline. */
const resyncFns = new Set<() => void>();
/**
 * Station rooms this client follows, with how many mounted components want
 * each. Reference-counted: two screens can watch the same station (a list and
 * the booking beside it), and one unmounting must not leave the room for the
 * other. Re-joined after a reconnect.
 */
const watched = new Map<string, number>();
/** Connection-state subscribers (for the "Reconnecting…" indicator). */
const statusFns = new Set<(connected: boolean) => void>();

type AnyHandler = (...args: unknown[]) => void;

/**
 * Every event subscription, independent of any one socket instance.
 *
 * Subscriptions belong to mounted components; sockets come and go (login,
 * logout, role switch each replace the connection, because the server only
 * reads the session cookie during the handshake). Without this registry a handler was
 * attached to whichever socket existed when its component mounted -- so the
 * app-wide handlers in useRealtimeSync, mounted at App start on the
 * anonymous /login socket, were wiped by login and never reached the
 * authenticated socket. After a normal sign-in a customer got no live prices,
 * booking updates or notifications until a reload.
 *
 * The Vanilla client kept exactly this (RT.handlers, re-attached in
 * rtConnect()); the first React port dropped it. Found in Phase 12 testing.
 */
const handlers = new Map<string, Set<AnyHandler>>();

function attachAll(target: Socket) {
  handlers.forEach((set, event) => set.forEach((fn) => target.on(event, fn)));
}

export function getSocket(): Socket {
  // Identity changes (login / logout) replace the connection explicitly
  // (store/authStore.ts): the session cookie is only read during the handshake.
  if (socket) return socket;

  socket = io({
    // Same origin: Vite proxies /socket.io in dev (ws: true), and in
    // production the app is served from the backend's origin. The browser
    // sends the httpOnly session cookie with the handshake by itself.
    withCredentials: true,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 8000,
  });

  // Dev-only handle, so the duplicate-listener and room checks this migration
  // has to prove can actually be inspected from the console. Stripped from
  // the production bundle by the DEV guard.
  if (import.meta.env.DEV) {
    (window as unknown as { __fmSocket?: Socket }).__fmSocket = socket;
  }

  socket.on("connect", () => {
    statusFns.forEach((fn) => fn(true));

    // Rooms live on the server side of a socket, so a reconnect starts in
    // none of them.
    watched.forEach((_count, id) => socket?.emit("watch_station", id));

    // Events that happened while disconnected are gone -- socket.io does not
    // replay. Only on a RE-connect; the first connect is covered by each
    // page's own initial fetch.
    if (everConnected) resyncFns.forEach((fn) => fn());
    everConnected = true;
  });

  socket.on("disconnect", (reason) => {
    statusFns.forEach((fn) => fn(false));
    // The server dropped us deliberately; socket.io will not retry by itself.
    if (reason === "io server disconnect") socket?.connect();
  });

  socket.on("connect_error", () => statusFns.forEach((fn) => fn(false)));

  // The access cookie lasts 15 minutes. Renew it while a dropped connection
  // retries, so a signed-in user does not come back as an anonymous socket
  // and miss their own events. (A no-op when signed out; shared with any
  // refresh already in flight.)
  socket.io.on("reconnect_attempt", () => {
    void refreshSession();
  });

  // Every live subscription follows the connection onto the new socket.
  attachAll(socket);

  return socket;
}

/**
 * Drop the current connection. The subscription registry is deliberately
 * kept: the components that registered those handlers are still mounted, and
 * the next getSocket() re-attaches them.
 */
export function disconnectSocket() {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  everConnected = false;
}

/** Subscribe. Returns the unsubscribe function a useEffect should return. */
export function onSocket<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): () => void {
  const fn = handler as AnyHandler;
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  // Registering the same function twice is a no-op, as rtOn() was, so a
  // re-render cannot accumulate a duplicate subscription.
  if (!set.has(fn)) {
    set.add(fn);
    // getSocket() attaches the whole registry when it creates a socket, so
    // only an already-existing socket needs this one attached by hand.
    const existing = socket;
    const current = getSocket();
    if (existing === current) current.on(event, fn);
  }

  return () => {
    const s2 = handlers.get(event);
    if (!s2 || !s2.delete(fn)) return;
    if (s2.size === 0) handlers.delete(event);
    // Off the CURRENT socket -- the one this handler was attached to may
    // since have been replaced by a login or logout.
    socket?.off(event, fn);
  };
}

export function watchStation(stationId: string) {
  if (!stationId) return;
  const count = watched.get(stationId) ?? 0;
  watched.set(stationId, count + 1);
  if (count === 0) getSocket().emit("watch_station", stationId);
}

export function unwatchStation(stationId: string) {
  const count = watched.get(stationId);
  if (!count) return;
  if (count > 1) {
    watched.set(stationId, count - 1);
    return;
  }
  watched.delete(stationId);
  socket?.emit("unwatch_station", stationId);
}

export function onResync(fn: () => void): () => void {
  resyncFns.add(fn);
  return () => resyncFns.delete(fn);
}

export function onConnectionChange(fn: (connected: boolean) => void): () => void {
  statusFns.add(fn);
  fn(socket?.connected ?? false);
  return () => statusFns.delete(fn);
}

export function isConnected(): boolean {
  return socket?.connected ?? false;
}

/**
 * True when `incoming` is at least as new as what is already held.
 *
 * A resync can race the events that follow it, so a stale payload can arrive
 * after fresher data is on screen. Comparing the server's own timestamp is
 * what stops the older one winning.
 */
export function isNewer(
  incoming: Record<string, unknown> | null | undefined,
  existing: Record<string, unknown> | null | undefined,
  field = "updatedAt",
): boolean {
  if (!existing || !incoming) return true;
  const a = incoming[field];
  const b = existing[field];
  if (!a || !b) return true;
  return new Date(a as string).getTime() >= new Date(b as string).getTime();
}
