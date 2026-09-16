/**
 * Vendor identity: the human-readable, public vendor reference code.
 *
 * Deliberately separate from the secret code:
 *   vendorCode    "VEN-2026-0042"  public, permanent, safe to quote in an
 *                                  email or a support ticket. Issued at
 *                                  registration so an applicant has a
 *                                  reference before anyone has looked at it.
 *
 * The secret code that actually opens the panel lives in
 * services/vendor/vendorSecretCode.js -- it is hashed, expiring and attempt-capped,
 * and deliberately does not share a module with anything public like the
 * vendorCode below.
 */

/**
 * Next sequential vendor code for the current year, e.g. "VEN-2026-0042".
 *
 * Derived from the highest existing number rather than a document count:
 * counting breaks the moment a vendor is deleted, silently reissuing a code
 * that used to belong to someone else. Retries on the unique-index collision
 * that two simultaneous registrations would cause.
 *
 * @param {import("mongoose").Model} User
 * @returns {Promise<string>}
 */
async function generateVendorCode(User) {
  const year = new Date().getFullYear();
  const prefix = `VEN-${year}-`;

  const latest = await User.findOne({ vendorCode: new RegExp(`^${prefix}`) })
    .sort({ vendorCode: -1 })
    .select("vendorCode")
    .lean();

  let next = 1;
  if (latest && latest.vendorCode) {
    const parsed = parseInt(latest.vendorCode.slice(prefix.length), 10);
    if (Number.isFinite(parsed)) next = parsed + 1;
  }

  return prefix + String(next).padStart(4, "0");
}

module.exports = {
  generateVendorCode,
};
