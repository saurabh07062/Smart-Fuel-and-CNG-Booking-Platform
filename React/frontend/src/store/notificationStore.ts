import { create } from "zustand";
import { fetchNotifications, type NotificationItem } from "@/services/api/customerApi";

export interface UiNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  time: string;
  read: boolean;
}

interface NotificationState {
  notifications: UiNotification[];
  panelOpen: boolean;

  load: () => Promise<void>;
  /** Prepend one, ignoring an id already held. */
  add: (n: UiNotification) => void;
  markAllRead: () => void;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  clear: () => void;
}

/** "2 hours ago" from a timestamp, matching the Vanilla `time` strings. */
function relativeTime(iso?: string): string {
  if (!iso) return "Just now";
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 60_000) return "Just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function fromApi(n: NotificationItem): UiNotification {
  return {
    id: String(n._id),
    type: n.type || "booking",
    title: n.title || "Notification",
    // The server's notification row calls its text `body` (models/Notification.js).
    message: n.body || n.message || "",
    time: relativeTime(n.createdAt),
    read: !!n.read,
  };
}

/**
 * Notifications -- Vanilla's `state.notifications` and the bell panel.
 *
 * The unread count is DERIVED from the list rather than kept as a separate
 * counter. The Vanilla code carried both `state.notifications` and
 * `state.unreadNotifications` and incremented the counter by hand in the
 * socket handler, so the badge and the panel could disagree; deriving it
 * means they cannot.
 */
export const useNotificationStore = create<NotificationState>((set) => ({
  notifications: [],
  panelOpen: false,

  /**
   * Fetch the server's list and MERGE it over what is held.
   *
   * Not a replace. Two things would be lost by one:
   *   - a notification the socket delivered since the last fetch but which
   *     the server has not yet persisted, and
   *   - the client-only completion notice, which has no server row at all.
   * A resync happens on every reconnect, so a replace would quietly drop
   * whichever of those arrived in between.
   *
   * The server's copy wins for any id present in both, since it carries the
   * authoritative read state.
   */
  load: async () => {
    try {
      const items = await fetchNotifications();
      set((s) => {
        const fresh = items.map(fromApi);
        const serverIds = new Set(fresh.map((n) => n.id));
        const clientOnly = s.notifications.filter((n) => !serverIds.has(n.id));
        return { notifications: [...clientOnly, ...fresh] };
      });
    } catch {
      // Notifications are supplementary; a failure here must not take a page
      // down or replace a list the user is already reading.
    }
  },

  add: (n) =>
    set((s) =>
      // The completion notice can be raised by both the socket event and the
      // countdown's fallback poll, so the id guard is what keeps it to one.
      s.notifications.some((x) => x.id === n.id)
        ? s
        : { notifications: [n, ...s.notifications] },
    ),

  markAllRead: () =>
    set((s) => ({ notifications: s.notifications.map((n) => ({ ...n, read: true })) })),

  setPanelOpen: (panelOpen) => set({ panelOpen }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  clear: () => set({ notifications: [], panelOpen: false }),
}));

/** Derived, never stored -- see the note on the store above. */
export const selectUnreadCount = (s: NotificationState) =>
  s.notifications.filter((n) => !n.read).length;
