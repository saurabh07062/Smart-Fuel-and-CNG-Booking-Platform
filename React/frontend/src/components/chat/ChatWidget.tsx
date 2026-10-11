import { useEffect, useRef, useState } from "react";
import { useChatStore } from "@/store/chatStore";
import { useAuthStore } from "@/store/authStore";
import BookingSummaryCard from "./BookingSummaryCard";
import ConversationList from "./ConversationList";
import ChatThread from "./ChatThread";
import type { ChatAnswer, ChatQuickAction } from "@/services/api/chatApi";

/**
 * The assistant, as a floating panel.
 *
 * ONE COMPONENT, TWO AUDIENCES. A customer and a vendor get the same shell and
 * the same three panels (assistant, conversations, thread); what differs is the
 * context the server sends -- a customer's own booking, or a vendor's own
 * stations -- and the copy drawn from it. Duplicating the shell per role would
 * mean fixing every layout and accessibility detail twice.
 *
 * WHAT IT NEVER DOES
 *
 * It does not answer anything itself. Every reply, every figure and every quick
 * action comes from /api/chat (backend services/chat/chatbot.js), which reads
 * the live booking, queue, station and stock data. If the server cannot read a
 * figure, the panel shows what the server said -- that it is unavailable -- and
 * does not fill the gap.
 */

/** One turn of the conversation with the assistant. */
interface Turn {
  id: string;
  from: "me" | "bot";
  text: string;
  actions?: ChatQuickAction[];
  /** When it was said, for the time under the bubble. */
  at: number;
}

let turnSeq = 0;
const newTurn = (from: Turn["from"], text: string, actions?: ChatQuickAction[]): Turn => ({
  id: `t${++turnSeq}`,
  from,
  text,
  actions,
  at: Date.now(),
});

/** "7:04 pm" -- the only part of a timestamp a chat needs. */
const clockOf = (at: number) =>
  new Date(at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });

