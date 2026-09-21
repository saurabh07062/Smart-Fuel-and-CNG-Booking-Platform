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

/**
 * The user with this address. New accounts are stored lowercase, so the exact
 * match (which uses the unique email index) finds almost everyone; only an
 * older mixed-case record falls through to the case-insensitive scan.
 * `project` is an optional .select() string; the result is a lean object when
 * `lean` is true, otherwise a document.
 */
async function findUserByEmail(value, { project, lean = false } = {}) {
  const User = require("../models/User");
  const email = normaliseEmail(value);
  if (!email) return null;
  const run = (filter) => {
    let q = User.findOne(filter);
    if (project) q = q.select(project);
    return lean ? q.lean() : q;
  };
  return (await run({ email })) || run(emailLookup(email));
}

module.exports = { normaliseEmail, emailLookup, findUserByEmail };
