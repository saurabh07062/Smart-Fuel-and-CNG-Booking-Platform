/**
 * Who may see, open and write to a conversation.
 *
 * ONE PLACE, ON THE SERVER
 *
 * Every chat route goes through the functions here. Nothing about
 * authorization is decided from the request body: not the role, not the user
 * id, not which thread "belongs" to the caller. The role comes from
 * middleware/auth.js (which reads it from the database, never the token
 * payload) and the thread's own participants come from the stored document.
 *
 * THE RULES
 *
 *   customer   only threads they are a participant of, and only their own
 *              bookings may be attached to one.
 *   vendor     only threads where they are the `vendor` side. A vendor cannot
 *              read a customer's thread with the admin team even when it is
 *              about that vendor's own station -- the customer wrote it to the
 *              admins, and forwarding it is the admins' decision, not an
 *              access rule.
 *   admin      any customer_admin and vendor_admin thread (the admin side is
 *              the whole team -- models/Conversation.js explains why), and
 *              read-only sight of a customer_vendor thread only through the
 *              communication centre's thread list, never by joining it.
 *
 * A caller who is not allowed gets 404, not 403, from the controller: "this
 * thread exists but is not yours" is itself information about other people's
 * support threads.
 */

const mongoose = require("mongoose");

/** Roles that have a private support channel with the admin team. */
const ADMIN_THREAD_KINDS = new Set(["customer_admin", "vendor_admin"]);

/** A usable ObjectId, or null. Keeps a junk id out of every query below. */
function objectId(value) {
  const id = String(value ?? "");
  return mongoose.Types.ObjectId.isValid(id) ? id : null;
}

/**
 * The id of a reference, whether it has been populated or not.
 *
 * Every comparison below goes through this. The alternative -- String(field) --
 * silently stops working the moment a caller populates that field: a populated
 * `vendor` stringifies to the whole document, so the vendor's own id never
 * matched it and the vendor was refused their own thread. Found by
 * test/chatApi.test.js, which reads a thread through the populated path.
 */
function idOf(value) {
  if (!value) return "";
  if (typeof value === "object") return String(value._id ?? value.id ?? "");
  return String(value);
}

/**
 * Is this user a named participant of this thread?
 *
 * Works on a document or a lean object, and compares as strings because one
 * side is an ObjectId and the other is a string from the session.
 */
function isParticipant(conversation, userId) {
  const me = idOf(userId);
  if (!me) return false;
  return (conversation?.participants || []).some((p) => idOf(p.user) === me);
}

/**
 * May this user read this thread?
 *
 * @param {object} conversation a Conversation document or lean object
 * @param {{id: string, role: string}} user from middleware/auth.js
 */
function canRead(conversation, user) {
  if (!conversation || !user) return false;
  if (user.role === "admin") {
    // The admin team owns both support channels. A customer-vendor thread is
    // between those two; an admin sees that it exists (the centre lists it for
    // context) but reading it is a separate decision -- see canReadForAudit.
    return ADMIN_THREAD_KINDS.has(conversation.kind);
  }
  if (user.role === "vendor") {
    // Being the vendor side is what grants it, not merely appearing in it.
    return idOf(conversation.vendor) === idOf(user.id) && isParticipant(conversation, user.id);
  }
  return isParticipant(conversation, user.id);
}

/**
 * May this user post to this thread?
 *
 * Reading and writing differ in exactly one way: a closed thread is history.
 * Reopening it is an explicit action (the admin centre's status control, or the
 * customer starting a new thread), not a side effect of typing into it.
 */
function canWrite(conversation, user) {
  if (!canRead(conversation, user)) return false;
  return conversation.status !== "closed";
}

/**
 * The role this user writes as in this thread.
 *
 * Derived from the thread and the verified role, never from the client: it
 * decides how the message is labelled and which side's unread counter goes up.
 * Returns null when they may not write at all.
 */
function writerRole(conversation, user) {
  if (!canWrite(conversation, user)) return null;
  if (user.role === "admin") return "admin";
  if (idOf(conversation.vendor) === idOf(user.id)) return "vendor";
  if (idOf(conversation.customer) === idOf(user.id)) return "customer";
  return null;
}

/**
 * The filter that limits a thread LIST to what this user may see.
 *
 * Returned as a Mongo filter rather than applied by hand at each call site, so
 * a new list endpoint cannot forget it. An admin gets the support channels; a
 * vendor gets the threads they are the vendor side of; everyone else gets the
 * threads they are in.
 */
function listFilter(user) {
  if (!user) return { _id: null }; // matches nothing, never "everything"
  if (user.role === "admin") return { kind: { $in: [...ADMIN_THREAD_KINDS] } };
  if (user.role === "vendor") return { vendor: user.id, "participants.user": user.id };
  return { "participants.user": user.id };
}

/**
 * Which side's unread counter this user's reading clears.
 *
 * "admin" for any admin, because the counter is per side: one admin opening a
 * thread answers the question the badge asks ("does this need the team?").
 */
function sideOf(conversation, user) {
  if (!user) return null;
  if (user.role === "admin") return "admin";
  if (idOf(conversation?.vendor) === idOf(user.id)) return "vendor";
  if (idOf(conversation?.customer) === idOf(user.id)) return "customer";
  return null;
}

/** The other sides, whose unread counts a new message from `side` raises. */
function otherSides(conversation, side) {
  const sides = conversation?.kind === "customer_vendor" ? ["customer", "vendor"] : [sideCounterpart(conversation), "admin"];
  return sides.filter((s) => s && s !== side);
}

/** The non-admin side of a support thread. */
function sideCounterpart(conversation) {
  if (conversation?.kind === "customer_admin") return "customer";
  if (conversation?.kind === "vendor_admin") return "vendor";
  return null;
}

module.exports = {
  ADMIN_THREAD_KINDS,
  objectId,
  idOf,
  isParticipant,
  canRead,
  canWrite,
  writerRole,
  listFilter,
  sideOf,
  otherSides,
};
