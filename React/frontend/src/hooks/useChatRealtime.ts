import { useEffect } from "react";
import { useResync, useSocketEvent } from "./useSocket";
import { SOCKET_EVENTS } from "@/services/socket/socketEvents";
import { useChatStore } from "@/store/chatStore";
import { useAuthStore } from "@/store/authStore";
import type { ChatMessage, ConversationStatus } from "@/services/api/chatApi";

/**
 * Keep chat live, without duplicates and without holes.
 *
 * The socket carries the message itself, so an open thread updates the instant
 * it is sent -- but the socket is never the only source: every reconnect
 * refetches the unread count and the thread list (useResync), because events
 * that happened while the tab was disconnected are gone and a client that
 * trusted the socket alone would show a thread frozen at the last message it
 * happened to be awake for.
 *
 * Duplicates are handled in the store (chatStore.receive merges by server id
 * and settles a pending bubble by its clientId), which is where they have to
 * be: the same message legitimately arrives both as the POST response and as
 * this event.
 *
 * Mount this once per signed-in shell -- the customer layout, the vendor
 * console, the admin console.
 */
export function useChatRealtime() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const receive = useChatStore((s) => s.receive);
  const touch = useChatStore((s) => s.touchConversation);
  const loadUnread = useChatStore((s) => s.loadUnread);

  // The badge's first value. After this the events and the resync keep it true.
  useEffect(() => {
    if (isAuthenticated) void loadUnread();
  }, [isAuthenticated, loadUnread]);

  useSocketEvent<{ conversationId: string; message: ChatMessage; status?: ConversationStatus; unread?: Record<string, number> }>(
    SOCKET_EVENTS.CHAT_MESSAGE,
    (payload) => {
      if (!payload?.conversationId || !payload?.message) return;
      receive(payload);
    },
    [receive],
  );

  useSocketEvent<{ conversationId: string; status?: ConversationStatus }>(
    SOCKET_EVENTS.CHAT_CONVERSATION,
    (payload) => {
      if (!payload?.conversationId) return;
      touch(payload);
    },
    [touch],
  );

  // Another tab (or the other side) read the thread: the badge follows.
  useSocketEvent<{ conversationId: string }>(SOCKET_EVENTS.CHAT_READ, () => void loadUnread(), [loadUnread]);

  useResync(() => {
    if (!useAuthStore.getState().isAuthenticated) return;
    const state = useChatStore.getState();
    void state.loadUnread();
    // Only what is actually on screen is refetched: a reconnect must not pull
    // three panels the user is not looking at.
    if (state.conversations) void state.loadConversations();
    if (state.activeId) void state.openThread(state.activeId);
  }, [isAuthenticated]);
}
