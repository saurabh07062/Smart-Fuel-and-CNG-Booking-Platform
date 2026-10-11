const mongoose = require("mongoose");
const { PARTICIPANT_ROLES } = require("./Conversation");

/**
 * One message in a conversation.
 *
 * WHY `clientId`
 *
 * A browser that loses its connection mid-send does not know whether the
 * message arrived. Retrying is the right behaviour -- sending it twice is not.
 * Every send carries an id the client generated, and the unique
 * (conversation, clientId) index makes the retry land on the message that is
 * already there instead of a second copy (services/chat/messages.js turns the
 * duplicate-key error into "here is the one you already sent").
 *
 * WHY `context` IS A SNAPSHOT
 *
 * Everything else in this feature reads live data on purpose, because a stale
 * queue position is worse than none. This field is the exception, and only for
 * the FIRST message of a support thread: what the customer's screen said when
 * they reported the problem. If it were read live, a thread that opened with
 * "I was 4th in the queue and nothing moved" would, an hour later, show the
 * booking as completed and the complaint would make no sense. It is written by
 * the server from the real booking (services/chat/context.js), never accepted
 * from the client.
 *
 * `system` messages are the thread's own record of what happened to it -- "the
 * admin marked this resolved" -- written by the server, attributed to whoever
 * acted, and never editable.
 */
const MessageSchema = new mongoose.Schema(
  {
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /**
     * The sender's role AT THE TIME they wrote, resolved on the server from
     * the database. A snapshot here rather than a populate, so a thread still
     * reads correctly if that account's role changes later -- and so the
     * client can style a message without being told who to trust.
     */
    senderRole: { type: String, enum: PARTICIPANT_ROLES, required: true },
    /** A snapshot of the sender's display name, for the same reason. */
    senderName: { type: String, trim: true, maxlength: 120, default: "" },

    kind: { type: String, enum: ["text", "system"], default: "text" },
    body: { type: String, required: true, trim: true, maxlength: 4000 },

    /**
     * What the sender's screen showed when they opened the thread (first
     * message only): booking reference, fuel, station, slot, status. Read from
     * the real booking by the server. See the note above.
     */
    context: { type: mongoose.Schema.Types.Mixed, default: null },

    /** The sender's own id for this message; makes a retry idempotent. */
    clientId: { type: String, trim: true, maxlength: 64, default: null },

    /**
     * Who has read it. The per-side unread counters on the conversation are
     * what the badges use; this is the per-person detail behind them, and what
     * a "Seen" tick reads.
     */
    readBy: {
      type: [
        new mongoose.Schema(
          {
            user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
            at: { type: Date, default: Date.now },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

// The thread view: this conversation's messages in order. Every read of a
// thread uses this, so it is the one index that has to exist.
MessageSchema.index({ conversation: 1, createdAt: 1 });

// The newest message of each thread (the list snippet's source of truth).
MessageSchema.index({ conversation: 1, createdAt: -1 });

// A retry is the same message. Partial rather than sparse, so the many
// server-written messages without a clientId do not collide on null.
MessageSchema.index(
  { conversation: 1, clientId: 1 },
  {
    name: "uniq_message_client_id",
    unique: true,
    partialFilterExpression: { clientId: { $type: "string" } },
  },
);

// "What has this person sent lately", for rate limiting and for the audit.
MessageSchema.index({ sender: 1, createdAt: -1 });

module.exports = mongoose.model("Message", MessageSchema);
