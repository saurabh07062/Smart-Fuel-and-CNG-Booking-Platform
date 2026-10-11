import { useEffect, useRef, useState } from "react";
import { useChatStore } from "@/store/chatStore";
import { useAuthStore } from "@/store/authStore";
import type { ChatMessage } from "@/services/api/chatApi";

/**
 * One conversation: its messages, and the box to reply in.
 *
 * Shared by the customer widget, the vendor widget and the admin communication
 * centre, because a thread is the same object for all three -- only the
 * counterparty's name and the admin's status controls differ, and those are
 * passed in.
 *
 * WHAT THE TICKS MEAN
 *
 *   sending   the bubble exists locally and the POST is in flight
 *   failed    the send failed; the bubble stays, with a Retry that reuses the
 *             same clientId so the server recognises it rather than storing a
 *             second copy
 *   sent      the server has it (it is in `messages`, keyed by its server id)
 *   seen      the other side has read it
 *
 * Nothing here says "sent" before the server said so.
 */

/** A time a person reads, not an ISO string. */
function clock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

/** The day divider's label. */
function dayLabel(iso: string): string {
  const at = new Date(iso);
  const today = new Date();
  const sameDay = at.toDateString() === today.toDateString();
  if (sameDay) return "Today";
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (at.toDateString() === yesterday.toDateString()) return "Yesterday";
  return at.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default function ChatThread({
  /** Rendered above the messages -- the booking card, or the admin's detail panel. */
  header,
  /** Shown when the thread is closed instead of the reply box. */
  closedNote = "This conversation is closed. Start a new one and we will pick it up from there.",
}: {
  header?: React.ReactNode;
  closedNote?: string;
}) {
  const myId = useAuthStore((s) => s.user?.id);
  const messages = useChatStore((s) => s.messages);
  const pending = useChatStore((s) => s.pending);
  const loading = useChatStore((s) => s.threadLoading);
  const error = useChatStore((s) => s.threadError);
  const conversation = useChatStore((s) => s.activeConversation);
  const send = useChatStore((s) => s.send);
  const retry = useChatStore((s) => s.retry);

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Follow the latest message, including one that arrives over the socket
  // while the thread is open.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, pending.length]);

  const closed = conversation?.status === "closed";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    // Cleared immediately: the bubble is already on screen, and a message left
    // in the box after sending is the classic double-send.
    setDraft("");
    await send(text);
    setBusy(false);
  };

  let lastDay = "";

  return (
    <>
      <div className="fm-chat-body" role="log" aria-live="polite" aria-label="Conversation messages">
        {header}

        {loading && messages.length === 0 && (
          <div className="fm-chat-empty">
            <i className="fas fa-spinner fa-spin" aria-hidden />
            <p>Loading the conversation…</p>
          </div>
        )}

        {!loading && messages.length === 0 && !error && (
          <div className="fm-chat-empty">
            <i className="fas fa-comments" aria-hidden />
            <h3>No messages yet</h3>
            <p>Describe the problem and the team will reply here.</p>
          </div>
        )}

        {messages.map((m: ChatMessage) => {
          const mine = m.senderId === myId;
          const day = dayLabel(m.createdAt);
          const divider = day !== lastDay ? day : null;
          lastDay = day;

          if (m.kind === "system") {
            return (
              <div key={m.messageId} className="fm-chat-msg fm-chat-msg-system">
                {m.body}
              </div>
            );
          }

          return (
            <div key={m.messageId} style={{ display: "contents" }}>
              {divider && (
                <div className="fm-chat-msg fm-chat-msg-system" style={{ border: "none" }}>
                  {divider}
                </div>
              )}
              <div className={`fm-chat-msg ${mine ? "fm-chat-msg-me" : "fm-chat-msg-them"}`}>
                {!mine && m.senderName && <div className="fm-chat-sender">{m.senderName}</div>}
                {m.body}
                <div className="fm-chat-meta">
                  <span>{clock(m.createdAt)}</span>
                  {mine && (
                    <span>
                      <i className={`fas ${m.readBy.length > 0 ? "fa-check-double" : "fa-check"}`} aria-hidden />{" "}
                      {m.readBy.length > 0 ? "Seen" : "Sent"}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {/* Messages on their way, and ones that did not make it. */}
        {pending.map((p) => (
          <div
            key={p.clientId}
            className={`fm-chat-msg fm-chat-msg-me ${p.status === "failed" ? "fm-chat-msg-failed" : "fm-chat-msg-pending"}`}
          >
            {p.body}
            <div className="fm-chat-meta">
              {p.status === "failed" ? (
                <>
                  <span>
                    <i className="fas fa-triangle-exclamation" aria-hidden /> Not sent
                  </span>
                  <button
                    type="button"
                    onClick={() => void retry(p.clientId)}
                    style={{ color: "inherit", textDecoration: "underline", background: "none", border: "none", cursor: "pointer", font: "inherit" }}
                  >
                    Retry
                  </button>
                </>
              ) : (
                <span>
                  <i className="fas fa-clock" aria-hidden /> Sending…
                </span>
              )}
            </div>
          </div>
        ))}

        {error && (
          <div className="fm-chat-alert" role="alert">
            <i className="fas fa-triangle-exclamation" aria-hidden /> {error}
          </div>
        )}

        <div ref={endRef} />
      </div>

      <div className="fm-chat-foot">
        {closed ? (
          <p className="fm-chat-card-sub" style={{ margin: 0, textAlign: "center" }}>
            <i className="fas fa-lock mr-1" aria-hidden /> {closedNote}
          </p>
        ) : (
          <form className="fm-chat-form" onSubmit={submit}>
            <label className="sr-only" htmlFor="fm-chat-draft">
              Your message
            </label>
            <textarea
              id="fm-chat-draft"
              className="fm-chat-input"
              rows={1}
              value={draft}
              placeholder="Write a message…"
              maxLength={4000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter is a new line -- what people expect
                // of a chat box, and what stops a half-typed message going out.
                if (e.key === "Enter" && !e.shiftKey) void submit(e);
              }}
            />
            <button type="submit" className="fm-chat-send" disabled={!draft.trim() || busy} aria-label="Send message">
              <i className={`fas ${busy ? "fa-spinner fa-spin" : "fa-paper-plane"}`} aria-hidden />
            </button>
          </form>
        )}
      </div>
    </>
  );
}
