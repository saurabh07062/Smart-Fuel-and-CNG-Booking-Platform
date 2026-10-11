/**
 * Sending, reading and marking messages read.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT
 *
 *   Duplicates    a client that retries a send after a dropped connection gets
 *                 back the message it already sent, not a second copy. The
 *                 unique (conversation, clientId) index decides it, so two
 *                 servers racing cannot both insert.
 *   Counts        the thread's snippet and the unread counters are written in
 *                 ONE update with $inc, so two messages arriving together
 *                 cannot lose a count the way read-modify-save would.
 *   Order         the database write resolves before anything is emitted, so a
 *                 client never renders a message a failed save rolled back
 *                 (the ordering rule in services/notification/realtime.js).
 */

const Conversation = require("../../models/Conversation");
const Message = require("../../models/Message");
const access = require("./access");
const context = require("./context");

/** How much text one message may carry. Matches the schema. */
const MAX_BODY = 4000;

/**
 * Post a message to a thread.
 *
 * The sender's role in the thread is derived on the server
 * (access.writerRole); nothing about who is writing, or as what, comes from the
 * request body.
 *
 * @returns {Promise<{message?: object, duplicate?: boolean, error?: object}>}
 */
async function sendMessage(user, conversationId, { body, clientId, kind = "text", withContext = false } = {}) {
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) return { error: { status: 400, msg: "Type a message first." } };
  if (text.length > MAX_BODY) {
    return { error: { status: 400, msg: `A message can be at most ${MAX_BODY} characters.` } };
  }
  if (!access.objectId(conversationId)) return { error: { status: 404, msg: "Conversation not found." } };

  const conversation = await Conversation.findById(conversationId);
  if (!conversation || !access.canRead(conversation, user)) {
    // 404 rather than 403: whether someone else's thread exists is not
    // something to confirm (services/chat/access.js).
    return { error: { status: 404, msg: "Conversation not found." } };
  }
  if (conversation.status === "closed") {
    return {
      error: {
        status: 409,
        msg: "This conversation is closed. Start a new one and we will pick it up from there.",
        reason: "CONVERSATION_CLOSED",
      },
    };
  }

  const role = access.writerRole(conversation, user);
  if (!role) return { error: { status: 403, msg: "You cannot post to this conversation." } };

  const User = require("../../models/User");
  const me = await User.findById(user.id).select("name businessName").lean();
  const senderName = role === "vendor" ? me?.businessName || me?.name || "Station team" : me?.name || "";

  // The booking snapshot rides on the FIRST message of a support thread only:
  // what the person was looking at when they wrote (models/Message.js).
  let snapshot = null;
  if (withContext && conversation.booking) {
    const existing = await Message.countDocuments({ conversation: conversation._id, kind: "text" });
    if (existing === 0) {
      snapshot = await context
        .bookingSnapshot(conversation.booking, role === "customer" ? user.id : conversation.customer, { role })
        .catch(() => null);
    }
  }

  let message;
  try {
    message = await Message.create({
      conversation: conversation._id,
      sender: user.id,
      senderRole: role,
      senderName,
      kind: kind === "system" && user.role === "admin" ? "system" : "text",
      body: text,
      context: snapshot,
      clientId: typeof clientId === "string" && clientId.trim() ? clientId.trim().slice(0, 64) : null,
    });
  } catch (err) {
    if (err?.code === 11000) {
      // The same send, retried. Hand back what is already stored so the client
      // can settle its pending bubble instead of showing the message twice.
      const already = await Message.findOne({ conversation: conversation._id, clientId: String(clientId).trim().slice(0, 64) });
      if (already) return { message: publicMessage(already), duplicate: true, conversation };
    }
    throw err;
  }

  // The snippet and the other sides' unread counts, in one atomic update.
  const raise = access.otherSides(conversation, role);
  const inc = {};
  for (const side of raise) inc[`unread.${side}`] = 1;
  const set = {
    "lastMessage.text": text.slice(0, 240),
    "lastMessage.at": message.createdAt,
    "lastMessage.sender": user.id,
    "lastMessage.senderRole": role,
    // The writer has, by definition, read their own thread up to here.
    "participants.$[me].lastReadAt": message.createdAt,
    [`unread.${role}`]: 0,
  };
  // A reply from the team takes a resolved thread back to open: the customer
  // is being answered, so the thread is live again.
  if (conversation.status === "resolved") set.status = "open";
  if (role === "admin") set.assignedAdmin = user.id;

  const updated = await Conversation.findOneAndUpdate(
    { _id: conversation._id },
    { $set: set, ...(Object.keys(inc).length ? { $inc: inc } : {}) },
    {
      new: true,
      arrayFilters: [{ "me.user": toId(user.id) }],
    },
  );

  return { message: publicMessage(message), conversation: updated || conversation, raised: raise };
}

