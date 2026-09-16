/**
 * Password and password-reset rules shared by Register, ForgotPassword and
 * ResetPassword. They mirror the server (backend/src/services/security/passwordReset.js),
 * which stays the authority: these only save a round-trip for an obvious mistake.
 */

export const MIN_PASSWORD_LENGTH = 8;
/** bcrypt reads only the first 72 bytes, so the server refuses anything longer. */
export const MAX_PASSWORD_BYTES = 72;

/**
 * Shown after every forgot-password request that reached the server, whatever
 * the outcome, so the page never reveals whether an email is registered.
 */
export const FORGOT_PASSWORD_GENERIC_MSG =
  "If an account exists for that email, we have sent a link to reset the password. The link expires in 1 hour.";

/** Why a new password is refused, or null when it is acceptable. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    return `Password is too long (at most ${MAX_PASSWORD_BYTES} bytes).`;
  }
  return null;
}
