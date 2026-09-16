/**
 * Vendor secret code: issue, store, verify.
 *
 * The code is the credential that turns an admin's approval into actual
 * vendor-dashboard access. Everything security-relevant about it lives here,
 * so there is exactly one place to audit and one place to change a policy.
 *
 * Design notes, and why each is what it is:
 *
 *   Unpredictable   crypto.randomInt, never Math.random. 10 characters from a
 *                   32-symbol alphabet is 50 bits -- about 1.1e15 codes. With
 *                   the attempt cap below, guessing is not a threat model.
 *
 *   Never derived   The code is drawn from the CSPRNG and has no relationship
 *                   to the vendor's id, email, phone or registration number.
 *                   A derived code is guessable by anyone who knows the
 *                   input, which for an email address is everyone.
 *
 *   Hashed at rest  Only a bcrypt hash is stored, and the field is
 *                   `select: false` so it does not even come back on an
 *                   ordinary query. A database dump therefore does not hand
 *                   anyone a set of working vendor logins.
 *
 *   Reusable        A correct code opens the vendor panel every time it is
 *                   entered. It is never marked used and its hash is kept, so
 *                   the vendor can come back with the same code. It stays
 *                   active until an admin reissues it (which overwrites the
 *                   hash and so revokes the old code) or the vendor is no
 *                   longer approved (routes/vendorAccessRoutes.js checks status).
 *
 *   First-use window A code nobody has used yet stops working after TTL_HOURS,
 *                   so an approval email that was never acted on does not stay
 *                   a live credential. The first successful use clears that
 *                   deadline; from then on the code does not expire.
 *
 *   Attempt-capped  MAX_ATTEMPTS wrong guesses in a row lock the code until an
 *                   admin reissues it -- a deliberate speed bump rather than
 *                   something an attacker can grind past. A successful use
 *                   resets the count.
 *
 * The plaintext exists only inside issueSecretCode's return value, long
 * enough to be put in one email. It is never stored, never logged, never
 * returned to an admin, and never sent to any frontend.
 */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");

// No I/O/0/1: these are read off a screen and typed back by hand, and those
// four are where that goes wrong.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;
// Printed as XXXXX-XXXXX so it can be read aloud and typed without losing
// your place. The dash is cosmetic; normalise() strips it.
const GROUP_SIZE = 5;

const TTL_HOURS = 48;
const MAX_ATTEMPTS = 5;
const BCRYPT_ROUNDS = 10;

/** A fresh, cryptographically secure code. Plaintext -- handle accordingly. */
function generateSecretCode() {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return out.match(new RegExp(`.{1,${GROUP_SIZE}}`, "g")).join("-");
}

/**
 * Codes are compared case-insensitively, ignoring spaces and dashes the
 * vendor may have copied out of the email or typed from memory.
 */
function normalise(input) {
  return String(input || "").toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Issue a code for `vendor`, mutating the document but NOT saving it -- the
 * caller saves, so issuing and whatever else the approval changes commit
 * together or not at all.
 *
 * @returns {Promise<{code: string, expiresAt: Date}>} plaintext, for the email only
 */
async function issueSecretCode(vendor) {
  const code = generateSecretCode();
  const now = new Date();

  vendor.secretCodeHash = await bcrypt.hash(normalise(code), BCRYPT_ROUNDS);
  vendor.secretCodeCreatedAt = now;
  vendor.secretCodeExpiresAt = new Date(now.getTime() + TTL_HOURS * 3600 * 1000);
  vendor.secretCodeUsed = false;
  vendor.secretCodeAttempts = 0;
  // Reissuing revokes whatever access a previous code granted, so the vendor
  // has to redeem the new one. Otherwise "reissue" would be a no-op for an
  // already-activated account and could not be used to recover one.
  vendor.activated = false;

  return { code, expiresAt: vendor.secretCodeExpiresAt };
}

/** Machine-readable outcomes. The route maps these to messages and statuses. */
const RESULT = {
  OK: "OK",
  NO_CODE: "NO_CODE",
  /** No longer active: consumed under the old single-use policy, before codes became reusable. */
  REVOKED: "REVOKED",
  EXPIRED: "EXPIRED",
  TOO_MANY_ATTEMPTS: "TOO_MANY_ATTEMPTS",
  INVALID: "INVALID",
};

/**
 * Check `code` against the vendor's stored hash and all the conditions that
 * have to hold for it to be accepted.
 *
 * Mutates `vendor` (attempt count on failure; on success: attempts reset,
 * first-use deadline cleared, activated, last-used time) but does not save --
 * again, the caller owns the transaction boundary. A successful check never
 * consumes the code.
 *
 * The vendor document MUST have been loaded with `.select("+secretCodeHash")`;
 * the field is hidden by default.
 *
 * @returns {Promise<{result: string, attemptsLeft?: number}>}
 */
async function verifySecretCode(vendor, code) {
  if (!vendor.secretCodeHash) {
    // The old single-use policy cleared the hash on redemption; such a code can
    // never be presented again and reads as revoked until an admin reissues.
    return { result: vendor.secretCodeUsed ? RESULT.REVOKED : RESULT.NO_CODE };
  }

  if (vendor.secretCodeExpiresAt && vendor.secretCodeExpiresAt.getTime() <= Date.now()) {
    return { result: RESULT.EXPIRED };
  }

  if ((vendor.secretCodeAttempts || 0) >= MAX_ATTEMPTS) {
    return { result: RESULT.TOO_MANY_ATTEMPTS };
  }

  // bcrypt.compare is constant-time with respect to the digest, so a wrong
  // code cannot be narrowed down by timing the response.
  const ok = await bcrypt.compare(normalise(code), vendor.secretCodeHash);

  if (!ok) {
    vendor.secretCodeAttempts = (vendor.secretCodeAttempts || 0) + 1;
    const attemptsLeft = Math.max(0, MAX_ATTEMPTS - vendor.secretCodeAttempts);
    return { result: RESULT.INVALID, attemptsLeft };
  }

  // Accepted, and NOT consumed: the hash stays so the same code works next
  // time. Once used, the first-use deadline no longer applies -- the code
  // stays active until an admin reissues it.
  vendor.secretCodeUsed = false;
  vendor.secretCodeExpiresAt = null;
  vendor.secretCodeAttempts = 0;
  vendor.secretCodeLastUsedAt = new Date();
  vendor.activated = true;

  return { result: RESULT.OK };
}

/**
 * Clear codes that passed their first-use deadline without ever being used.
 *
 * verifySecretCode already refuses an expired code, so this is hygiene rather
 * than enforcement: it stops the collection accumulating dead hashes. A code
 * that has been used has no deadline (secretCodeExpiresAt is null) and is
 * never touched here.
 *
 * A Mongo TTL index cannot do this job -- TTL deletes the whole document, and
 * the document here is the vendor's user account.
 *
 * @param {import("mongoose").Model} User
 * @returns {Promise<number>} rows cleared
 */
async function sweepExpired(User) {
  const res = await User.updateMany(
    { secretCodeExpiresAt: { $lt: new Date() }, secretCodeUsed: false },
    {
      $set: { secretCodeHash: null, secretCodeExpiresAt: null },
      $unset: { secretCodeAttempts: "" },
    },
  );
  return res.modifiedCount || 0;
}

module.exports = {
  generateSecretCode,
  issueSecretCode,
  verifySecretCode,
  normalise,
  sweepExpired,
  RESULT,
  TTL_HOURS,
  MAX_ATTEMPTS,
  CODE_LENGTH,
};
