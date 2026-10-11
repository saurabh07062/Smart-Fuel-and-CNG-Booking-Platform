/**
 * Opening, listing and settling support threads.
 *
 * The rules about WHO may do any of this live in ./access.js; this file is
 * about doing it correctly once allowed -- in particular, that "start a chat
 * with the admin team" lands in the thread that is already open rather than
 * creating a second one, even when two taps race.
 */

const mongoose = require("mongoose");
const Conversation = require("../../models/Conversation");
const access = require("./access");
const context = require("./context");

/** Threads a person can still be answered in. A settled thread is history. */
const LIVE_STATUSES = ["open", "pending"];

/** What a support thread is called when the person did not say. */
const DEFAULT_SUBJECT = {
  customer_admin: "Support request",
  vendor_admin: "Vendor support request",
  customer_vendor: "Question about a booking",
};

/**
 * The live support thread between this user and the admin team, or null.
 *
 * One query, by the same fields the unique index covers, so this and the index
 * cannot disagree about what "already open" means.
 */
function findLiveAdminThread(user) {
  const kind = user.role === "vendor" ? "vendor_admin" : "customer_admin";
  const side = user.role === "vendor" ? { vendor: user.id } : { customer: user.id };
  return Conversation.findOne({ kind, ...side, status: { $in: LIVE_STATUSES } });
}

/**
 * Open (or re-enter) this user's support thread with the admin team.
 *
 * Returns { conversation, created }. `created` is false when they already had
 * one, which is the normal case for anyone who has contacted support before --
 * the customer sees their history rather than an empty box.
 *
 * A booking may be attached, and it is verified to be theirs first: the id
 * comes from the client, so it is not trusted to say whose booking it is.
 */
async function openAdminThread(user, { subject, topic, bookingId } = {}) {
  const existing = await findLiveAdminThread(user);
  if (existing) return { conversation: existing, created: false };

  const kind = user.role === "vendor" ? "vendor_admin" : "customer_admin";
  const role = user.role === "vendor" ? "vendor" : "customer";

  // Only a booking the caller is entitled to attach.
  let snapshot = null;
  let booking = null;
  let station = null;
  if (bookingId && access.objectId(bookingId)) {
    snapshot = await attachableBooking(user, bookingId);
    if (snapshot) {
      booking = snapshot.bookingId;
      station = snapshot.station?.stationId || null;
    }
  }

  const doc = {
    kind,
    participants: [{ user: user.id, role, lastReadAt: new Date() }],
    [role]: user.id,
    booking,
    station,
    subject: cleanSubject(subject) || DEFAULT_SUBJECT[kind],
    topic: cleanTopic(topic),
    createdBy: user.id,
  };

  try {
    const conversation = await Conversation.create(doc);
    return { conversation, created: true, snapshot };
  } catch (err) {
    // Two taps at once: the unique index (uniq_live_thread) let exactly one
    // through, and the loser wants the winner's thread, not an error.
    if (err?.code === 11000) {
      const conversation = await findLiveAdminThread(user);
      if (conversation) return { conversation, created: false };
    }
    throw err;
  }
}

/**
 * Open (or re-enter) a customer's thread with the vendor of one booking.
 *
 * Deliberately narrow: the channel exists for a booking the customer holds, at
 * a station with a real vendor account behind it. That is what stops "Contact
 * Vendor" becoming a way to message any vendor on the platform.
 */
async function openVendorThread(user, { bookingId, subject, topic } = {}) {
  if (user.role !== "customer") {
    return { error: { status: 403, msg: "Only a customer can contact a vendor about their booking." } };
  }
  if (!access.objectId(bookingId)) {
    return { error: { status: 400, msg: "Which booking is this about?" } };
  }

  const Booking = require("../../models/Booking");
  const booking = await Booking.findOne({ _id: bookingId, user: user.id }).populate("station", "name owner");
  if (!booking) return { error: { status: 404, msg: "Booking not found." } };

  const vendor = await context.vendorForBooking(booking);
  if (!vendor) {
    // An OpenStreetMap-imported pump has no vendor account, so there is nobody
    // at the other end. Saying so is better than opening a thread that will
    // never be answered.
    return {
      error: {
        status: 409,
        msg: "This station has no vendor account on FuelMart yet, so it cannot be messaged. The admin team can help instead.",
        reason: "NO_VENDOR_ACCOUNT",
      },
    };
  }

  const existing = await Conversation.findOne({
    kind: "customer_vendor",
    customer: user.id,
    vendor: vendor.vendorId,
    booking: booking._id,
    status: { $in: LIVE_STATUSES },
  });
  if (existing) return { conversation: existing, created: false };

  const snapshot = await context.bookingSnapshot(booking._id, user.id, { role: "customer" });
  try {
    const conversation = await Conversation.create({
      kind: "customer_vendor",
      participants: [
        { user: user.id, role: "customer", lastReadAt: new Date() },
        { user: vendor.vendorId, role: "vendor" },
      ],
      customer: user.id,
      vendor: vendor.vendorId,
      station: vendor.stationId,
      booking: booking._id,
      subject: cleanSubject(subject) || `${DEFAULT_SUBJECT.customer_vendor}: ${booking.orderId || booking.fuelType}`,
      topic: cleanTopic(topic) === "other" ? "booking" : cleanTopic(topic),
      createdBy: user.id,
    });
    return { conversation, created: true, snapshot };
  } catch (err) {
    if (err?.code === 11000) {
      const conversation = await Conversation.findOne({
        kind: "customer_vendor",
        customer: user.id,
        vendor: vendor.vendorId,
        booking: booking._id,
        status: { $in: LIVE_STATUSES },
      });
      if (conversation) return { conversation, created: false };
    }
    throw err;
  }
}

