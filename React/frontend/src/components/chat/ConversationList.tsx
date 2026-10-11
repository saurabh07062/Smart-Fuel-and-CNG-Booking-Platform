import type { ConversationRow } from "@/services/api/chatApi";

/**
 * A list of conversations, for whoever is looking.
 *
 * The rows are exactly what the server sent: a customer's row carries no admin
 * identity and no other side's contact details, and an admin's row carries the
 * account the thread belongs to. That decision is the server's
 * (backend services/chat/conversations.js publicConversation), so this component
 * simply renders what it was given rather than choosing what to hide -- which is
 * why it can be shared by the widget and the admin centre.
 */

const STATUS_PILL: Record<string, string> = {
  open: "fm-chat-pill-good",
  pending: "fm-chat-pill-warn",
  resolved: "fm-chat-pill-mute",
  closed: "fm-chat-pill-mute",
};

/** "3 min ago" for a list row. */
export function relativeTime(iso?: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "";
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** Who the row is with: the admin console names the account, others do not. */
function withWhom(row: ConversationRow): string {
  if (row.vendor) return row.vendor.businessName || row.vendor.name || "Vendor";
  if (row.customer) return row.customer.name || "Customer";
  return row.counterparty?.name || "FuelMart support";
}

export default function ConversationList({
  conversations,
  loading,
  error,
  selectedId,
  onSelect,
  emptyTitle = "No conversations yet",
  emptyBody = "When you start a chat it appears here, with its whole history.",
  showStation = false,
}: {
  /** null = still loading the first time, [] = loaded and genuinely empty. */
  conversations: ConversationRow[] | null;
  loading?: boolean;
  error?: string | null;
  selectedId?: string | null;
  onSelect: (conversationId: string) => void;
  emptyTitle?: string;
  emptyBody?: string;
  /** The admin centre shows which station a thread concerns. */
  showStation?: boolean;
}) {
  if (error) {
    return (
      <div className="fm-chat-alert" role="alert">
        <i className="fas fa-triangle-exclamation" aria-hidden /> {error}
      </div>
    );
  }

  if (conversations === null || (loading && conversations.length === 0)) {
    return (
      <div className="fm-chat-empty">
        <i className="fas fa-spinner fa-spin" aria-hidden />
        <p>Loading conversations…</p>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="fm-chat-empty">
        <i className="fas fa-comments" aria-hidden />
        <h3>{emptyTitle}</h3>
        <p>{emptyBody}</p>
      </div>
    );
  }

  return (
    <ul className="fm-chat-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {conversations.map((row) => (
        <li key={row.conversationId}>
          <button
            type="button"
            className={`fm-chat-row ${selectedId === row.conversationId ? "fm-chat-row-selected" : ""}`}
            onClick={() => onSelect(row.conversationId)}
            aria-current={selectedId === row.conversationId ? "true" : undefined}
          >
            <div className="fm-chat-row-top">
              <span className="fm-chat-row-subject">{row.subject}</span>
              {row.unread > 0 && (
                <span className="fm-chat-unread" aria-label={`${row.unread} unread messages`}>
                  {row.unread}
                </span>
              )}
            </div>

            <p className="fm-chat-row-last">
              {row.lastMessage ? (
                <>
                  {row.lastMessage.senderRole ? `${row.lastMessage.senderRole}: ` : ""}
                  {row.lastMessage.text}
                </>
              ) : (
                "No messages yet"
              )}
            </p>

            <div className="fm-chat-row-meta">
              <span className={`fm-chat-pill ${STATUS_PILL[row.status] || "fm-chat-pill-mute"}`}>{row.status}</span>
              <span>{withWhom(row)}</span>
              {row.booking?.reference && <span>· {row.booking.reference}</span>}
              {showStation && row.station?.name && <span>· {row.station.name}</span>}
              <span style={{ marginLeft: "auto" }}>{relativeTime(row.lastMessage?.at || row.updatedAt)}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
