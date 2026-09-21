/**
 * Deleting a station deletes everything that belongs to it.
 *
 * There were three delete paths and each removed a different subset: the
 * vendor panel took bookings, price history and employees; the admin endpoint
 * removed only the station document; deleting a vendor removed only their
 * stations. Stock movements, walk-ins, booking attempts, notifications and
 * pump photos were left behind every time -- records pointing at a station
 * that no longer exists. All three now call removeStations().
 *
 * Removed, for each station:
 *   Booking             its bookings (customers with an open one are told it
 *                       was cancelled first, so their screens update live)
 *   Notification        notifications about the station or any of its bookings
 *   BookingAttempt      booking attempts made at it
 *   InventoryMovement   its stock history
 *   WalkIn              its walk-in queue
 *   Employee            its staff
 *   PriceHistory        its price history
 *   files               its station photos and petrol/CNG pump photos
 *   Station             the station itself
 *
 * SecurityEvent rows are the platform's security audit log (who tried what,
 * from where); they are kept, with the station reference cleared.
 *
 * Order: dependents, then the station, then the dependents once more -- a
 * booking that slipped in during the first pass is caught by the second, and
 * a failure part-way leaves the station in place so the delete can be retried.
 */

const Station = require("../../models/Station");
const Booking = require("../../models/Booking");
const BookingAttempt = require("../../models/BookingAttempt");
const Employee = require("../../models/Employee");
const InventoryMovement = require("../../models/InventoryMovement");
const Notification = require("../../models/Notification");
const PriceHistory = require("../../models/PriceHistory");
const SecurityEvent = require("../../models/SecurityEvent");
const WalkIn = require("../../models/WalkIn");
const { removeUploadedFile } = require("../../middleware/upload");
const realtime = require("../notification/realtime");

/** Bookings still in progress: their customer is told before the row goes. */
const OPEN_STATUSES = ["upcoming", "waitlisted", "serving"];

async function removeDependents(stationIds) {
  const station = { $in: stationIds };
  const bookingIds = (await Booking.find({ station }).select("_id").lean()).map((b) => b._id);

  const [notifications, attempts, movements, walkIns, employees, prices, bookings, security] = await Promise.all([
    Notification.deleteMany({ $or: [{ station }, { booking: { $in: bookingIds } }] }),
    BookingAttempt.deleteMany({ station }),
    InventoryMovement.deleteMany({ station }),
    WalkIn.deleteMany({ station }),
    Employee.deleteMany({ station }),
    PriceHistory.deleteMany({ station }),
    Booking.deleteMany({ station }),
    SecurityEvent.updateMany({ station }, { $set: { station: null } }),
  ]);

  return {
    bookings: bookings.deletedCount,
    notifications: notifications.deletedCount,
    bookingAttempts: attempts.deletedCount,
    inventoryMovements: movements.deletedCount,
    walkIns: walkIns.deletedCount,
    employees: employees.deletedCount,
    priceHistory: prices.deletedCount,
    securityEventsUnlinked: security.modifiedCount,
  };
}

const add = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + (b[k] || 0)]));

/**
 * Delete stations and everything that belongs to them.
 *
 * @param {Array<string|import("mongoose").Types.ObjectId>} ids
 * @returns {Promise<{stations: number, removed: object, files: number}>}
 */
async function removeStations(ids) {
  const stationIds = (ids || []).filter(Boolean);
  if (stationIds.length === 0) return { stations: 0, removed: {}, files: 0 };

  const stations = await Station.find({ _id: { $in: stationIds } })
    .select("_id owner images pumpImages")
    .lean();
  const found = stations.map((s) => s._id);
  if (found.length === 0) return { stations: 0, removed: {}, files: 0 };

  // Customers with an open booking see it go, instead of a pass for a station
  // that no longer exists (their list refetches on this event).
  const open = await Booking.find({ station: { $in: found }, status: { $in: OPEN_STATUSES } }).lean();
  for (const booking of open) {
    const owner = stations.find((s) => String(s._id) === String(booking.station))?.owner;
    try {
      realtime.bookingChanged(realtime.EVENTS.BOOKING_CANCELLED, { ...booking, status: "cancelled" }, { stationOwner: owner });
    } catch (err) {
      console.error("[stationRemoval] could not announce a cancelled booking:", err.message);
    }
  }

  let removed = await removeDependents(found);
  const deleted = await Station.deleteMany({ _id: { $in: found } });
  removed = add(removed, await removeDependents(found));

  // Files last: only once no record refers to them.
  let files = 0;
  for (const s of stations) {
    for (const p of [...(s.images || []), s.pumpImages?.petrol, s.pumpImages?.cng]) {
      if (removeUploadedFile(p)) files += 1;
    }
  }

  for (const s of stations) {
    try {
      realtime.stationChanged(realtime.EVENTS.STATION_DELETED, { id: String(s._id), owner: s.owner });
    } catch (err) {
      console.error("[stationRemoval] could not announce the deletion:", err.message);
    }
  }

  return { stations: deleted.deletedCount, removed, files };
}

module.exports = { removeStations };
