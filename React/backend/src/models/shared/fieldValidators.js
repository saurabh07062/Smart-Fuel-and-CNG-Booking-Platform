/**
 * Field rules shared by the schemas.
 *
 * One definition per rule, used by every model that stores that kind of
 * value, so a phone number means the same thing on a User, an Employee and a
 * Station and cannot drift apart between them.
 *
 * ── Why several of these only check a CHANGED value ──────────────────────
 * Mongoose validates every path on save(), not only the modified ones. A
 * strict rule applied to all paths would therefore refuse to save a document
 * that is years old and perfectly real -- approving a vendor whose phone was
 * stored as "+91 98765 43210" before the 10-digit rule existed would fail on
 * the phone field, which has nothing to do with the approval. So the rules
 * below run on a value that this save is actually writing and let an untouched
 * legacy value through. New and edited data is held to the full rule; history
 * is not rewritten, and no existing record becomes unsaveable.
 */

/** Ten digits, starting 6-9: an Indian mobile number, as the app stores it. */
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/** GSTIN: 2-digit state, 10-char PAN, entity digit, "Z", checksum. */
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}$/;

/** "YYYY-MM-DD", the India business date keys used across bookings. */
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** "HH:MM", 24-hour clock. */
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The 4-digit code a customer shows at the pump. */
const PIN = /^\d{4}$/;

/** A financial year as the invoice numbers carry it, "2026-27". */
const FINANCIAL_YEAR = /^\d{4}-\d{2}$/;

/** True when `path` is being written by this save (or the document is new). */
function writing(doc, path) {
  if (!doc || typeof doc.isModified !== "function") return true; // an update, not a document
  return doc.isNew || doc.isModified(path);
}

/**
 * A validator that applies `re` to a non-empty value, but only when this save
 * is writing that path. See the note at the top of this file.
 */
function onWrite(path, re, message) {
  return {
    validator(value) {
      if (!writing(this, path)) return true;
      if (value === undefined || value === null || value === "") return true; // "required" is a separate rule
      return re.test(String(value).trim());
    },
    message,
  };
}

module.exports = {
  INDIAN_MOBILE,
  GSTIN,
  DATE_KEY,
  CLOCK,
  PIN,
  FINANCIAL_YEAR,
  writing,
  onWrite,
  phoneValidator: (path = "phone") =>
    onWrite(path, INDIAN_MOBILE, (p) => `"${p.value}" is not a 10-digit Indian mobile number`),
  gstValidator: (path = "gstNumber") =>
    onWrite(path, GSTIN, (p) => `"${p.value}" is not a valid GSTIN`),
};
