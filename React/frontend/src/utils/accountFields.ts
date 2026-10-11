/**
 * The rules a name, phone number, password, GST number and address have to
 * meet, checked in the browser.
 *
 * These mirror the server's, field for field and message for message
 * (backend src/services/validation/accountFields.js). The server is the
 * guarantee -- it re-checks every request, so a form cannot be bypassed by
 * one. This copy exists so a person is told about a five-digit phone number
 * while they are typing it, instead of after a page of uploads.
 *
 * Each returns the reason it fails, or null when the value is acceptable.
 */

const NAME_SHAPE = /^[\p{L}\d][\p{L}\d .,'\-&()/]*$/u;
const ALL_SAME = /^(.)\1*$/;
const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
/** The address shape the project settled on, in one place. */
export const EMAIL_SHAPE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72; // bcrypt truncates beyond this

const clean = (v: string) => v.replace(/\s+/g, " ").trim();
const byteLength = (v: string) => new TextEncoder().encode(v).length;

/** A person's or business's name. */
export function nameProblem(
  raw: string,
  { label = "Name", min = 2, max = 80 }: { label?: string; min?: number; max?: number } = {},
): string | null {
  const value = clean(raw);
  if (!value) return `${label} is required.`;
  if (value.length < min) return `${label} must be at least ${min} characters.`;
  if (value.length > max) return `${label} must be ${max} characters or fewer.`;
  if (ALL_SAME.test(value.replace(/\s/g, ""))) return `Enter a real ${label.toLowerCase()}.`;
  if (!/\p{L}/u.test(value)) return `${label} must contain letters.`;
  if (!NAME_SHAPE.test(value)) return `${label} may only contain letters, numbers, spaces and . , ' - & ( )`;
  return null;
}

/** An Indian mobile number, however it was typed. */
export function phoneProblem(raw: string, { required = true } = {}): string | null {
  const typed = raw.trim();
  if (!typed) return required ? "Phone number is required." : null;
  const digits = typed.replace(/[\s()-]/g, "").replace(/^(\+91|91|0)/, "");
  if (!/^\d+$/.test(digits)) return "Phone number may contain digits only.";
  if (digits.length !== 10) return "Phone number must be exactly 10 digits.";
  if (!/^[6-9]/.test(digits)) return "An Indian mobile number starts with 6, 7, 8 or 9.";
  if (ALL_SAME.test(digits)) return "That is not a real phone number.";
  return null;
}

/** The ten bare digits, as the server will store them. */
export function normalisePhone(raw: string): string {
  return raw.trim().replace(/[\s()-]/g, "").replace(/^(\+91|91|0)/, "");
}

export function emailProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Email address is required.";
  if (value.length > 254) return "That email address is too long.";
  if (!EMAIL_SHAPE.test(value)) {
    return "That does not look like a valid email address. Check for typos, and that it ends in something like .com";
  }
  return null;
}

const OBVIOUS = new Set(["password", "12345678", "123456789", "qwertyui", "11111111", "password1", "admin123"]);

export function passwordProblem(raw: string): string | null {
  if (!raw) return "Password is required.";
  if (raw.trim().length === 0) return "Password cannot be only spaces.";
  if (raw.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (byteLength(raw) > MAX_PASSWORD_BYTES) return `Password is too long (at most ${MAX_PASSWORD_BYTES} bytes).`;
  if (ALL_SAME.test(raw)) return "That password is one repeated character. Choose another.";
  if (OBVIOUS.has(raw.toLowerCase())) return "That password is too common. Choose another.";
  return null;
}

/** The confirmation box: only ever "these two differ". */
export function confirmProblem(password: string, confirm: string): string | null {
  if (!confirm) return "Please type the password again.";
  if (password !== confirm) return "The two passwords do not match.";
  return null;
}

/** A GST number, if one was given. */
export function gstProblem(raw: string, { required = false } = {}): string | null {
  const value = raw.replace(/\s/g, "").toUpperCase();
  if (!value) return required ? "GST number is required." : null;
  if (value.length !== 15) return "A GST number is 15 characters, e.g. 27ABCDE1234F1Z5.";
  if (!GSTIN_SHAPE.test(value)) return "That is not a valid GST number. Check it against your certificate.";
  return null;
}

export function addressProblem(
  raw: string,
  { label = "Address", required = true, min = 10, max = 300 }: { label?: string; required?: boolean; min?: number; max?: number } = {},
): string | null {
  const value = clean(raw);
  if (!value) return required ? `${label} is required.` : null;
  if (value.length < min) return `${label} is too short — include the street and the city.`;
  if (value.length > max) return `${label} must be ${max} characters or fewer.`;
  if (!/\p{L}/u.test(value)) return `${label} must contain letters.`;
  if (ALL_SAME.test(value.replace(/\s/g, ""))) return `Enter a real ${label.toLowerCase()}.`;
  return null;
}

/**
 * The first problem in a set of fields, as { field: message }.
 * An empty object means the form may be submitted.
 */
export function collectProblems(checks: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, problem] of Object.entries(checks)) {
    if (problem) out[field] = problem;
  }
  return out;
}
