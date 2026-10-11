/**
 * The support-chat API.
 *
 * Thin on purpose: every rule lives in services/chat (access.js for who may do
 * what, conversations.js and messages.js for doing it), so this file is the
 * HTTP shape -- read the request, call the service, send the answer, emit the
 * event. Authorization is never re-implemented here, and nothing is read from
 * the body that decides identity or ownership.
 */

const conversations = require("../services/chat/conversations");
const messages = require("../services/chat/messages");
const notify = require("../services/chat/notify");
const chatbot = require("../services/chat/chatbot");

/** A service result's error, or null. Keeps every handler's shape identical. */
function failed(res, result) {
  if (!result?.error) return false;
  const { status = 400, msg, reason } = result.error;
  res.status(status).json({ msg, ...(reason ? { reason } : {}) });
  return true;
}

/** GET /api/chat/conversations -- the threads this caller may see. */
exports.listConversations = async (req, res) => {
  try {
    const { kind, status, q, bookingId, stationId, limit, page } = req.query;
    const result = await conversations.listConversations(req.user, { kind, status, q, bookingId, stationId, limit, page });
    res.json(result);
  } catch (err) {
    console.error("[chat] list failed:", err);
    res.status(500).json({ msg: "Could not load your conversations." });
  }
};

/** GET /api/chat/unread -- the badge: threads and messages waiting for me. */
exports.unread = async (req, res) => {
  try {
    res.json(await conversations.unreadSummary(req.user));
  } catch (err) {
    console.error("[chat] unread failed:", err);
    res.status(500).json({ msg: "Could not load your unread count." });
  }
};

/**
 * POST /api/chat/conversations
 *
 * Open (or re-enter) a thread. `with` says which channel:
 *   "admin"   the caller's support thread with the admin team
 *   "vendor"  a customer's thread with the vendor of one of their bookings
 *
 * An optional first `message` is posted in the same request, which is what the
 * UI does -- the customer writes their problem and taps send once.
 */
exports.openConversation = async (req, res) => {
  try {
    const target = String(req.body?.with || "admin").toLowerCase();
    const result =
      target === "vendor"
        ? await conversations.openVendorThread(req.user, req.body || {})
        : await conversations.openAdminThread(req.user, req.body || {});
    if (failed(res, result)) return;

    const { conversation, created } = result;
    if (created) notify.conversationChanged(conversation, { reason: "opened" });

    // The first message, when the caller sent one. `withContext` attaches the
    // booking snapshot -- built by the server from the real booking.
    let first = null;
    if (typeof req.body?.message === "string" && req.body.message.trim()) {
      const sent = await messages.sendMessage(req.user, conversation._id, {
        body: req.body.message,
        clientId: req.body.clientId,
        withContext: true,
      });
      if (failed(res, sent)) return;
      first = sent.message;
      notify.messageSent({ conversation: sent.conversation, message: sent.message });
    }

    const thread = await messages.readThread(req.user, conversation._id);
    if (failed(res, thread)) return;
    res.status(created ? 201 : 200).json({ ...thread, created, firstMessage: first });
  } catch (err) {
    console.error("[chat] open failed:", err);
    res.status(500).json({ msg: "Could not start the conversation." });
  }
};

/** GET /api/chat/conversations/:id -- the thread, its messages, and its context. */
exports.getConversation = async (req, res) => {
  try {
    const result = await messages.readThread(req.user, req.params.id, req.query);
    if (failed(res, result)) return;

    // Opening it is reading it: clear this side's count and tell the other tabs.
    const read = await messages.markRead(req.user, req.params.id);
    if (!read.error) {
      notify.threadRead({ conversation: read.conversation, side: read.side, at: read.at });
      result.conversation.unread = 0;
    }
    res.json(result);
  } catch (err) {
    console.error("[chat] read failed:", err);
    res.status(500).json({ msg: "Could not load this conversation." });
  }
};

/** POST /api/chat/conversations/:id/messages -- say something. */
exports.sendMessage = async (req, res) => {
  try {
    const result = await messages.sendMessage(req.user, req.params.id, {
      body: req.body?.body,
      clientId: req.body?.clientId,
    });
    if (failed(res, result)) return;

    // A retry of a message that is already stored must not be announced twice.
    if (!result.duplicate) notify.messageSent({ conversation: result.conversation, message: result.message });
    res.status(result.duplicate ? 200 : 201).json({ message: result.message, duplicate: Boolean(result.duplicate) });
  } catch (err) {
    console.error("[chat] send failed:", err);
    res.status(500).json({ msg: "Could not send your message." });
  }
};

/** POST /api/chat/conversations/:id/read -- I have read this thread. */
exports.markRead = async (req, res) => {
  try {
    const result = await messages.markRead(req.user, req.params.id);
    if (failed(res, result)) return;
    notify.threadRead({ conversation: result.conversation, side: result.side, at: result.at });
    res.json({ ok: true, at: result.at, side: result.side });
  } catch (err) {
    console.error("[chat] mark read failed:", err);
    res.status(500).json({ msg: "Could not update this conversation." });
  }
};

/**
 * PATCH /api/chat/conversations/:id/status -- admin only.
 *
 * The change is recorded in the thread itself, so both sides can see that the
 * team marked it resolved rather than simply going quiet.
 */
exports.setStatus = async (req, res) => {
  try {
    const status = String(req.body?.status || "").toLowerCase();
    const result = await conversations.setStatus(req.user, req.params.id, status);
    if (failed(res, result)) return;

    if (result.changed) {
      const note = await messages.systemNote(req.user, result.conversation, `The support team marked this conversation ${status}.`);
      notify.messageSent({ conversation: result.conversation, message: note });
      notify.conversationChanged(result.conversation, { reason: "status" });
    }
    res.json({ conversation: conversations.publicConversation(result.conversation, req.user), changed: result.changed });
  } catch (err) {
    console.error("[chat] status change failed:", err);
    res.status(500).json({ msg: "Could not update this conversation." });
  }
};

/**
 * GET /api/chat/context -- what the chatbot knows about the caller right now.
 *
 * Built from the live booking, queue, station and inventory data by
 * services/chat/context.js. Never a stored copy, and never another user's.
 */
exports.context = async (req, res) => {
  try {
    res.json(await chatbot.contextFor(req.user));
  } catch (err) {
    console.error("[chat] context failed:", err);
    res.status(500).json({ msg: "Could not read your current details." });
  }
};

/**
 * POST /api/chat/ask -- the chatbot's answer to one question.
 *
 * Answered from the caller's own live data and the project's own help topics
 * (services/chat/chatbot.js). Where a figure is unavailable the answer says so
 * rather than filling it in.
 */
exports.ask = async (req, res) => {
  try {
    const result = await chatbot.answer(req.user, { question: req.body?.question, intent: req.body?.intent });
    if (failed(res, result)) return;
    res.json(result);
  } catch (err) {
    console.error("[chat] ask failed:", err);
    res.status(500).json({ msg: "The assistant could not answer just now." });
  }
};