/**
 * A thread and its messages, oldest first, for someone allowed to read it.
 *
 * Opening a thread marks it read for that side -- which is what the badge
 * means -- and the caller emits that so another tab of the same person updates.
 */
async function readThread(user, conversationId, { limit = 100, before } = {}) {
  if (!access.objectId(conversationId)) return { error: { status: 404, msg: "Conversation not found." } };

  const conversation = await Conversation.findById(conversationId)
    .populate("customer", "name email phone")
    .populate("vendor", "name businessName email phone vendorCode")
    .populate("station", "name address status contactPhone")
    .populate("booking", "orderId fuelType quantity amount bookingDate timeSlot status paymentStatus stationCheckInAt");
  if (!conversation || !access.canRead(conversation, user)) {
    return { error: { status: 404, msg: "Conversation not found." } };
  }

  const perPage = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const filter = { conversation: conversation._id };
  if (before) {
    const at = new Date(before);
    if (!Number.isNaN(at.getTime())) filter.createdAt = { $lt: at };
  }

  // Newest `perPage`, then reversed: a long thread opens at the latest message
  // without loading years of history.
  const rows = await Message.find(filter).sort({ createdAt: -1 }).limit(perPage).lean();
  const messages = rows.reverse().map(publicMessage);

  return {
    conversation: require("./conversations").publicConversation(conversation, user),
    messages,
    hasMore: rows.length === perPage,
  };
}

/**
 * Mark a thread read for this user's side.
 *
 * Per side, not per person, for the admin team (models/Conversation.js), and
 * idempotent: opening a thread twice is not an error.
 */
async function markRead(user, conversationId) {
  if (!access.objectId(conversationId)) return { error: { status: 404, msg: "Conversation not found." } };

  const conversation = await Conversation.findById(conversationId);
  if (!conversation || !access.canRead(conversation, user)) {
    return { error: { status: 404, msg: "Conversation not found." } };
  }

  const side = access.sideOf(conversation, user);
  if (!side) return { error: { status: 403, msg: "You cannot read this conversation." } };

  const now = new Date();
  const set = { [`unread.${side}`]: 0 };
  const isParticipant = access.isParticipant(conversation, user.id);
  if (isParticipant) set["participants.$[me].lastReadAt"] = now;

  const updated = await Conversation.findOneAndUpdate(
    { _id: conversation._id },
    { $set: set },
    { new: true, ...(isParticipant ? { arrayFilters: [{ "me.user": toId(user.id) }] } : {}) },
  );

  // The per-person detail behind the counters ("Seen"): the messages this
  // person had not read are now read by them.
  await Message.updateMany(
    { conversation: conversation._id, sender: { $ne: user.id }, "readBy.user": { $ne: user.id } },
    { $push: { readBy: { user: user.id, at: now } } },
  );

  return { conversation: updated || conversation, side, at: now };
}

/**
 * A server-written note in the thread ("marked resolved by the admin team").
 *
 * Attributed to whoever acted, never to a fictional system account, and it
 * does not raise anyone's unread count: it is a record of an action the other
 * side can see when they next look, not a message waiting for a reply.
 */
async function systemNote(actor, conversation, body) {
  const message = await Message.create({
    conversation: conversation._id,
    sender: actor.id,
    senderRole: actor.role === "admin" ? "admin" : actor.role === "vendor" ? "vendor" : "customer",
    senderName: "",
    kind: "system",
    body: String(body).slice(0, 240),
  });
  await Conversation.updateOne(
    { _id: conversation._id },
    { $set: { "lastMessage.text": message.body, "lastMessage.at": message.createdAt, "lastMessage.sender": actor.id, "lastMessage.senderRole": message.senderRole } },
  );
  return publicMessage(message);
}

/** The message as a client may see it. No sender email, no internal ids. */
function publicMessage(row) {
  const m = context.plain(row);
  return {
    messageId: String(m._id),
    conversationId: String(m.conversation),
    senderId: String(m.sender),
    senderRole: m.senderRole,
    senderName: m.senderName || "",
    kind: m.kind || "text",
    body: m.body,
    context: m.context || null,
    clientId: m.clientId || null,
    readBy: (m.readBy || []).map((r) => String(r.user)),
    createdAt: m.createdAt,
  };
}

/** Mongoose needs a real ObjectId inside an arrayFilter. */
function toId(value) {
  const mongoose = require("mongoose");
  return new mongoose.Types.ObjectId(String(value));
}

module.exports = { MAX_BODY, sendMessage, readThread, markRead, systemNote, publicMessage };
