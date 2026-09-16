/**
 * Creating and delivering notifications.
 *
 * One function does both: writes the row, then pushes it to the recipient's
 * own socket room. In that order -- a notification the client renders but the
 * database never stored would vanish on the next page load with no trace of
 * why.
 */

const Notification = require("../../models/Notification");
const realtime = require("./realtime");

/**
 * Create a notification and deliver it live.
 *
 * @param {object}  opts
 * @param {string}  opts.user       recipient id (required)
 * @param {string}  opts.type       one of the Notification enum values
 * @param {string}  opts.title
 * @param {string} [opts.body]
 * @param {string} [opts.link]      client route name
 * @param {string} [opts.booking]
 * @param {string} [opts.station]
 * @param {string} [opts.dedupeKey] suppresses a repeat of the same event
 * @returns {Promise<object|null>}  the row, or null if it was a duplicate
 */
async function notify(opts) {
  const { user, type, title } = opts || {};
  if (!user || !type || !title) {
    console.error("[notifications] refusing to create one without user/type/title");
    return null;
  }

  let doc;
  try {
    doc = await Notification.create({
      user: opts.user,
      type: opts.type,
      title: opts.title,
      body: opts.body || "",
      link: opts.link || null,
      booking: opts.booking || null,
      station: opts.station || null,
      dedupeKey: opts.dedupeKey || null,
    });
  } catch (err) {
    // 11000 on the (user, dedupeKey) index means this exact event already
    // notified this person. That is the intended outcome, not a failure.
    if (err && err.code === 11000) return null;
    console.error("[notifications] create failed:", err.message);
    return null;
  }

  // Only after the row exists.
  realtime.toUser(opts.user, realtime.EVENTS.NOTIFICATION_CREATED, doc.toObject());
  return doc;
}

/**
 * Notify several people about the same thing.
 * Failures are per-recipient: one bad id must not stop the rest.
 */
async function notifyMany(userIds, template) {
  const out = [];
  for (const id of new Set((userIds || []).map(String))) {
    const made = await notify({ ...template, user: id });
    if (made) out.push(made);
  }
  return out;
}

/** Unread count for the badge. */
function unreadCount(userId) {
  return Notification.countDocuments({ user: userId, read: false });
}

module.exports = { notify, notifyMany, unreadCount };
