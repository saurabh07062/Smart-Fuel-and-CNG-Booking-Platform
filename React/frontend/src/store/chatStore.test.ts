import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Phase 4 of the chat feature: the store that holds it.
 *
 * What is checked here is the part a screenshot would never reveal: that one
 * message cannot appear twice. A sent message arrives as the POST response AND
 * as the socket event announcing it, and a retry after a dropped connection can
 * bring it a third time -- so the merge is by server id, and a pending bubble is
 * matched to the stored message by the clientId the client generated.
 *
 * Also: a failed send stays visibly failed rather than pretending to have
 * arrived, and a retry reuses the same clientId so the server can recognise it.
 */

vi.mock("@/services/api/chatApi", () => ({
  fetchChatContext: vi.fn(),
  askAssistant: vi.fn(),
  fetchConversations: vi.fn(async () => ({ conversations: [], total: 0, page: 1, pages: 1, perPage: 25 })),
  fetchUnread: vi.fn(async () => ({ threads: 0, messages: 0, side: "customer" })),
  fetchThread: vi.fn(),
  openConversation: vi.fn(),
  sendChatMessage: vi.fn(),
  markConversationRead: vi.fn(),
  setConversationStatus: vi.fn(),
}));

import * as api from "@/services/api/chatApi";
import type { ChatMessage } from "@/services/api/chatApi";
import { useChatStore } from "./chatStore";
import { useAuthStore } from "./authStore";

const CONVERSATION = "conv1";

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: "m1",
  conversationId: CONVERSATION,
  senderId: "u1",
  senderRole: "customer",
  senderName: "Customer",
  kind: "text",
  body: "Hello",
  context: null,
  clientId: null,
  readBy: [],
  createdAt: new Date("2026-01-01T10:00:00Z").toISOString(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: "u1", role: "customer" } as never, isAuthenticated: true });
  useChatStore.getState().reset();
  useChatStore.setState({ activeId: CONVERSATION, activeConversation: null, messages: [], pending: [] });
});

describe("a message is never shown twice", () => {
  it("the POST response and the socket event are one message", async () => {
    const stored = message({ messageId: "m9", clientId: "c-1", body: "Where is my booking?" });
    vi.mocked(api.sendChatMessage).mockResolvedValue({ message: stored, duplicate: false });

    await useChatStore.getState().send("Where is my booking?");
    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().pending).toHaveLength(0);

    // The same message now arrives over the socket.
    useChatStore.getState().receive({ conversationId: CONVERSATION, message: stored });
    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().messages[0].messageId).toBe("m9");
  });

  it("the socket event arriving FIRST still leaves one message", async () => {
    const stored = message({ messageId: "m10", clientId: "c-2", body: "Racing" });
    let resolveSend: (v: { message: ChatMessage; duplicate: boolean }) => void = () => {};
    vi.mocked(api.sendChatMessage).mockReturnValue(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );

    const sending = useChatStore.getState().send("Racing");
    expect(useChatStore.getState().pending).toHaveLength(1);
    const { clientId } = useChatStore.getState().pending[0];

    // The server announced it before the POST came back.
    useChatStore.getState().receive({ conversationId: CONVERSATION, message: { ...stored, clientId } });
    expect(useChatStore.getState().pending).toHaveLength(0);
    expect(useChatStore.getState().messages).toHaveLength(1);

    resolveSend({ message: { ...stored, clientId }, duplicate: false });
    await sending;
    expect(useChatStore.getState().messages).toHaveLength(1);
  });

  it("messages stay in time order however they arrive", () => {
    const later = message({ messageId: "m2", createdAt: new Date("2026-01-01T10:05:00Z").toISOString(), body: "Second" });
    const earlier = message({ messageId: "m1", createdAt: new Date("2026-01-01T10:00:00Z").toISOString(), body: "First" });
    useChatStore.getState().receive({ conversationId: CONVERSATION, message: later });
    useChatStore.getState().receive({ conversationId: CONVERSATION, message: earlier });
    expect(useChatStore.getState().messages.map((m) => m.body)).toEqual(["First", "Second"]);
  });
});

