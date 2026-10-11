import { create } from "zustand";
import * as api from "@/services/api/chatApi";
import type {
  ChatContext,
  ChatMessage,
  ConversationFilters,
  ConversationRow,
  ConversationStatus,
} from "@/services/api/chatApi";
import { useAuthStore } from "./authStore";

/**
 * Support chat and the assistant, for whichever role is signed in.
 *
 * THE THREE THINGS THIS STORE IS CAREFUL ABOUT
 *
 * 1. No duplicates. A message can arrive twice -- once as the reply to the POST
 *    that sent it, once as the socket event announcing it -- and a resend after
 *    a dropped connection can bring it a third time. Every message is keyed by
 *    its server id, and a pending bubble is matched to the stored message by
 *    the `clientId` the client generated, so the optimistic copy is REPLACED
 *    rather than joined by a second one.
 *
 * 2. Nothing is invented. The unread counts, the statuses and the message list
 *    come from the server. A send that fails leaves its bubble marked failed
 *    instead of pretending it arrived.
 *
 * 3. Reconnects are safe. The socket only says "something happened"; the
 *    baseline is always refetched over HTTP (useChatRealtime), so a gap while
 *    disconnected heals instead of leaving a hole in the thread.
 */

/** A message that is on its way. `status` is what the tick shows. */
export interface PendingMessage {
  clientId: string;
  body: string;
  createdAt: string;
  status: "sending" | "failed";
}

interface ChatState {
  /** The assistant's view of this user right now; null until loaded. */
  context: ChatContext | null;
  contextError: string | null;
  contextLoading: boolean;

  /** null = not loaded yet, [] = loaded and empty (the distinction the UI needs). */
  conversations: ConversationRow[] | null;
  conversationsLoading: boolean;
  conversationsError: string | null;
  filters: ConversationFilters;
  pages: number;

  /** The open thread. */
  activeId: string | null;
  activeConversation: ConversationRow | null;
  messages: ChatMessage[];
  threadLoading: boolean;
  threadError: string | null;
  hasMore: boolean;
  pending: PendingMessage[];

  /** Threads and messages waiting for this user (the badge). */
  unread: { threads: number; messages: number } | null;

  /** Is the widget open, and on which panel. */
  open: boolean;
  panel: "assistant" | "conversations" | "thread";

  loadContext: () => Promise<void>;
  ask: (input: { question?: string; intent?: string }) => Promise<api.ChatAnswer | null>;
  loadConversations: (filters?: ConversationFilters) => Promise<void>;
  loadUnread: () => Promise<void>;
  openThread: (conversationId: string) => Promise<void>;
  startThread: (input: { with: "admin" | "vendor"; bookingId?: string; subject?: string; topic?: string; message?: string }) => Promise<string | null>;
  send: (body: string) => Promise<boolean>;
  retry: (clientId: string) => Promise<boolean>;
  setStatus: (status: ConversationStatus) => Promise<void>;
  /** A live message from the socket, for any thread. */
  receive: (payload: { conversationId: string; message: ChatMessage; status?: ConversationStatus; unread?: Record<string, number> }) => void;
  /** A thread was opened or changed elsewhere. */
  touchConversation: (payload: { conversationId: string; status?: ConversationStatus }) => void;
  setOpen: (open: boolean) => void;
  setPanel: (panel: ChatState["panel"]) => void;
  closeThread: () => void;
  reset: () => void;
}

/** A short, unique id for one outgoing message. */
function newClientId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `c-${Date.now().toString(36)}-${random.slice(0, 8)}`;
}

