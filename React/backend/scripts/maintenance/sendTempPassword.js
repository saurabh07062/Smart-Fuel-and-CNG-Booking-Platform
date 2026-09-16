const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const User = require('../../src/models/User');
const emailService = require('../../src/services/notification/emailService');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/fuelmart';

function genPassword(len = 10) {
  // generate a URL-safe base64 and strip non-alphanum to be safe for emails
  return crypto.randomBytes(Math.ceil(len * 3 / 4)).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, len);
}

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node scripts/maintenance/sendTempPassword.js user@example.com');
    process.exit(1);
  }

  console.log('🔌 Connecting to MongoDB:', MONGO_URI);
  await mongoose.connect(MONGO_URI);

  const user = await User.findOne({ email });
  if (!user) {
    console.error(`❌ No user found with email: ${email}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const oldHash = user.password;
  const tempPassword = genPassword(12);
  const salt = await bcrypt.genSalt(10);
  const newHash = await bcrypt.hash(tempPassword, salt);

  user.password = newHash;
  await user.save();

  const subject = 'FuelMart — Temporary password';
  const html = `<p>Hi ${user.name || 'User'},</p>
    <p>A temporary password has been generated for your FuelMart account. Use the password below to sign in, then change your password from your profile.</p>
    <p><strong>Temporary password:</strong> <code>${tempPassword}</code></p>
    <p>If you did not request this, please contact support immediately.</p>
    <p>— FuelMart</p>`;

  console.log(`✉️  Sending temporary password to ${email} ...`);
  const sent = await emailService.sendMail({ to: email, subject, html, text: `Temporary password: ${tempPassword}` });

  if (!sent) {
    console.error('❌ Email failed to send. Reverting password change.');
    // revert to old password hash
    user.password = oldHash;
    await user.save();
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('✅ Temporary password sent successfully. Please check your inbox.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Error:', err && err.message ? err.message : err);
  process.exit(1);
});
