/**
 * Add Torrent Gas CNG Station to the database.
 *
 *   node scripts/import/addTorrentGas.js
 *
 * Skips if a station with the same name already exists.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const Station = require("../../src/models/Station");

const STATION = {
  name: "Torrent Gas CNG Station",
  address: "Wankhede Petroleum, near Shangri-la, Wagholi, Pune, MH",
  coordinates: { lat: 18.5800, lng: 73.9820 },
  fuelTypes: ["CNG"],
  prices: { petrol: 0, diesel: 0, cng: 75.5 },
  inventory: { petrol: 0, diesel: 0, cng: 5000 },
  nozzles: 2,
  avgServiceMinutes: 7,
  slotCapacity: 2,
  arrivalRatePerHour: 20,
  observedAvgQueueLength: 2.0,
  amenities: ["Air", "Water"],
  openingHours: "6:00 AM - 10:00 PM",
  rating: 4.3,
};

function timeSlots() {
  const slots = [];
  for (let h = 6; h <= 21; h++) {
    for (const m of ["00", "30"]) {
      const hour12 = h % 12 === 0 ? 12 : h % 12;
      slots.push(`${hour12}:${m} ${h < 12 ? "AM" : "PM"}`);
    }
  }
  return slots;
}

(async () => {
  const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/fuelmart";
  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const existing = await Station.findOne({ name: STATION.name });
  if (existing) {
    console.log(`Station "${STATION.name}" already exists — skipping.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  const station = await Station.create({
    ...STATION,
    availableTimeSlots: timeSlots(),
    status: "Active",
    queueLength: 0,
  });

  console.log(`Created station: "${station.name}"`);
  console.log(`  ID:          ${station._id}`);
  console.log(`  Coordinates: ${station.coordinates.lat}, ${station.coordinates.lng}`);
  console.log(`  Fuel:        ${station.fuelTypes.join(", ")}`);
  console.log(`  CNG Price:   ₹${station.prices.cng}/kg`);

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("Failed to add station:", err);
  process.exit(1);
});
