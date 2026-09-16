const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/fuelmart';

(async function main() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB — building indexes...');

    // Import models so their indexes are registered
    require('../../src/models/User');
    require('../../src/models/Booking');
    require('../../src/models/Station');

    // Wait for indexes to be created
    await Promise.all(Object.values(mongoose.models).map(m => m.createIndexes()));

    console.log('Indexes created successfully');
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Index creation failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
