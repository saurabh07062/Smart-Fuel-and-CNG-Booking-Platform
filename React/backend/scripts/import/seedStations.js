/**
 * Seed realistic stations so discovery, ranking and the queue model have
 * something to work against.
 *
 *   node scripts/import/seedStations.js          # add missing, leave existing alone
 *   node scripts/import/seedStations.js --reset  # delete all stations first
 *
 * Coordinates are real Pune/Noida locations, and the nozzle counts and
 * service times vary deliberately so the M/M/c model produces genuinely
 * different wait times per station rather than one uniform number.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const Station = require("../../src/models/Station");

const SEED = [
  {
    name: "FuelMart Express - Shivajinagar",
    address: "JM Road, Shivajinagar, Pune, MH 411005",
    coordinates: { lat: 18.5314, lng: 73.8446 },
    fuelTypes: ["Petrol", "Diesel", "CNG"],
    prices: { petrol: 106.12, diesel: 92.98, cng: 87.0 },
    inventory: { petrol: 12000, diesel: 9000, cng: 4200 },
    nozzles: 6,
    avgServiceMinutes: 4,
    slotCapacity: 6,
    arrivalRatePerHour: 48,
    observedAvgQueueLength: 3.2,
    amenities: ["ATM", "Air Fill", "Restroom", "Cafe"],
    openingHours: "24 Hours",
    rating: 4.6,
  },
  {
    name: "QuickFuel - Kothrud",
    address: "Paud Road, Kothrud, Pune, MH 411038",
    coordinates: { lat: 18.5074, lng: 73.8077 },
    fuelTypes: ["Petrol", "Diesel"],
    prices: { petrol: 106.45, diesel: 93.2 },
    inventory: { petrol: 7000, diesel: 5200, cng: 0 },
    nozzles: 4,
    avgServiceMinutes: 5,
    slotCapacity: 4,
    arrivalRatePerHour: 40,
    observedAvgQueueLength: 4.1,
    amenities: ["ATM", "Restroom"],
    openingHours: "6:00 AM - 11:30 PM",
    rating: 4.4,
  },
  {
    name: "GreenFuel CNG - Viman Nagar",
    address: "Nagar Road, Viman Nagar, Pune, MH 411014",
    coordinates: { lat: 18.5679, lng: 73.9143 },
    fuelTypes: ["CNG"],
    prices: { petrol: 0, diesel: 0, cng: 86.5 },
    inventory: { petrol: 0, diesel: 0, cng: 6000 },
    nozzles: 3,
    avgServiceMinutes: 7,
    slotCapacity: 3,
    arrivalRatePerHour: 22,
    observedAvgQueueLength: 2.4,
    amenities: ["Restroom", "Water", "Cafe"],
    openingHours: "6:00 AM - 10:00 PM",
    rating: 4.8,
  },
  {
    name: "HighwayFuel - Hinjewadi Phase 1",
    address: "Hinjewadi Phase 1, Pune, MH 411057",
    coordinates: { lat: 18.5912, lng: 73.7389 },
    fuelTypes: ["Petrol", "Diesel", "CNG"],
    prices: { petrol: 105.9, diesel: 92.4, cng: 86.8 },
    inventory: { petrol: 15000, diesel: 14000, cng: 5000 },
    nozzles: 8,
    avgServiceMinutes: 4.5,
    slotCapacity: 8,
    arrivalRatePerHour: 75,
    observedAvgQueueLength: 5.5,
    amenities: ["ATM", "Air Fill", "Restroom", "Cafe", "Car Wash"],
    openingHours: "24 Hours",
    rating: 4.5,
  },
  {
    name: "CityFuel - Baner",
    address: "Baner Road, Baner, Pune, MH 411045",
    coordinates: { lat: 18.5642, lng: 73.7769 },
    fuelTypes: ["Petrol", "Diesel"],
    prices: { petrol: 106.8, diesel: 93.5 },
    // Deliberately low: exercises the low-stock alert and the
    // insufficient-inventory rejection path.
    inventory: { petrol: 900, diesel: 600, cng: 0 },
    nozzles: 2,
    avgServiceMinutes: 6,
    slotCapacity: 2,
    arrivalRatePerHour: 18,
    observedAvgQueueLength: 3.0,
    amenities: ["Restroom"],
    openingHours: "6:00 AM - 10:00 PM",
    rating: 4.1,
  },
  {
    name: "FuelMart Express - Koregaon Park",
    address: "North Main Road, Koregaon Park, Pune, MH 411001",
    coordinates: { lat: 18.5362, lng: 73.8939 },
    fuelTypes: ["Petrol", "Diesel", "CNG"],
    prices: { petrol: 96.72, diesel: 89.62, cng: 73.59 },
    inventory: { petrol: 11000, diesel: 8500, cng: 3800 },
    nozzles: 5,
    avgServiceMinutes: 5,
    slotCapacity: 5,
    arrivalRatePerHour: 52,
    observedAvgQueueLength: 3.8,
    amenities: ["ATM", "Air Fill", "Restroom", "Cafe"],
    openingHours: "6:00 AM - 11:00 PM",
    rating: 4.5,
  },
];

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

  if (process.argv.includes("--reset")) {
    const { deletedCount } = await Station.deleteMany({});
    console.log(`--reset: removed ${deletedCount} existing station(s)`);
  }

  let created = 0;
  let skipped = 0;

  for (const spec of SEED) {
    // Match on name so re-running does not duplicate.
    const existing = await Station.findOne({ name: spec.name });
    if (existing) {
      console.log(`  skip    ${spec.name} (already exists)`);
      skipped++;
      continue;
    }

    await Station.create({
      ...spec,
      availableTimeSlots: timeSlots(),
      status: "Active",
      queueLength: 0,
    });
    console.log(`  created ${spec.name}`);
    created++;
  }

  const total = await Station.countDocuments();
  console.log(`\nDone. created: ${created}, skipped: ${skipped}, total stations: ${total}`);

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