export default function ChatWidget() {
  const role = useAuthStore((s) => s.user?.role);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const open = useChatStore((s) => s.open);
  const setOpen = useChatStore((s) => s.setOpen);
  const panel = useChatStore((s) => s.panel);
  const setPanel = useChatStore((s) => s.setPanel);
  const context = useChatStore((s) => s.context);
  const contextError = useChatStore((s) => s.contextError);
  const contextLoading = useChatStore((s) => s.contextLoading);
  const loadContext = useChatStore((s) => s.loadContext);
  const ask = useChatStore((s) => s.ask);
  const conversations = useChatStore((s) => s.conversations);
  const conversationsLoading = useChatStore((s) => s.conversationsLoading);
  const conversationsError = useChatStore((s) => s.conversationsError);
  const loadConversations = useChatStore((s) => s.loadConversations);
  const openThread = useChatStore((s) => s.openThread);
  const startThread = useChatStore((s) => s.startThread);
  const activeConversation = useChatStore((s) => s.activeConversation);
  const closeThread = useChatStore((s) => s.closeThread);
  const unread = useChatStore((s) => s.unread);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [thinking, setThinking] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Read the context when the panel opens, and again each time it is reopened:
  // a queue position from ten minutes ago is not worth showing.
  useEffect(() => {
    if (open) void loadContext();
  }, [open, loadContext]);

  useEffect(() => {
    if (open && panel === "conversations") void loadConversations();
  }, [open, panel, loadConversations]);

  // Esc closes the panel, and focus moves into it when it opens.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [turns.length, thinking]);

  if (!isAuthenticated || (role !== "customer" && role !== "vendor")) return null;

  const summary = context?.booking?.summary ?? null;

  /** Ask the server, and put both sides of the exchange on screen. */
  const run = async (input: { question?: string; intent?: string }, label?: string) => {
    setTurns((t) => [...t, newTurn("me", label || input.question || "")]);
    setThinking(true);
    const answer = await ask(input);
    setThinking(false);

    if (!answer) {
      setTurns((t) => [
        ...t,
        newTurn("bot", "I could not reach the assistant just now. Please try again, or chat with the admin team."),
      ]);
      return;
    }
    setTurns((t) => [...t, newTurn("bot", answer.answer, answer.quickActions)]);
    handleAction(answer);
  };

  /** An answer may offer to DO something (open a chat, open a screen). */
  const handleAction = (answer: ChatAnswer) => {
    const action = answer.action;
    if (!action) return;
    if (action.type === "contact_admin") void contactAdmin(action.bookingId ?? undefined);
    if (action.type === "contact_vendor" && action.bookingId) void contactVendor(action.bookingId);
  };

  const contactAdmin = async (bookingId?: string) => {
    const subject =
      role === "vendor" ? "Vendor support request" : summary ? `Help with ${summary.reference || summary.fuelType} booking` : "Support request";
    await startThread({
      with: "admin",
      // The booking is attached by the SERVER from this customer's own booking;
      // sending the id only says which one, never whose.
      bookingId: bookingId ?? summary?.bookingId,
      subject,
      topic: bookingId || summary ? "booking" : "other",
    });
  };

  const contactVendor = async (bookingId: string) => {
    await startThread({ with: "vendor", bookingId, topic: "booking" });
  };

  const submitQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = question.trim();
    if (!text || thinking) return;
    setQuestion("");
    await run({ question: text });
  };

  const badge = unread?.threads ?? 0;

  return (
    <div className="fm-chat">
      {!open && (
        <button
          type="button"
          className="fm-chat-fab"
          onClick={() => setOpen(true)}
          aria-label={badge > 0 ? `Open FuelMart Assistant, ${badge} conversations need you` : "Open FuelMart Assistant"}
          data-testid="chat-fab"
        >
          <i className="fas fa-comments" aria-hidden />
          <span className="fm-chat-fab-label">Help</span>
          {badge > 0 && <span className="fm-chat-fab-badge">{badge}</span>}
        </button>
      )}

      {open && (
        <div
          className="fm-chat-panel"
          role="dialog"
          aria-modal="false"
          aria-label="FuelMart Assistant"
          tabIndex={-1}
          ref={panelRef}
          data-testid="chat-panel"
        >
          <header className="fm-chat-head">
            {panel === "thread" && (
              <button type="button" className="fm-chat-head-btn" onClick={closeThread} aria-label="Back to conversations">
                <i className="fas fa-arrow-left" aria-hidden />
              </button>
            )}
            {/*
              Who you are talking to, the way a support chat says it: a face,
              a name, and whether anyone is there. The assistant answers from
              this server, so "Online" is a fact rather than a flourish.
            */}
            <span className="fm-chat-head-avatar" aria-hidden>
              <i className={`fas ${panel === "thread" ? "fa-user-headset" : panel === "conversations" ? "fa-inbox" : "fa-headset"}`} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <h2>
                {panel === "thread"
                  ? activeConversation?.counterparty?.name || "Support"
                  : panel === "conversations"
                    ? "Your conversations"
                    : "FuelMart Assistant"}
              </h2>
              <p>
                {panel === "thread" ? (
                  <>
                    {activeConversation?.subject || "Conversation"}
                    {activeConversation?.status ? ` · ${activeConversation.status}` : ""}
                  </>
                ) : panel === "conversations" ? (
                  "Messages with the team"
                ) : (
                  <>
                    <span className="fm-chat-dot" aria-hidden /> Online · replies instantly
                  </>
                )}
              </p>
            </div>
            {panel !== "thread" && (
              <button
                type="button"
                className="fm-chat-head-btn"
                onClick={() => setPanel(panel === "conversations" ? "assistant" : "conversations")}
                aria-label={panel === "conversations" ? "Back to the assistant" : "Your conversations"}
              >
                <i className={`fas ${panel === "conversations" ? "fa-robot" : "fa-inbox"}`} aria-hidden />
              </button>
            )}
            <button type="button" className="fm-chat-head-btn" onClick={() => setOpen(false)} aria-label="Close the assistant">
              <i className="fas fa-xmark" aria-hidden />
            </button>
          </header>

          {panel === "thread" && (
            <ChatThread
              header={
                activeConversation?.booking?.reference ? (
                  <div className="fm-chat-msg fm-chat-msg-system" style={{ border: "none" }}>
                    About booking {activeConversation.booking.reference}
                    {activeConversation.booking.timeSlot ? ` · ${activeConversation.booking.timeSlot}` : ""}
                  </div>
                ) : undefined
              }
            />
          )}

          {panel === "conversations" && (
            <>
              <div className="fm-chat-body">
                <ConversationList
                  conversations={conversations}
                  loading={conversationsLoading}
                  error={conversationsError}
                  onSelect={(id) => void openThread(id)}
                  emptyTitle="No conversations yet"
                  emptyBody="Start one with the admin team and it will appear here, with its whole history."
                />
              </div>
              <div className="fm-chat-foot">
                <button type="button" className="fm-chat-chip fm-chat-chip-primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => void contactAdmin()}>
                  <i className="fas fa-headset" aria-hidden /> Chat with Admin
                </button>
              </div>
            </>
          )}

          {panel === "assistant" && (
            <>
              <div className="fm-chat-body is-thread" ref={bodyRef}>
                {contextLoading && !context && (
                  <div className="fm-chat-empty">
                    <i className="fas fa-spinner fa-spin" aria-hidden />
                    <p>Reading your details…</p>
                  </div>
                )}

                {contextError && (
                  <div className="fm-chat-alert" role="alert">
                    <i className="fas fa-triangle-exclamation" aria-hidden /> {contextError}
                  </div>
                )}

                {context && (
                  <>
                    <div className="fm-chat-line is-them">
                      <span className="fm-chat-avatar" aria-hidden>
                        <i className="fas fa-headset" />
                      </span>
                      <div className="fm-chat-stack">
                        <div className="fm-chat-msg fm-chat-msg-them">{context.greeting}</div>
                      </div>
                    </div>

                    {/* A customer's booking, when they have one. */}
                    {summary && (
                      <BookingSummaryCard
                        booking={summary}
                        onAsk={(intent) => void run({ intent }, intentLabel(intent, context.quickActions))}
                        onContactVendor={context.canContactVendor ? () => void contactVendor(summary.bookingId) : undefined}
                      />
                    )}

                    {/* A vendor's own stations. */}
                    {context.stations?.list?.map((station) => (
                      <section key={station.stationId} className="fm-chat-card" aria-label={station.name}>
                        <div className="fm-chat-card-head">
                          <div style={{ minWidth: 0 }}>
                            <h3 className="fm-chat-card-title">{station.name}</h3>
                            <p className="fm-chat-card-sub">{station.address}</p>
                          </div>
                          <span className={`fm-chat-pill ${station.status === "Active" ? "fm-chat-pill-good" : "fm-chat-pill-bad"}`}>
                            {station.status}
                          </span>
                        </div>
                        <div className="fm-chat-grid">
                          <div>
                            <div className="fm-chat-fact-label">Bookings today</div>
                            {station.bookingsToday.available ? (
                              <div className="fm-chat-fact-value">{station.bookingsToday.total}</div>
                            ) : (
                              <div className="fm-chat-fact-empty">Not available</div>
                            )}
                          </div>
                          <div>
                            <div className="fm-chat-fact-label">In line now</div>
                            {station.queue.available ? (
                              <div className="fm-chat-fact-value">{station.queue.waiting ?? 0}</div>
                            ) : (
                              <div className="fm-chat-fact-empty">Not available</div>
                            )}
                          </div>
                          <div>
                            <div className="fm-chat-fact-label">Being fuelled</div>
                            <div className="fm-chat-fact-value">{station.bookingsToday.serving}</div>
                          </div>
                          <div>
                            <div className="fm-chat-fact-label">Completed today</div>
                            <div className="fm-chat-fact-value">{station.bookingsToday.completed}</div>
                          </div>
                        </div>
                      </section>
                    ))}

                    {/* Each turn of the conversation with the assistant. */}
                    {/*
                      A row per message rather than a bare bubble: the
                      assistant's answers carry its avatar, and both sides
                      carry the time they were said. That is what makes a
                      thread read as a conversation with someone instead of a
                      list of strings.
                    */}
                    {turns.map((turn) => (
                      <div key={turn.id} className={`fm-chat-line ${turn.from === "me" ? "is-me" : "is-them"}`}>
                        {turn.from === "bot" && (
                          <span className="fm-chat-avatar" aria-hidden>
                            <i className="fas fa-headset" />
                          </span>
                        )}
                        <div className="fm-chat-stack">
                          <div className={`fm-chat-msg ${turn.from === "me" ? "fm-chat-msg-me" : "fm-chat-msg-them"}`}>
                            {turn.text}
                          </div>
                          <time className="fm-chat-time" dateTime={new Date(turn.at).toISOString()}>
                            {clockOf(turn.at)}
                          </time>
                        </div>
                      </div>
                    ))}

                    {thinking && (
                      <div className="fm-chat-line is-them">
                        <span className="fm-chat-avatar" aria-hidden>
                          <i className="fas fa-headset" />
                        </span>
                        <div className="fm-chat-typing" aria-label="The assistant is looking that up">
                          <span />
                          <span />
                          <span />
                        </div>
                      </div>
                    )}

                    {/*
                      The latest answer's follow-ups, or the opening actions --
                      and one button to reach a person.

                      The server's own list already offers a support topic for
                      some audiences (the vendor's "Chat with Admin"), so the
                      fixed button is dropped when it is already there: two
                      buttons with the same words, side by side, read as two
                      different things.
                    */}
                    {(() => {
                      const actions = turns.filter((t) => t.from === "bot").at(-1)?.actions ?? context.quickActions;
                      const SUPPORT_IDS = ["contact_admin", "vendor_support"];
                      const hasSupport = actions.some((a) => SUPPORT_IDS.includes(a.id));
                      return (
                        <div className="fm-chat-actions">
                          {/* Labelled, so a block of buttons reads as offered
                              choices rather than as a tag cloud. */}
                          <p className="fm-chat-actions-label">Suggested</p>
                          {actions.map((action) => (
                            <button
                              key={action.id}
                              type="button"
                              className={`fm-chat-chip ${SUPPORT_IDS.includes(action.id) ? "fm-chat-chip-primary" : ""}`}
                              onClick={() =>
                                SUPPORT_IDS.includes(action.id) ? void contactAdmin() : void run({ intent: action.id }, action.label)
                              }
                            >
                              <i className={`fas ${action.icon}`} aria-hidden /> {action.label}
                            </button>
                          ))}
                          {!hasSupport && (
                            <button type="button" className="fm-chat-chip fm-chat-chip-primary" onClick={() => void contactAdmin()}>
                              <i className="fas fa-headset" aria-hidden /> Chat with Admin
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>

              <div className="fm-chat-foot">
                <form className="fm-chat-form" onSubmit={submitQuestion}>
                  <label className="sr-only" htmlFor="fm-chat-question">
                    Ask the assistant
                  </label>
                  <textarea
                    id="fm-chat-question"
                    className="fm-chat-input"
                    rows={1}
                    value={question}
                    placeholder={role === "vendor" ? "Ask about your station, queue or stock…" : "Ask about your booking…"}
                    maxLength={500}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) void submitQuestion(e);
                    }}
                  />
                  <button type="submit" className="fm-chat-send" disabled={!question.trim() || thinking} aria-label="Ask">
                    <i className={`fas ${thinking ? "fa-spinner fa-spin" : "fa-paper-plane"}`} aria-hidden />
                  </button>
                </form>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The label for a quick action, so the transcript reads as what was tapped. */
function intentLabel(intent: string, actions: ChatQuickAction[]): string {
  return actions.find((a) => a.id === intent)?.label || intent.replace(/_/g, " ");
}
