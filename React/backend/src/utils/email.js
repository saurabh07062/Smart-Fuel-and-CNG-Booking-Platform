/**
 * Email addresses are identities, not text: "Saurabh@Gmail.com " and
 * "saurabh@gmail.com" are the same account. Store them trimmed and lowercase,
 * and look them up without regard to case, so an account created one way can
 * always sign in the other way.
 */

const { escapeRegex } = require("./regex");

/** Trimmed, lowercase, or "" for anything that is not a string. */
function normaliseEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * A Mongo filter matching exactly this address, ignoring case and surrounding
 * spaces. An empty value matches nothing (never "any account").
 */
function emailLookup(value) {
  const email = normaliseEmail(value);
  if (!email) return { _id: null };
  return { email: new RegExp(`^${escapeRegex(email)}$`, "i") };
}

module.exports = { normaliseEmail, emailLookup };