describe("a send that fails says so", () => {
  it("the bubble is marked failed, not quietly dropped or shown as sent", async () => {
    vi.mocked(api.sendChatMessage).mockRejectedValue({ response: { data: { msg: "Network is down." } } });

    const ok = await useChatStore.getState().send("Please reply");
    expect(ok).toBe(false);
    const state = useChatStore.getState();
    expect(state.messages).toHaveLength(0);
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0].status).toBe("failed");
    expect(state.threadError).toBe("Network is down.");
  });

  it("a retry reuses the same clientId, so the server can recognise it", async () => {
    vi.mocked(api.sendChatMessage).mockRejectedValueOnce({ response: { data: { msg: "Offline" } } });
    await useChatStore.getState().send("Try me");
    const { clientId } = useChatStore.getState().pending[0];

    const stored = message({ messageId: "m11", clientId, body: "Try me" });
    vi.mocked(api.sendChatMessage).mockResolvedValue({ message: stored, duplicate: true });

    const ok = await useChatStore.getState().retry(clientId);
    expect(ok).toBe(true);
    expect(vi.mocked(api.sendChatMessage).mock.calls[1][1]).toEqual({ body: "Try me", clientId });
    expect(useChatStore.getState().pending).toHaveLength(0);
    expect(useChatStore.getState().messages).toHaveLength(1);
  });

  it("an empty message is not sent at all", async () => {
    expect(await useChatStore.getState().send("   ")).toBe(false);
    expect(api.sendChatMessage).not.toHaveBeenCalled();
  });
});

describe("unread counts follow the server, not a local guess", () => {
  it("a message in another thread raises that row's count; my own does not", () => {
    useChatStore.setState({
      activeId: null,
      conversations: [
        { conversationId: "other", unread: 0 } as never,
        { conversationId: CONVERSATION, unread: 0 } as never,
      ],
    });

    useChatStore.getState().receive({
      conversationId: "other",
      message: message({ messageId: "m20", conversationId: "other", senderId: "admin1", senderRole: "admin" }),
    });
    expect(useChatStore.getState().conversations?.find((c) => c.conversationId === "other")?.unread).toBe(1);

    // A message I sent myself is not unread for me.
    useChatStore.getState().receive({
      conversationId: CONVERSATION,
      message: message({ messageId: "m21", senderId: "u1" }),
    });
    expect(useChatStore.getState().conversations?.find((c) => c.conversationId === CONVERSATION)?.unread).toBe(0);
  });

  it("nothing is requested for a signed-out visitor", async () => {
    useAuthStore.setState({ user: null, isAuthenticated: false });
    await useChatStore.getState().loadUnread();
    await useChatStore.getState().loadContext();
    await useChatStore.getState().loadConversations();
    expect(api.fetchUnread).not.toHaveBeenCalled();
    expect(api.fetchChatContext).not.toHaveBeenCalled();
    expect(api.fetchConversations).not.toHaveBeenCalled();
  });
});

describe("the assistant's answer refreshes the context it came with", () => {
  it("an answer carries the live context, so the summary card cannot go stale", async () => {
    const context = { role: "customer", greeting: "hi", quickActions: [], support: null } as never;
    vi.mocked(api.askAssistant).mockResolvedValue({ intent: "booking_where", understood: true, answer: "…", context });

    const answer = await useChatStore.getState().ask({ intent: "booking_where" });
    expect(answer?.intent).toBe("booking_where");
    expect(useChatStore.getState().context).toBe(context);
  });

  it("a failed question leaves a message, not a blank panel", async () => {
    vi.mocked(api.askAssistant).mockRejectedValue({ response: { data: { msg: "Assistant unavailable." } } });
    expect(await useChatStore.getState().ask({ question: "hello" })).toBeNull();
    expect(useChatStore.getState().contextError).toBe("Assistant unavailable.");
  });
});
