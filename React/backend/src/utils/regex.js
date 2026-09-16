/**
 * User-typed search text, matched literally as a case-insensitive substring.
 *
 * Every regex metacharacter is escaped, so input like "(a+)+$" can neither run
 * a catastrophic pattern (ReDoS) nor break the query with a syntax error, and
 * the length is capped so a huge string cannot make every comparison slow.
 */

const MAX_SEARCH_LENGTH = 100;

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A safe RegExp for a search box, or null when there is nothing to search.
 * Anything but a string -- ?q=a&q=b arrives as an array -- is nothing to search.
 */
function literalSearchRegex(input, { maxLength = MAX_SEARCH_LENGTH } = {}) {
  if (typeof input !== "string") return null;
  const text = input.trim().slice(0, maxLength);
  return text ? new RegExp(escapeRegex(text), "i") : null;
}

module.exports = { escapeRegex, literalSearchRegex, MAX_SEARCH_LENGTH };
