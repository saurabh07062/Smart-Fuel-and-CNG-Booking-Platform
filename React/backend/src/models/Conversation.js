const mongoose = require("mongoose");

/**
 * One support thread between two sides of the platform.
 *
 * WHO TALKS TO WHOM
 *
 *   customer_admin    a customer and the admin team ("Chat with Admin")
 *   vendor_admin      a vendor and the admin team (vendor support)
 *   customer_vendor   a customer and one vendor, about one booking
 *                     ("Contact Vendor" -- opened from a booking, never a
 *                     general channel, so a vendor cannot be messaged by
 *                     someone who has no dealings with them)
 *
 * The admin side is a TEAM, not a person: every admin can read and reply to
 * customer_admin and vendor_admin threads, and `assignedAdmin` only records
 * who picked it up. That is why there is no `admin` participant field -- there
 * is no one admin a thread belongs to, and inventing one would mean a thread
 * going quiet because the admin who opened it is on leave.
 *
 * WHY `participants` EXISTS AS WELL AS `customer` / `vendor`
 *
 * The named fields are what the queries filter and populate by; `participants`
 * is the authorization list -- "is this user allowed in this thread at all" --
 * and it is one indexed lookup regardless of thread kind. Both are written
 * from the same place (services/chat/conversations.js), never by a client.
 *
 * WHAT IS NOT STORED HERE
 *
 * No copy of the booking, station, price, queue position or customer's
 * details. A thread REFERENCES its booking and station and the API reads the
 * live documents when it needs them, so a thread can never show a stale
 * amount or a queue position from last week. The one exception is
 * `lastMessage`, which is a snippet for the list view, and Message.context,
 * which is deliberately a snapshot of what the customer was looking at when
 * they wrote (services/chat/context.js).
 */

/** Who can be in a thread. Mirrors User.role, minus the roles that cannot. */
const PARTICIPANT_ROLES = ["customer", "vendor", "admin"];

/** The thread's lifecycle, as the admin communication centre sets it. */
const CONVERSATION_STATUSES = ["open", "pending", "resolved", "closed"];

const CONVERSATION_KINDS = ["customer_admin", "vendor_admin", "customer_vendor"];

/**
 * What the thread is about. Chosen by the person opening it, from a fixed
 * list, so the admin centre can filter by it -- free text could not be
 * filtered and would not be any more honest.
 */
const CONVERSATION_TOPICS = ["booking", "payment", "queue", "station", "vendor", "account", "other"];

const ParticipantSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: PARTICIPANT_ROLES, required: true },
    /** When this participant last opened the thread; the unread counts follow it. */
    lastReadAt: { type: Date, default: null },
  },
  { _id: false },
);

const ConversationSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: CONVERSATION_KINDS, required: true, index: true },

    /**
     * The authorization list. A request is allowed to touch this thread if the
     * signed-in user is in here, or is an admin and the thread has an admin
     * side (services/chat/access.js). Two members at most today, but a list
     * rather than two fields so adding a second vendor contact later does not
     * mean a migration.
     */
    participants: { type: [ParticipantSchema], required: true },

    // The named sides, for filtering and populating. Exactly which are set
    // depends on `kind`; the pre-validate hook below enforces that.
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    /** The vendor's station this thread concerns, when it concerns one. */
    station: { type: mongoose.Schema.Types.ObjectId, ref: "Station", default: null },
    /** The booking this thread concerns. Never guessed; only what the opener attached. */
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null },

    subject: { type: String, required: true, trim: true, maxlength: 140 },
    topic: { type: String, enum: CONVERSATION_TOPICS, default: "other", index: true },
    status: { type: String, enum: CONVERSATION_STATUSES, default: "open", index: true },

    /** The admin who replied last / took it on. Informational, not a permission. */
    assignedAdmin: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    /**
     * A snippet of the newest message, for the list view.
     *
     * Denormalised on purpose: an admin list of 50 threads would otherwise be
     * 50 extra queries for one line of text each. Written in the same
     * operation that saves the message (services/chat/messages.js), so it
     * cannot drift from what the thread actually contains.
     */
    lastMessage: {
      text: { type: String, default: "", trim: true, maxlength: 240 },
      at: { type: Date, default: null },
      sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      senderRole: { type: String, enum: [...PARTICIPANT_ROLES, null], default: null },
    },

    /**
     * Unread messages waiting for each side.
     *
     * Per side rather than per user, because the admin side is a team: a
     * per-user count would make a thread read for one admin and unread for
     * every other, and the badge in the communication centre is meant to say
     * "someone needs to answer this", not "you personally have not looked".
     * Maintained by $inc / $set in one update (services/chat/messages.js), so
     * two messages arriving together cannot lose a count.
     */
    unread: {
      customer: { type: Number, default: 0, min: 0 },
      vendor: { type: Number, default: 0, min: 0 },
      admin: { type: Number, default: 0, min: 0 },
    },

    /** Set when a thread is resolved or closed; cleared when it reopens. */
    closedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * A thread's sides have to match its kind.
 *
 * Without this a customer_admin thread could carry a `vendor`, and that vendor
 * would then appear in the vendor's own thread list -- reading a conversation
 * they were never part of. The kinds are the security model, so they are
 * checked by the schema and not only by the service that writes them.
 */
