/**
 * One-off migration for the vendor identity / activation fields.
 *
 * Two jobs, both safe to re-run:
 *
 *  1. Backfill `vendorCode` for every vendor that predates it, so no existing
 *     vendor is left without a reference number on their status page.
 *
 *  2. Grandfather `activated: true` onto vendors who are ALREADY
 *     vendorStatus:"active". They were approved under the old rules, where
 *     approval alone opened the panel. Without this they would all be locked
 *     out the moment middleware/vendor.js starts requiring activation --
 *     the new two-step gate is for vendors approved from now on, not a
 *     retroactive door slam on people already working.
 *
 * Run:  node scripts/migrations/migrateVendorIdentity.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const User = require("../../src/models/User");
const { generateVendorCode } = require("../../src/services/vendor/vendorIdentity");

(async () => {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/fuelmart");

  // 1. Grandfather already-approved vendors.
  const grandfathered = await User.updateMany(
    { role: "vendor", vendorStatus: "active", activated: { $ne: true } },
    { $set: { activated: true } },
  );

  // 2. Backfill vendor codes, one at a time so each gets the next number.
  const needCodes = await User.find({ role: "vendor", vendorCode: { $in: [null, undefined] } })
    .sort({ createdAt: 1 })
    .select("_id email");

  let coded = 0;
  for (const v of needCodes) {
    // eslint-disable-next-line no-await-in-loop -- sequential on purpose:
    // generateVendorCode reads the current max, so these cannot run parallel.
    const code = await generateVendorCode(User);
    // eslint-disable-next-line no-await-in-loop
    await User.updateOne({ _id: v._id }, { $set: { vendorCode: code } });
    coded += 1;
  }

  const summary = {
    grandfatheredActivated: grandfathered.modifiedCount || 0,
    vendorCodesBackfilled: coded,
    totalVendors: await User.countDocuments({ role: "vendor" }),
  };
  console.log(JSON.stringify(summary, null, 2));

  await mongoose.disconnect();
})().catch((err) => {
  console.error("[migrateVendorIdentity] failed:", err);
  process.exit(1);
});
