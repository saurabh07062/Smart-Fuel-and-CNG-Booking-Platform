/**
 * What a name, a phone number, a password, a GST number and an address have
 * to be before they are written to a user record.
 *
 * ONE definition, used by every route that accepts them: vendor
 * registration, the admin's vendor edit, the vendor's own profile and the
 * staff they add. The frontend checks the same rules (frontend
 * src/utils/accountFields.ts) so a person is told early -- but the frontend
 * is a courtesy and this is the guarantee. A request straight to the API
 * with curl meets exactly these checks.
 *
 * Each validator returns `{ ok: true, value }` with the cleaned value to
 * store, or `{ ok: false, msg, field }` with a sentence a person can act on.
 * Nothing here throws, and nothing silently "fixes" bad input beyond
 * trimming and normalising case/format.
 */

/**
 * Letters (any script), digits and the punctuation real names carry.
 *
 * Digits belong here: "Shell 24x7" and "HP Petrol Pump No. 5" are business
 * names people actually register. What is excluded is everything a name
 * never contains -- angle brackets, quotes, braces, semicolons -- which is
 * also what an injected string is made of.
 */
const NAME_SHAPE = /^[\p{L}\d][\p{L}\d .,'\-&()/]*$/u;
/** A person or business name must be more than one repeated character. */
const ALL_SAME = /^(.)\1*$/;
/** GSTIN: 2-digit state, 10-char PAN, entity digit, "Z", checksum. */
const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72; // bcrypt truncates beyond this

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clean = (v) => str(v).replace(/\s+/g, " ").trim();

const fail = (field, msg) => ({ ok: false, field, msg });
const pass = (value) => ({ ok: true, value });

/**
 * A person's or business's name.
 * @param {string} raw
 * @param {{field?: string, label?: string, min?: number, max?: number}} [opts]
 */
function validateName(raw, { field = "name", label = "Name", min = 2, max = 80 } = {}) {
  const value = clean(raw);
  if (!value) return fail(field, `${label} is required.`);
  if (value.length < min) return fail(field, `${label} must be at least ${min} characters.`);
  if (value.length > max) return fail(field, `${label} must be ${max} characters or fewer.`);
  // "aaaa", "....", "1234" -- typed to get past a required field, not a name.
  if (ALL_SAME.test(value.replace(/\s/g, ""))) return fail(field, `Enter a real ${label.toLowerCase()}.`);
  if (!/\p{L}/u.test(value)) return fail(field, `${label} must contain letters.`);
  if (!NAME_SHAPE.test(value)) {
    return fail(field, `${label} may only contain letters, numbers, spaces and . , ' - & ( )`);
  }
  return pass(value);
}

/**
 * An Indian mobile number, stored as the bare ten digits.
 *
 * "+91 98765 43210", "098765 43210" and "9876543210" are the same number, so
 * they are normalised to one form -- otherwise the same person registers
 * twice and neither record can be found by the other's spelling.
 */
function validatePhone(raw, { field = "phone", required = true } = {}) {
  const typed = str(raw).trim();
  if (!typed) return required ? fail(field, "Phone number is required.") : pass("");

  const digits = typed.replace(/[\s()-]/g, "").replace(/^(\+91|91|0)/, "");
  if (!/^\d+$/.test(digits)) return fail(field, "Phone number may contain digits only.");
  if (digits.length !== 10) return fail(field, "Phone number must be exactly 10 digits.");
  if (!/^[6-9]/.test(digits)) return fail(field, "An Indian mobile number starts with 6, 7, 8 or 9.");
  if (ALL_SAME.test(digits)) return fail(field, "That is not a real phone number.");
  return pass(digits);
}

/**
 * A password, and the confirmation beside it when the form has one.
 *
 * Length is the rule that matters (bcrypt stops at 72 bytes, so a maximum is
 * a real limit and not a policy); beyond that, only the cases that are
 * certainly not a password: one repeated character, and the handful everyone
 * tries first.
 */
const OBVIOUS = new Set(["password", "12345678", "123456789", "qwertyui", "11111111", "password1", "admin123"]);

function validatePassword(raw, { field = "password", confirm } = {}) {
  const value = str(raw);
  if (!value) return fail(field, "Password is required.");
  if (value.trim().length === 0) return fail(field, "Password cannot be only spaces.");
  if (value.length < MIN_PASSWORD_LENGTH) {
    return fail(field, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_PASSWORD_BYTES) {
    return fail(field, `Password is too long (at most ${MAX_PASSWORD_BYTES} bytes).`);
  }
  if (ALL_SAME.test(value)) return fail(field, "That password is one repeated character. Choose another.");
  if (OBVIOUS.has(value.toLowerCase())) return fail(field, "That password is too common. Choose another.");
  if (confirm !== undefined && value !== str(confirm)) {
    return fail("confirmPassword", "The two passwords do not match.");
  }
  return pass(value);
}

/** A GST number, if one was given. Stored upper-case. */
function validateGst(raw, { field = "gstNumber", required = false } = {}) {
  const value = str(raw).replace(/\s/g, "").toUpperCase();
  if (!value) return required ? fail(field, "GST number is required.") : pass("");
  if (value.length !== 15) return fail(field, "A GST number is 15 characters, e.g. 27ABCDE1234F1Z5.");
  if (!GSTIN_SHAPE.test(value)) return fail(field, "That is not a valid GST number. Check it against your certificate.");
  return pass(value);
}

/** A postal address: enough of one to find the place. */
function validateAddress(raw, { field = "vendorAddress", label = "Address", required = true, min = 10, max = 300 } = {}) {
  const value = clean(raw);
  if (!value) return required ? fail(field, `${label} is required.`) : pass("");
  if (value.length < min) return fail(field, `${label} is too short — include the street and the city.`);
  if (value.length > max) return fail(field, `${label} must be ${max} characters or fewer.`);
  if (!/\p{L}/u.test(value)) return fail(field, `${label} must contain letters.`);
  if (ALL_SAME.test(value.replace(/\s/g, ""))) return fail(field, `Enter a real ${label.toLowerCase()}.`);
  return pass(value);
}

/** Free text a vendor writes about themselves. Optional, but bounded. */
function validateDescription(raw, { field = "vendorDescription", max = 600 } = {}) {
  const value = str(raw).trim();
  if (!value) return pass("");
  if (value.length > max) return fail(field, `Description must be ${max} characters or fewer.`);
  return pass(value);
}

/**
 * Run several validators and stop at the first failure.
 *
 * @param {Array<[string, {ok: boolean}]>} pairs  [key, result]
 * @returns {{ok: true, values: object} | {ok: false, field: string, msg: string}}
 */
function all(pairs) {
  const values = {};
  for (const [key, result] of pairs) {
    if (!result.ok) return result;
    values[key] = result.value;
  }
  return { ok: true, values };
}

module.exports = {
  validateName,
  validatePhone,
  validatePassword,
  validateGst,
  validateAddress,
  validateDescription,
  all,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
};
