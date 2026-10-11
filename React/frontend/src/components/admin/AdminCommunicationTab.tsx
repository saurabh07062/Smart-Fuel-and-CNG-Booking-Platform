import { useEffect, useState } from "react";
import { useChatStore } from "@/store/chatStore";
import ConversationList from "@/components/chat/ConversationList";
import ChatThread from "@/components/chat/ChatThread";
import type { ConversationKind, ConversationStatus } from "@/services/api/chatApi";

/**
 * The admin communication centre: customer and vendor support, in one place.
 *
 * Two panes -- the threads on the left, the open one on the right -- because a
 * support queue is worked by reading a list and answering from it, and a
 * one-at-a-time screen means going back to the list after every reply. Under
 * 1024px it stacks (chat.css .fm-chat-centre).
 *
 * WHAT IS SHOWN, AND WHY IT IS SAFE
 *
 * The rows come from /api/chat/conversations, which returns only the two
 * support channels to an admin and never a customer-vendor thread's contents
 * (backend services/chat/access.js). The customer or vendor behind a thread IS
 * named here -- that is what makes the queue workable -- and the server decides
 * that, per role, in one place. This component renders what it was given; it
 * never picks which fields to hide, because a component that did could be
 * reused somewhere it should not be.
 */

const TABS: { id: ConversationKind; label: string; icon: string }[] = [
  { id: "customer_admin", label: "Customers", icon: "fa-users" },
  { id: "vendor_admin", label: "Vendors", icon: "fa-store" },
];

const STATUSES: (ConversationStatus | "all")[] = ["all", "open", "pending", "resolved", "closed"];

/** The status buttons an admin sets on the open thread. */
const SET_STATUS: { status: ConversationStatus; label: string; icon: string }[] = [
  { status: "open", label: "Open", icon: "fa-envelope-open" },
  { status: "pending", label: "Pending", icon: "fa-hourglass-half" },
  { status: "resolved", label: "Resolved", icon: "fa-circle-check" },
  { status: "closed", label: "Closed", icon: "fa-lock" },
];

