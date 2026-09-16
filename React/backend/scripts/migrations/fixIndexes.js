const mongoose = require("mongoose");
const Booking = require("../../src/models/Booking");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/fuelmart";

const fixIndexes = async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Connected to MongoDB");

    const collection = Booking.collection;
    const indexes = await collection.indexes();
    console.log("Current indexes:", JSON.stringify(indexes, null, 2));

    // Drop the bookingId index if it exists
    for (const index of indexes) {
      if (index.key && index.key.bookingId) {
        console.log(`Dropping index: ${index.name}`);
        await collection.dropIndex(index.name);
        console.log("Dropped bookingId index");
      }
    }

    console.log("Index fix complete");
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
};

fixIndexes();