/**
 * Test fixture: occupy a booking window (a 30-minute slot label) on one fuel's
 * app nozzle with back-to-back bookings, as real customers would fill it
 * (services/queue/slotAllocator.js). By default the whole window is taken,
 * so the next booking is refused as full.
 *
 *   await fillWindow({ stationId, fuelType: "Petrol", date, label: "10:00 AM" });
 *   await fillWindow({ ..., leaveFree: 1 });   // all but the first position
 */

const mongoose = require("mongoose");

async function fillWindow({ stationId, fuelType, date, label, leaveFree = 0, resource = 1, status = "upcoming" }) {
  const Booking = require("../../src/models/Booking");
  const nozzleScheduler = require("../../src/services/queue/nozzleScheduler");
  const { getServiceDurationSeconds } = require("../../src/config/fuelDurations");
  const { SLOT_SPACING_SECONDS } = require("../../src/config/booking");

  const start = nozzleScheduler.parseStartDateTime(date, label).getTime();
  const seconds = getServiceDurationSeconds(fuelType);
  const fits = Math.floor(SLOT_SPACING_SECONDS / seconds);
  const rows = [];
  for (let k = leaveFree; k < fits; k++) {
    rows.push({
      user: new mongoose.Types.ObjectId(),
      station: stationId,
      fuelType,
      quantity: 5,
      price: 100,
      amount: 505,
      bookingDate: date,
      timeSlot: label,
      status,
      resource,
      bookingStartTime: new Date(start + k * seconds * 1000),
      bookingEndTime: new Date(start + (k + 1) * seconds * 1000),
      serviceDurationSeconds: seconds,
    });
  }
  await Booking.insertMany(rows);
  return { count: rows.length, fits, seconds };
}

module.exports = { fillWindow };