/** The message list with `incoming` merged in, by server id, in time order. */
function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(existing.map((m) => [m.messageId, m]));
  for (const m of incoming) byId.set(m.messageId, m);
  return [...byId.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

const errorOf = (err: unknown, fallback: string) => {
  const res = (err as { response?: { data?: { msg?: string } } })?.response;
  return res?.data?.msg || fallback;
};

export const useChatStore = create<ChatState>((set, get) => ({
  context: null,
  contextError: null,
  contextLoading: false,

  conversations: null,
  conversationsLoading: false,
  conversationsError: null,
  filters: {},
  pages: 1,

  activeId: null,
  activeConversation: null,
  messages: [],
  threadLoading: false,
  threadError: null,
  hasMore: false,
  pending: [],

  unread: null,

  open: false,
  panel: "assistant",

  loadContext: async () => {
    if (!useAuthStore.getState().isAuthenticated) return;
    set({ contextLoading: true, contextError: null });
    try {
      set({ context: await api.fetchChatContext(), contextLoading: false });
    } catch (err) {
      // The assistant says it could not read rather than showing a blank card.
      set({ contextLoading: false, contextError: errorOf(err, "Could not read your current details.") });
    }
  },

  ask: async (input) => {
    try {
      const answer = await api.askAssistant(input);
      // Every answer carries a fresh context, so the summary card the customer
      // is looking at updates with the reply instead of going stale.
      set({ context: answer.context, contextError: null });
      return answer;
    } catch (err) {
      set({ contextError: errorOf(err, "The assistant could not answer just now.") });
      return null;
    }
  },

  loadConversations: async (filters) => {
    if (!useAuthStore.getState().isAuthenticated) return;
    const next = filters ? { ...get().filters, ...filters } : get().filters;
    set({ conversationsLoading: true, conversationsError: null, filters: next });
    try {
      const page = await api.fetchConversations(next);
      set({ conversations: page.conversations, pages: page.pages, conversationsLoading: false });
    } catch (err) {
      set({ conversationsLoading: false, conversationsError: errorOf(err, "Could not load your conversations.") });
    }
  },

  loadUnread: async () => {
    if (!useAuthStore.getState().isAuthenticated) return;
    try {
      const summary = await api.fetchUnread();
      set({ unread: { threads: summary.threads, messages: summary.messages } });
    } catch {
      // The badge is supplementary: a failure must not break the page it is on.
    }
  },

  openThread: async (conversationId) => {
    set({ activeId: conversationId, panel: "thread", threadLoading: true, threadError: null, messages: [], pending: [] });
    try {
      const thread = await api.fetchThread(conversationId);
      set({
        activeConversation: thread.conversation,
        messages: thread.messages,
        hasMore: thread.hasMore,
        threadLoading: false,
      });
      // Reading it clears this side's count on the server; mirror that locally
      // and in the list, so the badge does not lag behind the screen.
      set((s) => ({
        conversations: s.conversations?.map((c) => (c.conversationId === conversationId ? { ...c, unread: 0 } : c)) ?? null,
      }));
      void get().loadUnread();
    } catch (err) {
      set({ threadLoading: false, threadError: errorOf(err, "Could not load this conversation.") });
    }
  },

  startThread: async (input) => {
    set({ threadLoading: true, threadError: null, panel: "thread", messages: [], pending: [] });
    try {
      const thread = await api.openConversation(input);
      set({
        activeId: thread.conversation.conversationId,
        activeConversation: thread.conversation,
        messages: thread.messages,
        hasMore: thread.hasMore,
        threadLoading: false,
      });
      void get().loadConversations();
      void get().loadUnread();
      return thread.conversation.conversationId;
    } catch (err) {
      set({ threadLoading: false, threadError: errorOf(err, "Could not start the conversation.") });
      return null;
    }
  },

  send: async (body) => {
    const text = body.trim();
    const conversationId = get().activeId;
    if (!text || !conversationId) return false;

    const clientId = newClientId();
    // The bubble appears at once, marked as sending. It is replaced by the
    // stored message -- matched on clientId -- rather than added to.
    set((s) => ({ pending: [...s.pending, { clientId, body: text, createdAt: new Date().toISOString(), status: "sending" }] }));

    try {
      const { message } = await api.sendChatMessage(conversationId, { body: text, clientId });
      set((s) => ({
        messages: mergeMessages(s.messages, [message]),
        pending: s.pending.filter((p) => p.clientId !== clientId),
      }));
      return true;
    } catch (err) {
      set((s) => ({
        pending: s.pending.map((p) => (p.clientId === clientId ? { ...p, status: "failed" } : p)),
        threadError: errorOf(err, "Your message could not be sent."),
      }));
      return false;
    }
  },

  retry: async (clientId) => {
    const pending = get().pending.find((p) => p.clientId === clientId);
    const conversationId = get().activeId;
    if (!pending || !conversationId) return false;

    set((s) => ({
      pending: s.pending.map((p) => (p.clientId === clientId ? { ...p, status: "sending" } : p)),
      threadError: null,
    }));
    try {
      // The SAME clientId: if the first attempt did reach the server, this
      // comes back as that message rather than posting a second one.
      const { message } = await api.sendChatMessage(conversationId, { body: pending.body, clientId });
      set((s) => ({
        messages: mergeMessages(s.messages, [message]),
        pending: s.pending.filter((p) => p.clientId !== clientId),
      }));
      return true;
    } catch (err) {
      set((s) => ({
        pending: s.pending.map((p) => (p.clientId === clientId ? { ...p, status: "failed" } : p)),
        threadError: errorOf(err, "Your message could not be sent."),
      }));
      return false;
    }
  },

  setStatus: async (status) => {
    const conversationId = get().activeId;
    if (!conversationId) return;
    try {
      const { conversation } = await api.setConversationStatus(conversationId, status);
      set((s) => ({
        activeConversation: conversation,
        conversations: s.conversations?.map((c) => (c.conversationId === conversationId ? conversation : c)) ?? null,
      }));
      // The server writes a note in the thread saying who changed it; read the
      // thread again so both the note and the new status are on screen.
      void get().openThread(conversationId);
    } catch (err) {
      set({ threadError: errorOf(err, "Could not update this conversation.") });
    }
  },

  receive: ({ conversationId, message, status, unread }) => {
    const state = get();
    const isOpen = state.activeId === conversationId;

    set((s) => ({
      // Only the open thread's messages are held; another thread's message
      // updates its row in the list instead.
      messages: isOpen ? mergeMessages(s.messages, [message]) : s.messages,
      // My own message arriving by socket settles its pending bubble -- the
      // same clientId, so it can never appear twice.
      pending: message.clientId ? s.pending.filter((p) => p.clientId !== message.clientId) : s.pending,
      activeConversation:
        isOpen && s.activeConversation
          ? { ...s.activeConversation, status: status ?? s.activeConversation.status, lastMessage: { text: message.body, at: message.createdAt, senderRole: message.senderRole } }
          : s.activeConversation,
      conversations:
        s.conversations?.map((c) =>
          c.conversationId === conversationId
            ? {
                ...c,
                status: status ?? c.status,
                updatedAt: message.createdAt,
                lastMessage: { text: message.body, at: message.createdAt, senderRole: message.senderRole },
                // Mine, or a thread I am reading, is already read.
                unread: isOpen || message.senderId === useAuthStore.getState().user?.id ? 0 : (c.unread || 0) + 1,
                ...(unread ? { unreadBySide: unread as ConversationRow["unreadBySide"] } : {}),
              }
            : c,
        ) ?? null,
    }));

    // A message in a thread not in the loaded list (a brand-new one, or one on
    // another page) needs the list itself; and the badge is the server's figure.
    if (!state.conversations?.some((c) => c.conversationId === conversationId)) void get().loadConversations();
    if (!isOpen) void get().loadUnread();
  },

  touchConversation: ({ conversationId, status }) => {
    set((s) => ({
      conversations: s.conversations?.map((c) => (c.conversationId === conversationId && status ? { ...c, status } : c)) ?? null,
      activeConversation:
        s.activeConversation?.conversationId === conversationId && status
          ? { ...s.activeConversation, status }
          : s.activeConversation,
    }));
    void get().loadUnread();
  },

  setOpen: (open) => set({ open }),
  setPanel: (panel) => set({ panel }),
  closeThread: () => set({ activeId: null, activeConversation: null, messages: [], pending: [], threadError: null, panel: "conversations" }),

  reset: () =>
    set({
      context: null,
      contextError: null,
      conversations: null,
      conversationsError: null,
      filters: {},
      activeId: null,
      activeConversation: null,
      messages: [],
      pending: [],
      unread: null,
      open: false,
      panel: "assistant",
    }),
}));

/** Threads waiting for this user, derived from the server's figure. */
export const selectUnreadThreads = (s: ChatState) => s.unread?.threads ?? 0;
