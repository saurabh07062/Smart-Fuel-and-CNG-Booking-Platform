/**
 * Real-time event bus. The one place that decides who receives what.
 *
 * WHAT THIS REPLACES
 *
 * Before this, the socket layer had two defects that made it unusable as a
 * security boundary:
 *
 *   1. Connections were unauthenticated. The `identify` handler joined
 *      whatever room the client asked for, so any browser could send
 *      { role: "admin" } and start receiving every administrative event.
 *
 *   2. Almost every emit was `io.emit(...)` -- a broadcast to every connected
 *      socket. Booking payloads carry a customer's name, plate and amount, so
 *      every open tab received every other customer's bookings.
 *
 * Both are fixed here: identity comes from the JWT and nowhere else, and
 * every helper below targets a room rather than the whole server.
 *
 * ROOMS
 *
 *   user:<id>       one customer. Their bookings, their notifications.
 *   vendor:<id>     one vendor. Their stations' bookings and alerts.
 *   admin           every admin. Platform-wide activity.
 *   station:<id>    anyone currently looking at that station -- price and
 *                   availability changes. Joined on demand via `watch`,
 *                   because a customer browsing a station is not otherwise
 *                   related to it.
 *
 * ORDERING RULE
 *
 * Every emit helper here is called AFTER the database write has resolved.
 * Emitting first would let a client render a change that a failed save then
 * rolled back, and there is no second event to correct it.
 */

const mongoose = require("mongoose");

/**
 * Event names.
 *
 * Each event goes out under TWO names, and the reason is compatibility, not
 * indecision:
 *
 *   canonical  "booking:updated"   the namespaced convention
 *   legacy     "booking_updated"   what the shipped frontend already listens
 *                                  for (js/app.js), and what a browser with a
 *                                  cached bundle will still be listening for
 *                                  after this deploys
 *
 * Emitting both means the running client keeps working through the rollout
 * and the new client gets the clean name. `emitBoth` below is the only place
 * that knows about the pairing, so dropping the legacy half later is a
 * one-line change here rather than an audit of every call site.
 */
const EVENTS = {
  FUEL_PRICE_UPDATED: "fuelPrice:updated",
  FUEL_AVAILABILITY_UPDATED: "fuelAvailability:updated",
  STATION_STATUS_UPDATED: "station:statusChanged",
  STATION_CREATED: "station:created",
  STATION_UPDATED: "station:updated",
  STATION_DELETED: "station:deleted",
  BOOKING_CREATED: "booking:created",
  BOOKING_UPDATED: "booking:updated",
  BOOKING_CANCELLED: "booking:cancelled",
  BOOKING_COMPLETED: "booking:completed",
  QUEUE_UPDATED: "queue:updated",
  SLOT_UPDATED: "slot:updated",
  INVENTORY_UPDATED: "inventory:updated",
  VENDOR_REQUEST_CREATED: "vendor:requestCreated",
  VENDOR_APPROVED: "vendor:approved",
  VENDOR_STATUS_CHANGED: "vendor:statusChanged",
  NOTIFICATION_CREATED: "notification:created",
  NEAREST_STATION_UPDATED: "nearestStation:updated",
  ADMIN_ACTIVITY: "admin:activity",
};

/** canonical -> the older name the shipped frontend still binds to. */
const LEGACY_ALIAS = {
  "station:created": "station_created",
  "station:updated": "station_updated",
  "station:deleted": "station_deleted",
  "station:statusChanged": "station_status_updated",
  "fuelPrice:updated": "fuel_price_updated",
  "fuelAvailability:updated": "fuel_availability_updated",
  "booking:created": "new_booking",
  "booking:updated": "booking_updated",
  "booking:cancelled": "booking_updated",
  "booking:completed": "booking_updated",
  "vendor:approved": "vendor_approved",
  "notification:created": "notification_created",
};

