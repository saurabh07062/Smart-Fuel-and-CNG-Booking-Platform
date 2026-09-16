/**
 * The vehicle a booking was made for, as denormalised display fields.
 *
 * A booking has always carried `vehiclePlate` -- the value the attendant
 * checks. The type and name are snapshotted beside it so the receipt and the
 * vendor/admin views can show "Bike · MH12AB1234" even after the customer
 * edits or deletes that saved vehicle, and so a one-time (unsaved) vehicle
 * still has its type recorded somewhere.
 *
 * Both fields are optional and advisory: an unknown type or an empty name is
 * stored as null rather than rejected, so an older client that never sends
 * them books exactly as before.
 */

const VEHICLE_TYPES = ["Car", "Bike", "Scooter", "Other"];
const MAX_NAME_LENGTH = 60;

function normaliseVehicleSnapshot({ vehicleType, vehicleName } = {}) {
  const type =
    typeof vehicleType === "string"
      ? VEHICLE_TYPES.find((t) => t.toLowerCase() === vehicleType.trim().toLowerCase())
      : undefined;
  const name = typeof vehicleName === "string" ? vehicleName.trim().slice(0, MAX_NAME_LENGTH) : "";

  return { vehicleType: type || null, vehicleName: name || null };
}

module.exports = { normaliseVehicleSnapshot, VEHICLE_TYPES, MAX_NAME_LENGTH };
