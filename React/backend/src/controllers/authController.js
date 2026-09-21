const User = require("../models/User");
const bcrypt = require("bcryptjs");
const {
  issueSession,
  rotateRefreshToken,
  revokeCurrentSession,
  revokeAllSessions,
  clearSessionCookies,
  SessionError,
} = require("../services/security/session");

/** The signed-in user as the client receives it after login or a session refresh. */
function sessionUserView(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    vendorStatus: user.vendorStatus,
    // A vendor can be approved but not yet activated; the client routes
    // those two states to different pages, so both have to come back.
    vendorCode: user.vendorCode,
    activated: user.activated,
    // The fuels a vendor sells: the vendor panel shows only these.
    vendorFuelTypes: user.vendorFuelTypes,
    wallet: user.wallet,
    rewards: user.rewards,
    vehicles: user.vehicles,
    // Without this the avatar falls back to the initial on every fresh
    // login, even for someone who has uploaded a photo -- the client
    // renders straight from this payload.
    profileImage: user.profileImage || null,
  };
}
const crypto = require("crypto");
const emailService = require("../services/notification/emailService");
const { validateEmail } = require("../services/notification/emailValidation");
const passwordReset = require("../services/security/passwordReset");
const { normaliseEmail, findUserByEmail } = require("../utils/email");
const authLog = require("../utils/logger").child("auth");

/** "app" when the request comes from the FuelMart Android app (its WebView names the app package). */
function clientKind(req) {
  return req.get("x-requested-with") === "com.fuelmart.customer" ? "app" : "website";
}

// Initialize the centralized SMTP transporter on startup
emailService.initTransporter();


exports.register = async (req, res) => {
  try {
    const { name, password } = req.body;
    // Stored trimmed and lowercase (utils/email.js), so it signs in however it is typed later.
    const email = normaliseEmail(req.body.email);

    if (!name || !email || !password) {
      return res.status(400).json({ msg: "Please provide name, email and password" });
    }

    // Account verification, password resets and booking confirmations all go
    // to this address. An unroutable one locks the person out of their own
    // account with no self-service way back.
    const emailCheck = validateEmail(email);
    if (!emailCheck.ok) {
      return res.status(400).json({
        msg: emailCheck.msg,
        field: "email",
        reason: emailCheck.reason,
        suggestion: emailCheck.suggestion || null,
      });
    }

    console.log(`[Register] Checking if email exists: ${email}`);
    let user = await findUserByEmail(email);
    if (user) {
      console.log(`[Register] ❌ Email already registered: ${email}`);
      return res.status(400).json({ msg: `User already exists with email: ${email}` });
    }
    console.log(`[Register] ✅ Email is free, creating user...`);

    user = new User({ name, email, password, isVerified: true });
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);
    await user.save();
    console.log(`[Register] ✅ User SAVED to DB — ID: ${user._id} | Email: ${user.email}`);

    // The session arrives as httpOnly cookies (services/security/session.js),
    // never in the body. Signing is synchronous inside this try: a failure is
    // a 500 for this request, never a crash of the whole process.
    await issueSession(req, res, user);
    res.json({
      msg: "Account created successfully!",
      user: { name: user.name, email: user.email, wallet: user.wallet, rewards: user.rewards, vehicles: user.vehicles },
    });
  } catch (err) {
    console.error(`[Register] ❌ Error saving user:`, err.message);
    // Handle duplicate key error (email already exists in DB)
    if (err.code === 11000) {
      return res.status(400).json({ msg: "An account with this email already exists." });
    }
    res.status(500).json({ msg: "Could not create the account. Please try again." });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    // Case and surrounding spaces do not matter: "Saurabh@Gmail.com " is the same account.
    const user = await findUserByEmail(email);
    if (!user || typeof password !== "string") return res.status(400).json({ msg: "Invalid Credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid Credentials" });

    if (!user.isVerified) return res.status(400).json({ msg: "Please verify your email", needsVerification: true });

    // Session cookies only; synchronous signing inside this try (see register).
    await issueSession(req, res, user);
    // One line per sign-in (email masked by the logger).
    authLog.info(`Signed in: ${user.role} via ${clientKind(req)}`, { userId: String(user._id), email: user.email, role: user.role, client: clientKind(req), ip: req.ip });
    res.json({ user: sessionUserView(user) });
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server error");
  }
};

/**
 * POST /api/auth/refresh -- a new access token (and a rotated refresh token)
 * from the fm_refresh cookie. 401 with a `reason` when the session is over;
 * REFRESH_IN_PROGRESS means another tab refreshed a moment ago and the client
 * should simply retry its request.
 */
