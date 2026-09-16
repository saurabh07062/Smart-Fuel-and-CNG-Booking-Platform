const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const Station = require('../../src/models/Station');

async function main() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/fuelmart';
  console.log('Connecting to', uri);
  // newer mongoose versions don't accept useNewUrlParser/useUnifiedTopology flags on the
  // connection string - pass only the URI and let mongoose use defaults
  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  try {
    const stations = await Station.find({});
    console.log(`Found ${stations.length} stations. Checking for CNG fields...`);

    let updated = 0;
    for (const s of stations) {
      let changed = false;
      // fuelTypes array
      if (!Array.isArray(s.fuelTypes) || !s.fuelTypes.includes('CNG')) {
        s.fuelTypes = Array.isArray(s.fuelTypes) ? s.fuelTypes.concat('CNG') : ['Petrol','Diesel','CNG'];
        changed = true;
      }

      // prices.cng
      if (!s.prices || typeof s.prices.cng === 'undefined' || s.prices.cng === null) {
        s.prices = s.prices || {};
        s.prices.cng = 75.5;
        changed = true;
      }

      // inventory.cng
      if (!s.inventory || typeof s.inventory.cng === 'undefined' || s.inventory.cng === null) {
        s.inventory = s.inventory || {};
        s.inventory.cng = 5000;
        changed = true;
      }

      if (changed) {
        await s.save();
        updated++;
        console.log(`Updated station: ${s._id} (${s.name || 'Unnamed'})`);
      }
    }

    console.log(`Done. Stations updated: ${updated}`);
  } catch (err) {
    console.error('Error while updating stations:', err);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected');
    process.exit(0);
  }
}

main();
