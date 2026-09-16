/**
 * Email validation, shared by every place an address enters the system.
 *
 * This exists because nothing validated addresses at all: the User schema was
 * `{ type: String, required: true, unique: true }` and registration only
 * checked that the field was non-empty. A vendor registered as
 * "Saurabh8169@gmail.comt" -- one stray keystroke -- and the consequences
 * were not a cosmetic typo:
 *
 *   - the approval email went to a domain that does not exist, so they never
 *     received their secret code;
 *   - the code page looks them up by the address they actually own, finds no
 *     vendor, and returns the deliberately-generic "invalid or expired"
 *     message, so the screen gives no hint that the address is the problem;
 *   - and there is no way for them to fix it themselves, because the account
 *     they need to correct is the one they cannot reach.
 *
 * Catching it at the point of entry is the only cheap fix. Everything after
 * that point is expensive.
 */

// Deliberately not the RFC 5322 grammar. That accepts things no mail provider
// will ever route ("a@b", quoted locals, bare IP domains) and rejecting a
// realistic address is worse than accepting an exotic one -- so this is the
// pragmatic shape: something@something.tld, no spaces, a real TLD length.
const SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,24}$/;

/**
 * Domains that are only ever a mistyped popular provider.
 *
 * Listed rather than guessed at with edit distance: a fuzzy match would
 * eventually reject somebody's real, unusual domain, and being unable to
 * register at all is a much worse failure than a typo getting through. Every
 * entry here is a string no real mailbox uses.
 */
const TYPO_DOMAINS = {
  "gmail.comt": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.cpm": "gmail.com",
  "gmail.xom": "gmail.com",
  "gmail.ocm": "gmail.com",
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmaill.com": "gmail.com",
  "gnail.com": "gmail.com",
  "yahoo.comt": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "yaho.com": "yahoo.com",
  "hotmail.comt": "hotmail.com",
  "hotmail.con": "hotmail.com",
  "hotmial.com": "hotmail.com",
  "outlook.comt": "outlook.com",
  "outlook.con": "outlook.com",
  "rediffmail.con": "rediffmail.com",
};

/**
 * @param {string} raw
 * @returns {{ok: boolean, email?: string, reason?: string, msg?: string, suggestion?: string}}
 */
function validateEmail(raw) {
  const email = String(raw == null ? "" : raw).trim();

  if (!email) {
    return { ok: false, reason: "REQUIRED", msg: "Email address is required." };
  }

  if (email.length > 254) {
    return { ok: false, reason: "TOO_LONG", msg: "That email address is too long." };
  }

  if (!SHAPE.test(email)) {
    return {
      ok: false,
      reason: "MALFORMED",
      msg: "That does not look like a valid email address. Check for typos, and that it ends in something like .com",
    };
  }

  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  const suggestedDomain = TYPO_DOMAINS[domain];
  if (suggestedDomain) {
    const suggestion = email.slice(0, email.lastIndexOf("@") + 1) + suggestedDomain;
    return {
      ok: false,
      reason: "LIKELY_TYPO",
      suggestion,
      msg: `"${domain}" is not a real mail domain. Did you mean ${suggestion}?`,
    };
  }

  return { ok: true, email };
}

/** True/false form, for a Mongoose validator. */
function isValidEmail(raw) {
  return validateEmail(raw).ok;
}

module.exports = { validateEmail, isValidEmail, TYPO_DOMAINS };