/**
 * legacy -> canonical, the reverse of LEGACY_ALIAS.
 *
 * Several controllers still call emitStationEvent(req, "station_updated", ...)
 * with the LEGACY name. emitBoth() only knew canonical -> legacy, so those calls
 * sent "station_updated" alone and never the canonical "station:updated" that
 * current clients bind to -- nine station changes (status toggles, inventory,
 * queue after a booking status change, admin station edits) were invisible to
 * them. Normalising here fixes every such call site in one place and still
 * sends the legacy alias for cached bundles. First mapping wins, so
 * "booking_updated" resolves to "booking:updated".
 */
const CANONICAL_FROM_LEGACY = {};
for (const [canonical, legacy] of Object.entries(LEGACY_ALIAS)) {
  if (!(legacy in CANONICAL_FROM_LEGACY)) CANONICAL_FROM_LEGACY[legacy] = canonical;
}

let ioRef = null;

/**
 * Real-time logging.
 *
 * On by default. The whole point of this layer is that things happen without
 * anyone clicking refresh -- which also means that when it is NOT working
 * there is nothing on screen and nothing in the terminal to say so. Silence
 * looked identical to success.
 *
 * Set RT_LOG=off in .env to silence it (a busy production server does not
 * want a line per event); RT_LOG=verbose adds the payload.
 */
const RT_LOG = String(process.env.RT_LOG || "on").toLowerCase();
const LOG_ON = RT_LOG !== "off" && RT_LOG !== "false" && RT_LOG !== "0";
const LOG_VERBOSE = RT_LOG === "verbose";

function rtLog(msg, extra) {
  if (!LOG_ON) return;
  const t = new Date().toTimeString().slice(0, 8);
  if (extra !== undefined && LOG_VERBOSE) {
    console.log(`[realtime ${t}] ${msg}`, extra);
  } else {
    console.log(`[realtime ${t}] ${msg}`);
  }
}

/** How many sockets are currently in a room -- i.e. who will actually get this. */
function roomSize(room) {
  if (!ioRef) return 0;
  const r = ioRef.sockets.adapter.rooms.get(room);
  return r ? r.size : 0;
}