/**
 * The booking snapshot for a booking this user may attach, or null.
 *
 * A customer may attach their own; a vendor may attach one at a station they
 * own. Both are checked against the database -- the request only supplies an id.
 */
async function attachableBooking(user, bookingId) {
  if (user.role === "vendor") {
    const Station = require("../../models/Station");
    const Booking = require("../../models/Booking");
    const mine = await Station.find({ owner: user.id }).select("_id").lean();
    const booking = await Booking.findOne({ _id: bookingId, station: { $in: mine.map((s) => s._id) } }).select("_id user");
    if (!booking) return null;
    return context.bookingSnapshot(booking._id, booking.user, { role: "vendor" });
  }
  return context.bookingSnapshot(bookingId, user.id, { role: "customer" });
}

/**
 * A page of the threads this user may see, newest activity first.
 *
 * The visibility filter comes from access.listFilter() and is applied here, so
 * no caller can list threads by passing their own filter. `q` searches the
 * subject and the last message (the text index on Conversation); `kind`,
 * `status` and `bookingId` narrow it for the admin centre's tabs.
 */
async function listConversations(user, { kind, status, q, bookingId, stationId, limit = 25, page = 1 } = {}) {
  const filter = { ...access.listFilter(user) };

  if (kind && Conversation.KINDS.includes(kind)) {
    // An admin may narrow to one tab; a non-admin's own filter still applies,
    // so asking for a kind they cannot see returns nothing rather than more.
    filter.kind = filter.kind && filter.kind.$in ? (filter.kind.$in.includes(kind) ? kind : "__none__") : kind;
  }
  if (status && Conversation.STATUSES.includes(status)) filter.status = status;
  if (bookingId && access.objectId(bookingId)) filter.booking = bookingId;
  if (stationId && access.objectId(stationId)) filter.station = stationId;
  if (q && String(q).trim()) filter.$text = { $search: String(q).trim().slice(0, 120) };

  const perPage = Math.min(Math.max(Number(limit) || 25, 1), 50);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * perPage;

  const [rows, total] = await Promise.all([
    Conversation.find(filter)
      .populate("customer", "name email phone")
      .populate("vendor", "name businessName email phone vendorCode")
      .populate("station", "name address status")
      .populate("booking", "orderId fuelType bookingDate timeSlot status paymentStatus")
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(perPage)
      .lean(),
    Conversation.countDocuments(filter),
  ]);

  return {
    conversations: rows.map((row) => publicConversation(row, user)),
    total,
    page: Math.max(Number(page) || 1, 1),
    pages: Math.max(Math.ceil(total / perPage), 1),
    perPage,
  };
}

/** How many threads are waiting on this user's side, for the badge. */
async function unreadSummary(user) {
  const filter = { ...access.listFilter(user), status: { $in: LIVE_STATUSES } };
  const side = user.role === "admin" ? "admin" : user.role === "vendor" ? "vendor" : "customer";
  const [threads, messages] = await Promise.all([
    Conversation.countDocuments({ ...filter, [`unread.${side}`]: { $gt: 0 } }),
    Conversation.aggregate([{ $match: { ...filter } }, { $group: { _id: null, n: { $sum: `$unread.${side}` } } }]),
  ]);
  return { threads, messages: messages[0]?.n ?? 0, side };
}

/**
 * Move a thread through its lifecycle. Admin only, and recorded in the thread.
 *
 * Reopening is included on purpose (resolved -> open): a customer who replies
 * to a thread the team thought was finished should not have to start again.
 */
