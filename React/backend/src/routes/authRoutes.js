const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const auth = require("../middleware/auth");
const { requireAllowedOriginForCookies } = require("../middleware/origin");
const { uploadImage } = require("../middleware/upload");
const customerController = require("../controllers/customerController");
const { rateLimit } = require("../services/security/rateLimiter");

/**
 * The per-IP ceiling for one of these endpoints, overridable by environment.
 *
 * The production value is the default and applies unless something sets the
 * variable, so nothing is loosened by deploying this. The override exists for
 * the test server (test/helpers/testServer.js), which already raises the
 * global and vendor-access ceilings for the same reason: the whole suite
 * arrives from one IP, and these budgets are small and measured in quarter
 * hours, so a second run inside the window gets refused for being a test
 * suite rather than for anything the code did.
 *
 * Only the per-IP budgets are adjustable. The limiter's own behaviour is
 * covered directly in rateLimiter.test.js, and the per-account lockouts --
 * the ones that actually protect an individual's credentials -- are keyed by
 * account and untouched by this.
 */
const ipLimit = (name, fallback) => {
  const raw = Number(process.env[`AUTH_RATE_LIMIT_${name}`]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

// Tighter than the global API limit: these are the two endpoints a
// credential-stuffing or spam-signup script actually wants to hammer.
const loginLimiter = rateLimit({ limit: ipLimit("LOGIN", 10), windowMs: 5 * 60_000, keyPrefix: "login", keyFn: (req) => req.ip });
const registerLimiter = rateLimit({ limit: ipLimit("REGISTER", 5), windowMs: 60 * 60_000, keyPrefix: "register", keyFn: (req) => req.ip });
// Each open tab refreshes about once per access-token lifetime; this only
// stops a script hammering the endpoint.
const refreshLimiter = rateLimit({ limit: ipLimit("REFRESH", 30), windowMs: 5 * 60_000, keyPrefix: "refresh", keyFn: (req) => req.ip });
// Forgot password sends email, and reset guesses tokens: both kept low per IP.
// (A token is 256 random bits, so guessing is hopeless regardless; this stops mail spam.)
const forgotPasswordLimiter = rateLimit({ limit: ipLimit("FORGOT_PASSWORD", 5), windowMs: 15 * 60_000, keyPrefix: "forgot-password", keyFn: (req) => req.ip });
const resetPasswordLimiter = rateLimit({ limit: ipLimit("RESET_PASSWORD", 10), windowMs: 15 * 60_000, keyPrefix: "reset-password", keyFn: (req) => req.ip });

router.post("/register", registerLimiter, authController.register);
router.post("/login", loginLimiter, authController.login);
router.get("/me", auth, authController.getMe);
router.get("/verify-email/:token", authController.verifyEmail);
// Sends email: limited like forgot-password.
const resendVerificationLimiter = rateLimit({ limit: ipLimit("RESEND_VERIFICATION", 5), windowMs: 15 * 60_000, keyPrefix: "resend-verification", keyFn: (req) => req.ip });
router.post("/resend-verification", resendVerificationLimiter, authController.resendVerification);

// Forgot password (services/security/passwordReset.js).
router.post("/forgot-password", forgotPasswordLimiter, authController.forgotPassword);
router.post("/reset-password", resetPasswordLimiter, authController.resetPassword);

// Sessions (services/security/session.js). refresh and logout act on the
// session cookies themselves, so they carry the same origin check as any
// other cookie-authenticated state change.
router.post("/refresh", refreshLimiter, requireAllowedOriginForCookies, authController.refresh);
router.post("/logout", requireAllowedOriginForCookies, authController.logout);
router.post("/logout-all", auth, authController.logoutAll);

/**
 * The signed-in account's own profile photo -- whatever role that account has.
 *
 * The handlers are the ones customerController already had, and they were
 * never customer-specific: each reads the user id from the verified session
 * and writes only that account (it cannot be pointed at anyone else, because
 * no id is taken from the body). What WAS customer-specific was the route --
 * it sat behind requireRole("customer") -- so a vendor had to go through their
 * own panel endpoint and an admin had no way to set a photo at all.
 *
 * Mounted here, under /api/auth, because "my account" belongs to every role.
 * The customer routes stay where they are; nothing that works today moves.
 */
router.post("/profile/image", auth, uploadImage("profiles", "profileImage"), customerController.uploadProfileImage);
router.delete("/profile/image", auth, customerController.deleteProfileImage);

module.exports = router;