/** Called once from server.js with the Socket.IO server. */
function init(io) {
  ioRef = io;
  rtLog(
    `ready -- logging ${LOG_VERBOSE ? "VERBOSE" : "on"} (set RT_LOG=off in .env to silence)`,
  );

  /**
   * Authenticate every connection before it can join anything.
   *
   * The browser sends the httpOnly fm_access session cookie with the
   * handshake; scripts and tests may pass a token in `auth.token` instead.
   * Either is checked exactly like an HTTP request (services/security/session.js):
   * HS256 only, the user must still exist, and a tokenVersion bumped by "log
   * out everywhere" is refused. Anonymous connections are still permitted --
   * a signed-out visitor browsing stations legitimately wants live prices --
   * but they get no identity and can only ever join public station rooms.
   */
  io.use(async (socket, next) => {
    const session = require("../security/session");
    const { ACCESS_COOKIE } = require("../../config/auth");
    const token =
      session.readCookie(socket.request.headers.cookie, ACCESS_COOKIE) ||
      (socket.handshake.auth && socket.handshake.auth.token) ||
      socket.handshake.query.token ||
      "";

    socket.data.user = null; // anonymous, public rooms only -- unless the token proves otherwise
    if (!token) return next();

    try {
      const identity = await session.resolveAccessToken(token);
      // Role is NOT taken from the token payload; joinIdentityRooms reads it
      // from the database, so a forged claim cannot promote anyone. A bad,
      // expired or revoked token downgrades to anonymous rather than refusing
      // the connection: live station data must keep flowing.
      if (identity) socket.data.user = { id: identity.id };
    } catch (err) {
      console.error("[realtime] could not verify the handshake:", err.message);
    }
    return next();
  });

  io.on("connection", (socket) => {
    // Handlers are registered BEFORE the identity lookup below, never after.
    // The client emits watch_station the instant it connects (and re-emits
    // every watched station after a reconnect). When these handlers were
    // attached only after `await joinIdentityRooms()`, anything that arrived
    // during that database round trip had no listener and was silently
    // dropped: the socket never joined its station rooms, so live prices,
    // queues and slots only appeared after a manual page refresh.
    joinIdentityRooms(socket).then(() => {
      const who = socket.data.user
        ? `${socket.data.user.role || "user"} ${socket.data.user.id}`
        : "anonymous";
      rtLog(`+ connect   ${socket.id}  (${who})  total=${io.engine.clientsCount}`);
    });

    socket.on("disconnect", (reason) => {
      rtLog(`- disconnect ${socket.id}  (${reason})  total=${io.engine.clientsCount}`);
    });

    /**
     * Follow a station's price and availability.
     *
     * Public on purpose -- station prices are shown to signed-out visitors --
     * but bounded: the id must be a real ObjectId, and a socket may not hold
     * more than MAX_WATCHED at once, so this cannot be used to enumerate
     * rooms or exhaust memory.
     */
    socket.on("watch_station", (stationId) => {
      if (!mongoose.Types.ObjectId.isValid(String(stationId))) return;
      const watched = [...socket.rooms].filter((r) => r.startsWith("station:"));
      const MAX_WATCHED = 25;
      if (watched.length >= MAX_WATCHED) {
        rtLog(`  watch refused ${socket.id} -- already watching ${MAX_WATCHED} stations`);
        return;
      }
      socket.join(`station:${stationId}`);
      rtLog(`  watch      ${socket.id} -> station:${stationId}`);
    });

    socket.on("unwatch_station", (stationId) => {
      if (!mongoose.Types.ObjectId.isValid(String(stationId))) return;
      socket.leave(`station:${stationId}`);
      rtLog(`  unwatch    ${socket.id} -> station:${stationId}`);
    });

    /**
     * The old client-trusted `identify` event.
     *
     * Kept so an older cached bundle does not sit in a broken state, but it
     * no longer grants anything: rooms are decided by the verified token
     * above. Re-running the join is harmless and self-correcting.
     */
    socket.on("identify", () => joinIdentityRooms(socket));
  });

  return io;
}

/**
 * Put a socket in the rooms its verified identity entitles it to.
 *
 * The role is read from the database rather than the token, so revoking a
 * vendor or demoting an admin takes effect on their next connection instead
 * of whenever their 5-hour token happens to expire.
 */
async function joinIdentityRooms(socket) {
  const identity = socket.data.user;
  if (!identity) return;

  try {
    const User = require("../../models/User");
    const user = await User.findById(identity.id).select("role vendorStatus activated").lean();
    if (!user) {
      socket.data.user = null;
      return;
    }

    socket.data.user.role = user.role;
    socket.join(`user:${identity.id}`);
    rtLog(`  join       user:${identity.id}  (${user.role})`);

    if (user.role === "admin") {
      socket.join("admin");
      rtLog(`  join       admin room  (${identity.id})`);
    }

    // A vendor gets their private room only once they are actually approved
    // AND activated -- the same two conditions middleware/vendor.js applies
    // to the HTTP API. Otherwise a pending applicant would receive the
    // bookings of the station they have not been granted yet.
    if (user.role === "vendor" && user.vendorStatus === "active" && user.activated) {
      socket.join(`vendor:${identity.id}`);
      rtLog(`  join       vendor:${identity.id}`);
    } else if (user.role === "vendor") {
      // Worth saying out loud: a vendor who is pending or has not redeemed
      // their code gets no vendor room, and would otherwise just silently
      // receive nothing.
      rtLog(
        `  join SKIPPED vendor:${identity.id} -- status=${user.vendorStatus} activated=${user.activated}`,
      );
    }
  } catch (err) {
    console.error("[realtime] could not resolve identity:", err.message);
  }
}

// --------------------------------------------------------------- emitting

function io() {
  return ioRef;
}

