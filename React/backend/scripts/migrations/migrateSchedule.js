/**
 * Migration: Fix station operating schedules
 * 
 * Problem: Some stations have openingHours = "Closed" in the database,
 * which causes the UI to show "Station Closed" even though slots are available.
 *
 * This script:
 * 1. Finds all stations with openingHours = "Closed" or missing operatingSchedule
 * 2. Sets them to have proper 24-hour operating schedules
 * 3. Updates openingHours from "Closed" to "24 Hours"
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const Station = require('../../src/models/Station');

const DEFAULT_SCHEDULE = {
  monday:    { open: "06:00", close: "22:00", is24h: true, isClosed: false },
  tuesday:   { open: "06:00", close: "22:00", is24h: true, isClosed: false },
  wednesday: { open: "06:00", close: "22:00", is24h: true, isClosed: false },
  thursday:  { open: "06:00", close: "22:00", is24h: true, isClosed: false },
  friday:    { open: "06:00", close: "22:00", is24h: true, isClosed: false },
  saturday:  { open: "06:00", close: "22:00", is24h: true, isClosed: false },
  sunday:    { open: "06:00", close: "22:00", is24h: true, isClosed: false }
};

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/fuelmart');
  console.log("Connected to MongoDB.\n");

  // Find stations with "Closed" openingHours or missing/incomplete operatingSchedule
  const brokenStations = await Station.find({
    $or: [
      { openingHours: "Closed" },
      { operatingSchedule: { $exists: false } },
      { "operatingSchedule.monday": { $exists: false } }
    ]
  });

  console.log(`Found ${brokenStations.length} station(s) needing schedule fix.\n`);

  for (const st of brokenStations) {
    const oldHours = st.openingHours;
    
    st.openingHours = "24 Hours";
    st.operatingSchedule = DEFAULT_SCHEDULE;
    
    await st.save();
    console.log(`✅ Fixed: ${st.name}`);
    console.log(`   openingHours: "${oldHours}" → "24 Hours"`);
    console.log(`   operatingSchedule: Set to 24h all days\n`);
  }

  // Also update any stations with status "Inactive" that should be "Active"
  const inactiveStations = await Station.find({ status: "Inactive" });
  if (inactiveStations.length > 0) {
    console.log(`\nFound ${inactiveStations.length} inactive station(s):`);
    for (const st of inactiveStations) {
      console.log(`  ⚠️ ${st.name} — status: Inactive (not changed, review manually)`);
    }
  }

  // Verification
  console.log("\n── Verification ──────────────────────────────────────────");
  const allStations = await Station.find({});
  for (const st of allStations) {
    const scheduleStatus = st.isOpenNow();
    console.log(`${st.name}`);
    console.log(`  openingHours: ${st.openingHours}`);
    console.log(`  status: ${st.status}`);
    console.log(`  isOpenNow: ${scheduleStatus.isOpen}`);
    console.log(`  schedule: ${st.operatingSchedule?.monday?.is24h ? '24h' : st.operatingSchedule?.monday?.open + '-' + st.operatingSchedule?.monday?.close}`);
    console.log('');
  }

  await mongoose.disconnect();
  console.log("Done. Disconnected.");
}

migrate().catch(err => {
  console.error("Migration error:", err);
  process.exit(1);
});
