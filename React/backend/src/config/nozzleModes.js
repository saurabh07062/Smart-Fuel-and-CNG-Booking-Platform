/**
 * How each fuel's nozzles are split between app bookings (online) and walk-in
 * vehicles (offline), set by the station's vendor (Station.nozzleConfig):
 *
 *   { total: 4, online: 1 }   1 nozzle for app bookings, 3 for walk-ins. The two
 *                             run separately: walk-ins never hold up a booked
 *                             customer, and up to 3 walk-ins fuel at once.
 *   { total: 4, online: 0 }   walk-ins only: this fuel cannot be booked in the app.
 *   { total: 1, online: 1 }   one nozzle shared by bookings and walk-ins, first
 *                             come first served.
 *   not set                   the same shared single nozzle -- how every station
 *                             worked before this setting existed.
 *
 * Online nozzles are the fuel's booking RESOURCES: each serves one booked
 * vehicle at a time, and a booking window holds as many bookings as fit on
 * them (services/queue/slotAllocator.js). Not set = 1 resource.
 *
 * The one place the rule lives: booking creation, the station finder, the
 * walk-in queue, the nozzle hand-over and the live queue all ask here.
 */

const { normaliseFuel, fuelLabel } = require("./fuels");

const MAX_NOZZLES = 20;
const MAX_ONLINE_NOZZLES = MAX_NOZZLES;

/** The vendor's setup for one fuel, or null when never set. */
function nozzleConfigOf(station, fuelType) {
  const fuel = normaliseFuel(fuelType);
  const c = fuel ? station?.nozzleConfig?.[fuel] : null;
  const total = Number(c?.total);
  const online = Number(c?.online);
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(online) || online < 0 || online > total) return null;
  return { total, online };
}

/**
 * How many app nozzles (booking resources) this fuel has: the vendor's
 * online count, or 1 when the fuel has not been set up.
 */
function onlineResources(station, fuelType) {
  const c = nozzleConfigOf(station, fuelType);
  return c ? c.online : 1;
}

/** Can this fuel be booked in the app at this station? */
function acceptsOnline(station, fuelType) {
  const c = nozzleConfigOf(station, fuelType);
  return c ? c.online >= 1 : true;
}

/**
 * Nozzles kept for walk-ins, used separately from the app nozzle; 0 when
 * walk-ins share the single app nozzle (not set up, or 1 nozzle given online).
 */
function offlineNozzles(station, fuelType) {
  const c = nozzleConfigOf(station, fuelType);
  return c ? c.total - c.online : 0;
}

/** Do walk-ins have their own nozzles for this fuel (not the app nozzle)? */
const separateWalkIns = (station, fuelType) => offlineNozzles(station, fuelType) >= 1;

/** Customer-facing reason a fuel cannot be booked because no nozzle is online. */
const walkInOnlyMessage = (fuelType) =>
  `${fuelLabel(normaliseFuel(fuelType)) || "This fuel"} is walk-in only at this station right now (no app booking).`;

/**
 * Validate a vendor's { total, online } for one fuel.
 * @returns {{ok:true, value:{total:number, online:number}} | {ok:false, msg:string}}
 */
function parseNozzleConfig(input, label = "This fuel") {
  const total = Number(input?.total);
  const online = Number(input?.online);
  if (!Number.isInteger(total) || total < 1 || total > MAX_NOZZLES) {
    return { ok: false, msg: `${label}: total nozzles must be a whole number from 1 to ${MAX_NOZZLES}` };
  }
  if (!Number.isInteger(online) || online < 0 || online > MAX_ONLINE_NOZZLES) {
    return { ok: false, msg: `${label}: online nozzles must be a whole number from 0 to the total` };
  }
  if (online > total) return { ok: false, msg: `${label}: online nozzles cannot be more than the total` };
  return { ok: true, value: { total, online } };
}

module.exports = {
  MAX_NOZZLES,
  MAX_ONLINE_NOZZLES,
  nozzleConfigOf,
  acceptsOnline,
  offlineNozzles,
  onlineResources,
  separateWalkIns,
  walkInOnlyMessage,
  parseNozzleConfig,
};
