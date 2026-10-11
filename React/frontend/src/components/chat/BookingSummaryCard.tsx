import type { ChatBookingSummary } from "@/services/api/chatApi";
import { formatINR } from "@/utils/consoleFormat";

/**
 * The booking the assistant is talking about.
 *
 * EVERY VALUE IS THE SERVER'S. Where one is missing the card says so -- "Not
 * available" in muted italics -- instead of showing a dash that reads as zero or
 * a number that was never published. A queue position is the clearest case: an
 * invented "1st in line" at a pump is worse than admitting the queue could not
 * be read (backend services/chat/chatbot.js keeps the same rule in words).
 */

/** A fact, or an honest note that it is not available. */
function Fact({ label, value, missing }: { label: string; value?: string | null; missing?: string }) {
  return (
    <div>
      <div className="fm-chat-fact-label">{label}</div>
      {value ? (
        <div className="fm-chat-fact-value">{value}</div>
      ) : (
        <div className="fm-chat-fact-empty">{missing || "Not available"}</div>
      )}
    </div>
  );
}

const STATUS_PILL: Record<string, string> = {
  upcoming: "fm-chat-pill-good",
  serving: "fm-chat-pill-warn",
  waitlisted: "fm-chat-pill-warn",
  completed: "fm-chat-pill-mute",
  cancelled: "fm-chat-pill-bad",
  no_show: "fm-chat-pill-bad",
  expired: "fm-chat-pill-mute",
};

const STATUS_WORDS: Record<string, string> = {
  upcoming: "Confirmed",
  serving: "Being fuelled",
  waitlisted: "Waiting list",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "Missed",
  expired: "Expired",
};

const PAYMENT_WORDS: Record<string, string> = {
  due_at_station: "Pay at the pump",
  paid: "Paid",
  pending: "Payment pending",
  failed: "Payment failed",
  refunded: "Refunded",
};

export default function BookingSummaryCard({
  booking,
  onContactVendor,
  onAsk,
}: {
  booking: ChatBookingSummary;
  onContactVendor?: () => void;
  onAsk?: (intent: string) => void;
}) {
  const q = booking.queue;
  const quantity = booking.quantity != null ? `${booking.quantity} ${booking.unit}` : null;

  return (
    <section className="fm-chat-card" aria-label="Your booking">
      <div className="fm-chat-card-head">
        <div style={{ minWidth: 0 }}>
          <h3 className="fm-chat-card-title">{booking.station?.name || "Your station"}</h3>
          <p className="fm-chat-card-sub">
            {booking.reference || booking.bookingId}
            {booking.timeSlot ? ` · ${booking.timeSlot}` : ""}
            {booking.bookingDate ? ` · ${booking.bookingDate}` : ""}
          </p>
        </div>
        <span className={`fm-chat-pill ${STATUS_PILL[booking.status] || "fm-chat-pill-mute"}`}>
          {STATUS_WORDS[booking.status] || booking.status}
        </span>
      </div>

      <div className="fm-chat-grid">
        <Fact label="Fuel" value={quantity ? `${booking.fuelType} · ${quantity}` : booking.fuelType} />
        <Fact label="Amount" value={booking.amount != null ? formatINR(booking.amount) : null} missing="Not priced" />
        {/* The queue is the figure most worth being honest about. */}
        <Fact
          label="Queue position"
          value={q?.queuePosition != null ? `#${q.queuePosition}` : null}
          missing="Not available yet"
        />
        <Fact
          label="Vehicles ahead"
          value={q?.vehicleCountAhead != null ? String(q.vehicleCountAhead) : null}
          missing="Not available yet"
        />
        <Fact label="Estimated wait" value={q?.expectedWaitingTime || null} missing="Not available yet" />
        <Fact label="Expected start" value={q?.estimatedStartTime || null} missing="Not available yet" />
      </div>

      <div className="fm-chat-grid" style={{ gridTemplateColumns: "1fr" }}>
        <div>
          <div className="fm-chat-fact-label">Check-in</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 3 }}>
            <span className={`fm-chat-pill ${booking.checkIn.done ? "fm-chat-pill-good" : "fm-chat-pill-warn"}`}>
              {booking.checkIn.done ? "Checked in" : "Not checked in"}
            </span>
            <span className={`fm-chat-pill ${booking.payment.status === "paid" ? "fm-chat-pill-good" : "fm-chat-pill-mute"}`}>
              {PAYMENT_WORDS[booking.payment.status || ""] || "Payment status unknown"}
            </span>
          </div>
        </div>
      </div>

      {/* The code, and the truth about it: it does nothing until they check in. */}
      {booking.pin && (
        <div className="fm-chat-pin">
          <div>
            <div className="fm-chat-fact-label">Your code</div>
            <code aria-label={`Your code is ${booking.pin.code.split("").join(" ")}`}>{booking.pin.code}</code>
          </div>
          <span className={`fm-chat-pill ${booking.pin.usable ? "fm-chat-pill-good" : "fm-chat-pill-warn"}`}>
            {booking.pin.usable ? "Ready to show" : "Works after check-in"}
          </span>
        </div>
      )}

      {(onAsk || onContactVendor) && (
        <div className="fm-chat-actions" style={{ marginTop: 12 }}>
          {onAsk && (
            <button type="button" className="fm-chat-chip" onClick={() => onAsk("booking_queue")}>
              <i className="fas fa-hourglass-half" aria-hidden /> Queue &amp; wait
            </button>
          )}
          {onAsk && (
            <button type="button" className="fm-chat-chip" onClick={() => onAsk("booking_checkin")}>
              <i className="fas fa-map-pin" aria-hidden /> Check-in &amp; code
            </button>
          )}
          {onContactVendor && booking.station?.stationId && (
            <button type="button" className="fm-chat-chip" onClick={onContactVendor}>
              <i className="fas fa-store" aria-hidden /> Contact the station
            </button>
          )}
        </div>
      )}

      {booking.station?.phone && (
        <p className="fm-chat-card-sub" style={{ marginTop: 10 }}>
          <i className="fas fa-phone mr-1" aria-hidden /> Station number: {booking.station.phone}
        </p>
      )}
    </section>
  );
}
