/**
 * Who receives a chat event, live.
 *
 * The rooms already exist (services/notification/realtime.js): `user:<id>` for
 * one person, `admin` for the team. This file only decides which of them a
 * given conversation's events go to -- and it is the same decision the HTTP
 * authorization makes, expressed once here, so a message cannot arrive by
 * socket at someone who would be refused it by the API.
 *
 * Called AFTER the database write has resolved, never before (the ordering
 * rule in realtime.js).
 */

const realtime = require("../notification/realtime");

/** The user rooms of a thread's named participants. */
function participantRooms(conversation) {
  return (conversation?.participants || []).map((p) => String(p.user));
}

/** Does the admin team have a side in this thread? */
function hasAdminSide(conversation) {
  return conversation?.kind === "customer_admin" || conversation?.kind === "vendor_admin";
}

/**
 * A new message.
 *
 * Everyone in the thread gets it, plus the admin room when the team is a side
 * of it -- that is what makes the communication centre update without a
 * refresh. A customer-vendor thread is NOT sent to the admin room: the two
 * sides are talking to each other, and the admin centre can read the thread
 * list when it needs to.
 */
function messageSent({ conversation, message }) {
  const payload = {
    conversationId: String(conversation._id),
    kind: conversation.kind,
    status: conversation.status,
    message,
    lastMessage: {
      text: conversation.lastMessage?.text || message.body.slice(0, 240),
      at: conversation.lastMessage?.at || message.createdAt,
      senderRole: message.senderRole,
    },
    unread: conversation.unread || null,
  };

  for (const userId of participantRooms(conversation)) {
    realtime.toUser(userId, realtime.EVENTS.CHAT_MESSAGE, payload);
  }
  if (hasAdminSide(conversation)) realtime.toAdmins(realtime.EVENTS.CHAT_MESSAGE, payload);
}

/** A thread was opened, or its status changed. */
function conversationChanged(conversation, { reason = "updated" } = {}) {
  const payload = {
    conversationId: String(conversation._id),
    kind: conversation.kind,
    status: conversation.status,
    subject: conversation.subject,
    reason,
    unread: conversation.unread || null,
    updatedAt: conversation.updatedAt || new Date(),
  };
  for (const userId of participantRooms(conversation)) {
    realtime.toUser(userId, realtime.EVENTS.CHAT_CONVERSATION, payload);
  }
  if (hasAdminSide(conversation)) realtime.toAdmins(realtime.EVENTS.CHAT_CONVERSATION, payload);
}

/**
 * One side read the thread.
 *
 * Sent to the thread so the other side's "Seen" can settle, and to the same
 * person's other tabs so a badge cleared on a phone clears on a laptop too.
 */
function threadRead({ conversation, side, at }) {
  const payload = {
    conversationId: String(conversation._id),
    side,
    at,
    unread: conversation.unread || null,
  };
  for (const userId of participantRooms(conversation)) {
    realtime.toUser(userId, realtime.EVENTS.CHAT_READ, payload);
  }
  if (hasAdminSide(conversation)) realtime.toAdmins(realtime.EVENTS.CHAT_READ, payload);
}

module.exports = { messageSent, conversationChanged, threadRead, hasAdminSide, participantRooms };