async function setStatus(adminUser, conversationId, status) {
  if (adminUser.role !== "admin") return { error: { status: 403, msg: "Only an admin can change a conversation's status." } };
  if (!Conversation.STATUSES.includes(status)) return { error: { status: 400, msg: "Unknown conversation status." } };

  const conversation = await Conversation.findById(conversationId);
  if (!conversation || !access.canRead(conversation, adminUser)) {
    return { error: { status: 404, msg: "Conversation not found." } };
  }
  if (conversation.status === status) return { conversation, changed: false };

  const settled = status === "resolved" || status === "closed";
  conversation.status = status;
  conversation.closedAt = settled ? new Date() : null;
  conversation.assignedAdmin = adminUser.id;
  await conversation.save();

  return { conversation, changed: true };
}

// ── shaping ────────────────────────────────────────────────────────────────

/**
 * The thread as a client may see it.
 *
 * Per role, and by listing fields rather than deleting them: a new field on the
 * schema is invisible until someone decides it belongs here. A customer is
 * never told which admin answered (the team answers, and naming one invites
 * "I want that person again"), and never sees the other side's contact details.
 */
function publicConversation(row, user) {
  const c = context.plain(row);
  const isAdmin = user?.role === "admin";
  const side = access.sideOf(c, user);

  const base = {
    conversationId: String(c._id),
    kind: c.kind,
    subject: c.subject,
    topic: c.topic,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastMessage: c.lastMessage?.at
      ? {
          text: c.lastMessage.text || "",
          at: c.lastMessage.at,
          senderRole: c.lastMessage.senderRole || null,
        }
      : null,
    // Only this viewer's own count. A customer has no business knowing how
    // many messages the admin team has not read.
    unread: side ? c.unread?.[side] ?? 0 : 0,
    booking: c.booking
      ? {
          bookingId: String(c.booking._id || c.booking),
          reference: c.booking.orderId ?? null,
          fuelType: c.booking.fuelType ?? null,
          bookingDate: c.booking.bookingDate ?? null,
          timeSlot: c.booking.timeSlot ?? null,
          status: c.booking.status ?? null,
          paymentStatus: c.booking.paymentStatus ?? null,
        }
      : null,
    station: c.station
      ? {
          stationId: String(c.station._id || c.station),
          name: c.station.name ?? null,
          address: c.station.address ?? null,
          status: c.station.status ?? null,
        }
      : null,
  };

  // The counterparty, at the level of detail each viewer needs.
  if (isAdmin) {
    // The admin centre's list is expected to identify the account: that is what
    // "view customer conversations" and "vendor name, station name, station id"
    // mean. It stays inside the admin console.
    base.customer = c.customer
      ? {
          userId: String(c.customer._id || c.customer),
          name: c.customer.name ?? null,
          email: c.customer.email ?? null,
          phone: c.customer.phone ?? null,
        }
      : null;
    base.vendor = c.vendor
      ? {
          userId: String(c.vendor._id || c.vendor),
          name: c.vendor.name ?? null,
          businessName: c.vendor.businessName ?? null,
          vendorCode: c.vendor.vendorCode ?? null,
          email: c.vendor.email ?? null,
          phone: c.vendor.phone ?? null,
        }
      : null;
    base.unreadBySide = { ...(c.unread || {}) };
    base.assignedAdmin = c.assignedAdmin ? String(c.assignedAdmin._id || c.assignedAdmin) : null;
  } else if (c.kind === "customer_vendor") {
    // The two sides of a booking see each other by name only -- enough to know
    // who they are talking to, and nothing that is not needed for the booking.
    base.counterparty =
      side === "customer"
        ? { role: "vendor", name: c.vendor?.businessName || c.vendor?.name || "Station team" }
        : { role: "customer", name: c.customer?.name || "Customer" };
  } else {
    base.counterparty = { role: "admin", name: "FuelMart support" };
  }

  return base;
}

/** "" for anything unusable; the model requires a real subject. */
function cleanSubject(value) {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return text.slice(0, 140);
}

/** A topic from the fixed list, or "other". Never free text. */
function cleanTopic(value) {
  const topic = String(value || "").trim().toLowerCase();
  return Conversation.TOPICS.includes(topic) ? topic : "other";
}

module.exports = {
  LIVE_STATUSES,
  findLiveAdminThread,
  openAdminThread,
  openVendorThread,
  attachableBooking,
  listConversations,
  unreadSummary,
  setStatus,
  publicConversation,
  cleanSubject,
  cleanTopic,
  isObjectId: (v) => Boolean(access.objectId(v)) && mongoose.Types.ObjectId.isValid(String(v)),
};
