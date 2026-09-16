/**
 * Add Wagholi Petrol Pump to the database.
 *
 *   node scripts/import/addWagholiPetrolPump.js
 *
 * This station is located in Wagholi, Pune — so when a user's location is
 * detected near Wagholi (~18.5738°, 73.9831°), this station will appear
 * as the closest petrol station and be recommended first.
 *
 * Skips if a station with the same name already exists.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const Station = require("../../src/models/Station");

const STATION = {
  name: "HP Petrol Pump - Wagholi",
  address: "Wagholi-Lohegaon Road, Wagholi, Pune, MH 412207",
  coordinates: { lat: 18.5762, lng: 73.9785 },
  fuelTypes: ["Petrol", "Diesel"],
  prices: { petrol: 106.31, diesel: 92.87, cng: 0 },
  inventory: { petrol: 12000, diesel: 9000, cng: 0 },
  nozzles: 4,
  pumpCounts: { petrol: 3, diesel: 2, cng: 0 },
  avgServiceMinutes: 4,
  slotCapacity: 4,
  arrivalRatePerHour: 35,
  observedAvgQueueLength: 2.5,
  amenities: ["Air Fill", "Water", "Restroom"],
  openingHours: "6:00 AM - 11:00 PM",
  rating: 4.4,
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
  console.log(`  Address:     ${station.address}`);
  console.log(`  Coordinates: ${station.coordinates.lat}, ${station.coordinates.lng}`);
  console.log(`  Fuel:        ${station.fuelTypes.join(", ")}`);
  console.log(`  Petrol:      ₹${station.prices.petrol}/L`);
  console.log(`  Diesel:      ₹${station.prices.diesel}/L`);

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("Failed to add station:", err);
  process.exit(1);
});