/**
 * Emit to one room under both the canonical and legacy names.
 *
 * A client that binds to both would see one logical change twice, so the
 * frontend service (js/realtime.js) binds to the canonical name only and
 * ignores the alias. The alias exists purely for bundles cached before this
 * shipped.
 */
function emitBoth(room, eventName, payload) {
  // Accept either name; always send canonical + its legacy alias exactly once.
  const event = CANONICAL_FROM_LEGACY[eventName] || eventName;
  ioRef.to(room).emit(event, payload);
  const legacy = LEGACY_ALIAS[event];
  if (legacy && legacy !== event) ioRef.to(room).emit(legacy, payload);

  // The count is the useful part: "-> 0 clients" is the difference between
  // "the event fired and nobody was listening" and "the event never fired",
  // which are the two failures that look identical from the browser.
  const n = roomSize(room);
  rtLog(`  emit ${event}  -> ${room}  (${n} client${n === 1 ? "" : "s"})`, payload);
}

/** Emit to one room. No-op before init, so tests and scripts can call freely. */
function toRoom(room, event, payload) {
  if (!ioRef || !room) return false;
  emitBoth(room, event, payload);
  return true;
}

function toUser(userId, event, payload) {
  if (!userId) return false;
  return toRoom(`user:${String(userId)}`, event, payload);
}

function toVendor(vendorId, event, payload) {
  if (!vendorId) return false;
  return toRoom(`vendor:${String(vendorId)}`, event, payload);
}

function toAdmins(event, payload) {
  return toRoom("admin", event, payload);
}

function toStation(stationId, event, payload) {
  if (!stationId) return false;
  return toRoom(`station:${String(stationId)}`, event, payload);
}

/**
 * A station change reaches three different audiences, and each needs a
 * different amount of the record:
 *
 *   - customers watching the station  -> the public view (no owner, no upi)
 *   - the owning vendor               -> their own station, in full
 *   - admins                          -> full, for the activity feed
 *
 * Sending the raw document to everyone is how `upiId` -- the account a
 * station's payments settle into -- would end up in every browser.
 */
function stationChanged(event, station, extra = {}) {
  if (!station) return;
  const id = station._id || station.id;
  const publicView = publicStation(station);

  toStation(id, event, { ...publicView, ...extra });
  if (station.owner) toVendor(station.owner, event, { ...toPlain(station), ...extra });
  toAdmins(event, { ...toPlain(station), ...extra });
}

/**
 * The subset of a station any customer is allowed to see -- the same
 * whitelist the public REST endpoints use (services/station/publicStation.js),
 * so a socket payload can never show more than GET /api/stations does.
 */
function publicStation(station) {
  return require("../station/publicStation").publicStation(station);
}

function toPlain(doc) {
  if (!doc) return {};
  return typeof doc.toObject === "function" ? doc.toObject() : doc;
}

/**
 * A booking concerns exactly two parties plus the platform operator. It is
 * never broadcast: the payload carries the customer's name, vehicle plate and
 * the amount they paid.
 */
function bookingChanged(event, booking, { stationOwner } = {}) {
  if (!booking) return;
  const b = toPlain(booking);
  const customerId = b.user && (b.user._id || b.user);
  const owner = stationOwner || (b.station && b.station.owner);

  if (customerId) toUser(customerId, event, b);
  if (owner) toVendor(owner, event, b);
  toAdmins(event, b);
}

/**
 * Disconnect every live socket signed in as this user -- "log out everywhere"
 * (services/security/session.js revokeAllSessions). Their clients reconnect
 * on their own and, with the old token now refused, come back anonymous.
 */
function disconnectUser(userId) {
  if (!ioRef || !userId) return false;
  ioRef.in(`user:${String(userId)}`).disconnectSockets(true);
  rtLog(`  disconnect all sockets of user:${userId}`);
  return true;
}

module.exports = {
  EVENTS,
  LEGACY_ALIAS,
  init,
  io,
  toRoom,
  toUser,
  toVendor,
  toAdmins,
  toStation,
  stationChanged,
  bookingChanged,
  publicStation,
  disconnectUser,
};