ConversationSchema.pre("validate", function checkSides() {
  const roles = new Set((this.participants || []).map((p) => p.role));

  if (this.kind === "customer_admin") {
    if (!this.customer) this.invalidate("customer", "A customer support thread needs its customer.");
    if (this.vendor) this.invalidate("vendor", "A customer support thread has no vendor side.");
    if (!roles.has("customer")) this.invalidate("participants", "The customer must be a participant.");
  } else if (this.kind === "vendor_admin") {
    if (!this.vendor) this.invalidate("vendor", "A vendor support thread needs its vendor.");
    if (this.customer) this.invalidate("customer", "A vendor support thread has no customer side.");
    if (!roles.has("vendor")) this.invalidate("participants", "The vendor must be a participant.");
  } else if (this.kind === "customer_vendor") {
    if (!this.customer) this.invalidate("customer", "A customer-vendor thread needs its customer.");
    if (!this.vendor) this.invalidate("vendor", "A customer-vendor thread needs its vendor.");
    if (!this.booking) {
      // The only reason a customer may message a vendor is a booking they hold.
      this.invalidate("booking", "A customer can only contact a vendor about a booking.");
    }
    if (!roles.has("customer") || !roles.has("vendor")) {
      this.invalidate("participants", "Both the customer and the vendor must be participants.");
    }
  }
});

// ── Indexes ─────────────────────────────────────────────────────────────────

// "My threads, most recent first" -- the one query every non-admin list makes,
// and the authorization lookup for a single thread.
ConversationSchema.index({ "participants.user": 1, updatedAt: -1 });

// The admin communication centre: a tab (kind) filtered by status, newest first.
ConversationSchema.index({ kind: 1, status: 1, updatedAt: -1 });

// Threads waiting on the admin team, which is what the unread badge counts.
ConversationSchema.index({ kind: 1, "unread.admin": -1, updatedAt: -1 });

// "Everything about this booking / this station / this vendor".
ConversationSchema.index({ booking: 1, updatedAt: -1 });
ConversationSchema.index({ station: 1, updatedAt: -1 });
ConversationSchema.index({ vendor: 1, status: 1, updatedAt: -1 });
ConversationSchema.index({ customer: 1, status: 1, updatedAt: -1 });

/**
 * One open thread per customer per kind -- and per booking for a vendor thread.
 *
 * Tapping "Chat with Admin" twice must land in the SAME conversation, not
 * start a second one: two live threads with the same person is how a support
 * reply gets sent into a thread nobody is reading. Closed and resolved threads
 * are excluded, so a customer can always open a new one after the last was
 * settled.
 */
ConversationSchema.index(
  { kind: 1, customer: 1, vendor: 1, booking: 1 },
  {
    name: "uniq_live_thread",
    unique: true,
    partialFilterExpression: { status: { $in: ["open", "pending"] } },
  },
);

// Admin search over what a thread is called and what was last said in it.
ConversationSchema.index({ subject: "text", "lastMessage.text": "text" }, { name: "conversation_text_search" });

ConversationSchema.statics.KINDS = CONVERSATION_KINDS;
ConversationSchema.statics.STATUSES = CONVERSATION_STATUSES;
ConversationSchema.statics.TOPICS = CONVERSATION_TOPICS;

module.exports = mongoose.model("Conversation", ConversationSchema);
module.exports.CONVERSATION_KINDS = CONVERSATION_KINDS;
module.exports.CONVERSATION_STATUSES = CONVERSATION_STATUSES;
module.exports.CONVERSATION_TOPICS = CONVERSATION_TOPICS;
module.exports.PARTICIPANT_ROLES = PARTICIPANT_ROLES;