export default function AdminCommunicationTab() {
  const conversations = useChatStore((s) => s.conversations);
  const loading = useChatStore((s) => s.conversationsLoading);
  const error = useChatStore((s) => s.conversationsError);
  const load = useChatStore((s) => s.loadConversations);
  const activeId = useChatStore((s) => s.activeId);
  const active = useChatStore((s) => s.activeConversation);
  const openThread = useChatStore((s) => s.openThread);
  const setStatus = useChatStore((s) => s.setStatus);
  const unread = useChatStore((s) => s.unread);

  const [kind, setKind] = useState<ConversationKind>("customer_admin");
  const [status, setStatusFilter] = useState<ConversationStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");

  // One request per filter change; the socket keeps the list current after that
  // (useChatRealtime, mounted by the console shell).
  useEffect(() => {
    void load({ kind, status: status === "all" ? undefined : status, q: query || undefined, page: 1 });
  }, [kind, status, query, load]);

  const rows = conversations ?? null;

  return (
    <div className="fm-chat-console">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-bold vm-text">Communication</h2>
          <p className="vm-subtitle" style={{ fontSize: 12 }}>
            {unread ? `${unread.threads} conversation(s) with ${unread.messages} unread message(s) waiting for the team` : "Customer and vendor support"}
          </p>
        </div>
        <div className="fm-chat-tabs" role="tablist" aria-label="Conversation type">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={kind === t.id}
              className={`fm-chat-tab ${kind === t.id ? "fm-chat-tab-active" : ""}`}
              onClick={() => setKind(t.id)}
            >
              <i className={`fas ${t.icon} mr-1.5`} aria-hidden /> {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="fm-chat-centre">
        {/* ── the queue ── */}
        <section className="fm-chat-centre-pane" aria-label="Conversations">
          <div className="fm-chat-centre-head">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setQuery(search.trim());
              }}
              className="flex gap-2"
            >
              <label className="sr-only" htmlFor="conv-search">
                Search conversations
              </label>
              <input
                id="conv-search"
                className="fm-chat-field"
                placeholder="Search subject or last message…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button type="submit" className="fm-chat-chip" aria-label="Search">
                <i className="fas fa-magnifying-glass" aria-hidden />
              </button>
            </form>

            <div className="flex flex-wrap gap-1.5 mt-2.5">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`fm-chat-chip ${status === s ? "fm-chat-chip-primary" : ""}`}
                  onClick={() => setStatusFilter(s)}
                  aria-pressed={status === s}
                  style={{ padding: "5px 10px", fontSize: 11.5 }}
                >
                  {s === "all" ? "All" : s}
                </button>
              ))}
            </div>
          </div>

          <div className="fm-chat-centre-scroll">
            <ConversationList
              conversations={rows}
              loading={loading}
              error={error}
              selectedId={activeId}
              onSelect={(id) => void openThread(id)}
              showStation
              emptyTitle="Nothing here"
              emptyBody={
                query || status !== "all"
                  ? "No conversation matches this search and filter."
                  : kind === "vendor_admin"
                    ? "No vendor has opened a support conversation yet."
                    : "No customer has opened a support conversation yet."
              }
            />
          </div>
        </section>

        {/* ── the open thread, and what it is about ── */}
        <section className="fm-chat-centre-pane" aria-label="Conversation">
          {!activeId ? (
            <div className="fm-chat-empty" style={{ padding: "48px 20px" }}>
              <i className="fas fa-comments" aria-hidden />
              <h3>Pick a conversation</h3>
              <p>Its messages, the account behind it and the booking it concerns appear here.</p>
            </div>
          ) : (
            <div className="fm-chat-centre-thread">
              <div className="fm-chat-centre-head">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div style={{ minWidth: 0 }}>
                    <h3 className="fm-chat-card-title">{active?.subject || "Conversation"}</h3>
                    <p className="fm-chat-card-sub">
                      {active?.vendor
                        ? `${active.vendor.businessName || active.vendor.name || "Vendor"}${active.vendor.vendorCode ? ` · ${active.vendor.vendorCode}` : ""}`
                        : active?.customer
                          ? `${active.customer.name || "Customer"}${active.customer.phone ? ` · ${active.customer.phone}` : ""}`
                          : ""}
                      {active?.topic ? ` · ${active.topic}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {SET_STATUS.map((s) => (
                      <button
                        key={s.status}
                        type="button"
                        className={`fm-chat-chip ${active?.status === s.status ? "fm-chat-chip-primary" : ""}`}
                        onClick={() => void setStatus(s.status)}
                        aria-pressed={active?.status === s.status}
                        style={{ padding: "5px 10px", fontSize: 11.5 }}
                      >
                        <i className={`fas ${s.icon}`} aria-hidden /> {s.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* The related records, as the server sent them -- no invented detail. */}
                <div className="fm-chat-grid" style={{ marginTop: 10 }}>
                  <div>
                    <div className="fm-chat-fact-label">Booking</div>
                    {active?.booking ? (
                      <div className="fm-chat-fact-value">
                        {active.booking.reference || active.booking.bookingId}
                        <span className="fm-chat-card-sub">
                          {active.booking.fuelType ? ` · ${active.booking.fuelType}` : ""}
                          {active.booking.bookingDate ? ` · ${active.booking.bookingDate}` : ""}
                          {active.booking.timeSlot ? ` ${active.booking.timeSlot}` : ""}
                          {active.booking.status ? ` · ${active.booking.status}` : ""}
                          {active.booking.paymentStatus ? ` · ${active.booking.paymentStatus}` : ""}
                        </span>
                      </div>
                    ) : (
                      <div className="fm-chat-fact-empty">None attached</div>
                    )}
                  </div>
                  <div>
                    <div className="fm-chat-fact-label">Station</div>
                    {active?.station ? (
                      <div className="fm-chat-fact-value">
                        {active.station.name || active.station.stationId}
                        <span className="fm-chat-card-sub">
                          {active.station.status ? ` · ${active.station.status}` : ""}
                          {` · ${active.station.stationId}`}
                        </span>
                      </div>
                    ) : (
                      <div className="fm-chat-fact-empty">None attached</div>
                    )}
                  </div>
                  <div>
                    <div className="fm-chat-fact-label">Contact</div>
                    {active?.customer?.email || active?.vendor?.email ? (
                      <div className="fm-chat-fact-value" style={{ fontSize: 12 }}>
                        {active?.customer?.email || active?.vendor?.email}
                      </div>
                    ) : (
                      <div className="fm-chat-fact-empty">Not recorded</div>
                    )}
                  </div>
                  <div>
                    <div className="fm-chat-fact-label">Unread</div>
                    <div className="fm-chat-fact-value">
                      {active?.unreadBySide
                        ? `customer ${active.unreadBySide.customer} · vendor ${active.unreadBySide.vendor} · team ${active.unreadBySide.admin}`
                        : "0"}
                    </div>
                  </div>
                </div>
              </div>

              <ChatThread closedNote="This conversation is closed. Set it back to Open to reply." />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
