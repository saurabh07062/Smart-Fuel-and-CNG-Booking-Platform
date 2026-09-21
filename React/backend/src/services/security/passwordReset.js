/**
 * Forgot password.
 *
 *   requestPasswordReset(email)
 *     A random 256-bit token; only its SHA-256 hash and a 1-hour expiry go on
 *     the user. The raw token is sent once, inside the emailed link, and never
 *     stored or logged. One email per account per minute; a new request
 *     replaces (and so invalidates) the previous link.
 *
 *   resetPassword(token, newPassword)
 *     Hash the incoming token, and in ONE conditional write -- matching hash,
 *     unexpired -- set the new password and remove the token, so a link works
 *     exactly once even if it is submitted twice at the same moment. Then sign
 *     the user out everywhere (tokenVersion bump, refresh tokens revoked, live
 *     sockets closed) and send a "your password was changed" notice.
 *
 * The HTTP layer (controllers/authController.js) answers a reset request with
 * the same message whether or not the email is registered.
 */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const User = require("../../models/User");
const emailService = require("../notification/emailService");
const { revokeAllSessions } = require("./session");

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
// bcrypt only reads the first 72 bytes; a longer limit would silently ignore the rest.
const MAX_PASSWORD_BYTES = 72;

const GENERIC_REQUEST_MSG =
  "If an account exists for that email, we have sent a link to reset the password. The link expires in 1 hour.";
const INVALID_TOKEN_MSG = "This password reset link is invalid or has expired. Please request a new one.";

function hashResetToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

/** Why a new password is refused, or null when it is acceptable. */
function passwordProblem(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    return `Password is too long (at most ${MAX_PASSWORD_BYTES} bytes).`;
  }
  return null;
}

function resetLink(rawToken) {
  const base = (process.env.CLIENT_URL || "http://localhost:3001").replace(/\/+$/, "");
  return `${base}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Never throws; a delivery failure is logged without the link. */
async function sendResetEmail(user, rawToken) {
  const link = resetLink(rawToken);
  const name = escapeHtml(user.name || "there");
  try {
    const sent = await emailService.sendMail({
      to: user.email,
      subject: "FuelMart - Reset your password",
      text:
        `Hi ${user.name || "there"},\n\nSomeone asked to reset the password for your FuelMart account. ` +
        `Open this link within 1 hour to choose a new password:\n\n${link}\n\n` +
        "If this was not you, ignore this email: your password stays the same.",
      html:
        `<p>Hi ${name},</p><p>Someone asked to reset the password for your FuelMart account.</p>` +
        `<p><a href="${escapeHtml(link)}">Choose a new password</a> (the link expires in 1 hour).</p>` +
        "<p>If this was not you, ignore this email: your password stays the same.</p>",
    });
    if (!sent) console.warn(`[passwordReset] reset email for user ${user._id} was not delivered (email disabled or failed)`);
    return sent;
  } catch (err) {
    console.error(`[passwordReset] reset email for user ${user._id} failed:`, err.message);
    return false;
  }
}

async function sendChangedEmail(user) {
  try {
    return await emailService.sendMail({
      to: user.email,
      subject: "FuelMart - Your password was changed",
      text:
        `Hi ${user.name || "there"},\n\nThe password for your FuelMart account was just changed, ` +
        "and every device was signed out. If this was not you, reset your password again right away.",
      html:
        `<p>Hi ${escapeHtml(user.name || "there")},</p><p>The password for your FuelMart account was just changed, ` +
        "and every device was signed out.</p><p>If this was not you, reset your password again right away.</p>",
    });
  } catch (err) {
    console.error(`[passwordReset] password-changed email for user ${user._id} failed:`, err.message);
    return false;
  }
}

/**
 * @returns {Promise<{outcome: "no_email"|"no_account"|"cooldown"|"sent", delivery?: Promise<boolean>}>}
 *   The caller must not reveal the outcome to the client.
 */
async function requestPasswordReset(email, { now = new Date() } = {}) {
  const address = typeof email === "string" ? email.trim() : "";
  if (!address) return { outcome: "no_email" };

  // Same lookup as login, so a reset reaches exactly the account that signs in with this address.
  const user = await require("../../utils/email").findUserByEmail(address, { project: "_id name email", lean: true });
  if (!user) return { outcome: "no_account" };

  const rawToken = crypto.randomBytes(32).toString("base64url");
  // Conditional on the cooldown, so two requests at the same moment send one email.
  const claimed = await User.updateOne(
    {
      _id: user._id,
      $or: [
        { passwordResetRequestedAt: null },
        { passwordResetRequestedAt: { $lte: new Date(now.getTime() - RESEND_COOLDOWN_MS) } },
      ],
    },
    {
      $set: {
        passwordResetTokenHash: hashResetToken(rawToken),
        passwordResetExpiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
        passwordResetRequestedAt: now,
      },
    },
  );
  if (!claimed.modifiedCount) return { outcome: "cooldown" };

  return { outcome: "sent", delivery: sendResetEmail(user, rawToken) };
}

/**
 * @returns {Promise<{outcome: "reset"|"invalid_token"|"weak_password", msg?: string, userId?: string}>}
 */
async function resetPassword(token, newPassword, { now = new Date() } = {}) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return { outcome: "invalid_token" };
  const problem = passwordProblem(newPassword);
  if (problem) return { outcome: "weak_password", msg: problem };

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const user = await User.findOneAndUpdate(
    { passwordResetTokenHash: hashResetToken(token), passwordResetExpiresAt: { $gt: now } },
    {
      $set: { password: passwordHash },
      $unset: { passwordResetTokenHash: 1, passwordResetExpiresAt: 1, passwordResetRequestedAt: 1 },
    },
    { returnDocument: "after", projection: { _id: 1, name: 1, email: 1 } },
  ).lean();
  if (!user) return { outcome: "invalid_token" };

  await revokeAllSessions(user._id, { now });
  void sendChangedEmail(user);
  return { outcome: "reset", userId: String(user._id) };
}

module.exports = {
  RESET_TOKEN_TTL_MS,
  RESEND_COOLDOWN_MS,
  MIN_PASSWORD_LENGTH,
  GENERIC_REQUEST_MSG,
  INVALID_TOKEN_MSG,
  hashResetToken,
  passwordProblem,
  resetLink,
  requestPasswordReset,
  resetPassword,
};