exports.refresh = async (req, res) => {
  try {
    const { user } = await rotateRefreshToken(req, res);
    res.json({ user: sessionUserView(user) });
  } catch (err) {
    if (err instanceof SessionError) {
      // A new tab only asking whether this browser is signed in (X-FM-Adopt):
      // "nobody is" is an answer, not an error.
      if (err.reason === "NO_REFRESH_TOKEN" && req.get("x-fm-adopt") === "1") {
        return res.json({ user: null });
      }
      if (err.reason !== "REFRESH_IN_PROGRESS") clearSessionCookies(res, req);
      return res.status(err.status).json({ msg: err.message, reason: err.reason });
    }
    console.error("[auth] refresh failed:", err.message);
    res.status(500).json({ msg: "Could not refresh your session. Please try again." });
  }
};

/**
 * POST /api/auth/logout -- sign this device out. Works with an expired access
 * token (only the refresh cookie matters) and always clears the cookies.
 */
exports.logout = async (req, res) => {
  try {
    await revokeCurrentSession(req, res);
  } catch (err) {
    console.error("[auth] logout could not revoke the session:", err.message);
    clearSessionCookies(res, req);
  }
  res.json({ msg: "Signed out" });
};

/**
 * POST /api/auth/logout-all -- sign out on every device: every access token
 * stops working at its next use, every refresh token is revoked, and live
 * sockets are disconnected.
 */
exports.logoutAll = async (req, res) => {
  try {
    await revokeAllSessions(req.user.id);
    clearSessionCookies(res, req);
    res.json({ msg: "Signed out on every device" });
  } catch (err) {
    console.error("[auth] logout-all failed:", err.message);
    res.status(500).json({ msg: "Could not sign out everywhere. Please try again." });
  }
};

/**
 * POST /api/auth/forgot-password  { email }
 *
 * Always the same 200 answer, whether or not the address has an account, is in
 * its resend cooldown, or the email could not be sent -- so the endpoint cannot
 * be used to find out who is registered. The email is sent without waiting for
 * it (services/security/passwordReset.js).
 */
exports.forgotPassword = async (req, res) => {
  const email = req.body?.email;
  if (typeof email !== "string" || !email.trim()) {
    return res.status(400).json({ msg: "Please enter your email address." });
  }
  try {
    await passwordReset.requestPasswordReset(email);
  } catch (err) {
    console.error("[auth] forgot-password failed:", err.message);
  }
  res.json({ msg: passwordReset.GENERIC_REQUEST_MSG });
};

/**
 * POST /api/auth/reset-password  { token, password }
 *
 * Sets the new password if the token matches and has not expired, uses the
 * token up, and signs the account out on every device.
 */
exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body || {};
    const result = await passwordReset.resetPassword(token, password);
    if (result.outcome === "weak_password") {
      return res.status(400).json({ msg: result.msg, reason: "WEAK_PASSWORD" });
    }
    if (result.outcome !== "reset") {
      return res.status(400).json({ msg: passwordReset.INVALID_TOKEN_MSG, reason: "INVALID_RESET_TOKEN" });
    }
    // This browser's session (if any) belonged to the old password too.
    clearSessionCookies(res, req);
    res.json({ msg: "Your password has been reset. Please sign in with your new password." });
  } catch (err) {
    console.error("[auth] reset-password failed:", err.message);
    res.status(500).json({ msg: "Could not reset your password. Please try again." });
  }
};

exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    res.json({ user });
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
};

exports.verifyEmail = async (req, res) => {
  try {
    const user = await User.findOne({ verificationToken: req.params.token });
    if (!user) return res.status(400).json({ msg: "Invalid or expired token" });
    user.isVerified = true;
    user.verificationToken = undefined;
    await user.save();
    res.json({ msg: "Email verified successfully" });
  } catch (err) {
    res.status(500).json({ msg: "Server error" });
  }
};

exports.resendVerification = async (req, res) => {
  // The same reply whether or not the address has an unverified account, so
  // this endpoint cannot be used to find out who is registered.
  const reply = { msg: "If that email has an account waiting for verification, a new link has been sent." };
  try {
    // A plain string only: an object such as {"$ne": null} must never reach
    // the query as an operator.
    const email = normaliseEmail(req.body?.email);
    if (!email) return res.status(400).json({ msg: "Enter your email address." });
    const user = await findUserByEmail(email);
    if (!user || user.isVerified) return res.json(reply);

    const verificationToken = crypto.randomBytes(20).toString("hex");
    user.verificationToken = verificationToken;
    await user.save();

    await emailService.sendVerificationEmail(user.email, verificationToken);
    res.json(reply);
  } catch (err) {
    console.error("[resendVerification]", err.message);
    res.status(500).json({ msg: "Server error" });
  }
};
