/**
 * What any visitor may see of a station -- the one definition, shared by the
 * public REST endpoints (controllers/stationController.js) and the station
 * room's Socket.IO payloads (services/notification/realtime.js).
 *
 * A whitelist, not a blacklist: a field added to the Station schema later is
 * private until someone decides it belongs here. Never public:
 *
 *   owner, upiId, upiName, acceptsUpi   who owns it and where its payments settle
 *   inventory, inventoryCommitted,
 *   tankCapacity                        the station's stock position
 *   reviews                             reviewer identities
 *   pumpCounts, waitingCounts, activeFuelingCounts, nozzles, slotCapacity,
 *   availableTimeSlots, arrivalRatePerHour, observedAvgQueueLength,
 *   source, osmId, sourceUpdatedAt      internal model inputs and provenance
 *
 * The station's owner and admins get the full record through their own
 * authenticated routes (vendor panel, admin).
 */

const PUBLIC_STATION_FIELDS = Object.freeze([
  "_id",
  "name",
  "address",
  "city",
  "state",
  "brand",
  "status",
  "prices",
  "fuelTypes",
  "fuelAvailability",
  "nozzleConfig",
  "isBusy",
  "unavailableReason",
  "coordinates",
  "location",
  "openingHours",
  "operatingSchedule",
  "amenities",
  "images",
  "pumpImages",
  "rating",
  "queueLength",
  "waitMinutes",
  "queueStatus",
  "pricesUpdatedAt",
  "availabilityUpdatedAt",
  "createdAt",
  "updatedAt",
]);

/** Mongoose projection: the private fields are never even loaded for a public response. */
const PUBLIC_STATION_SELECT = PUBLIC_STATION_FIELDS.join(" ");

const toPlain = (doc) => (doc && typeof doc.toObject === "function" ? doc.toObject() : doc || {});

/** The public view of a station document (or lean object), with `id` beside `_id`. */
function publicStation(station) {
  const s = toPlain(station);
  const view = { id: s._id };
  for (const field of PUBLIC_STATION_FIELDS) {
    if (s[field] !== undefined) view[field] = s[field];
  }
  return view;
}

module.exports = { PUBLIC_STATION_FIELDS, PUBLIC_STATION_SELECT, publicStation };
