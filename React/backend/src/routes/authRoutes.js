const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const auth = require("../middleware/auth");
const { requireAllowedOriginForCookies } = require("../middleware/origin");
const { rateLimit } = require("../services/security/rateLimiter");

// Tighter than the global API limit: these are the two endpoints a
// credential-stuffing or spam-signup script actually wants to hammer.
const loginLimiter = rateLimit({ limit: 10, windowMs: 5 * 60_000, keyPrefix: "login", keyFn: (req) => req.ip });
const registerLimiter = rateLimit({ limit: 5, windowMs: 60 * 60_000, keyPrefix: "register", keyFn: (req) => req.ip });
// Each open tab refreshes about once per access-token lifetime; this only
// stops a script hammering the endpoint.
const refreshLimiter = rateLimit({ limit: 30, windowMs: 5 * 60_000, keyPrefix: "refresh", keyFn: (req) => req.ip });
// Forgot password sends email, and reset guesses tokens: both kept low per IP.
// (A token is 256 random bits, so guessing is hopeless regardless; this stops mail spam.)
const forgotPasswordLimiter = rateLimit({ limit: 5, windowMs: 15 * 60_000, keyPrefix: "forgot-password", keyFn: (req) => req.ip });
const resetPasswordLimiter = rateLimit({ limit: 10, windowMs: 15 * 60_000, keyPrefix: "reset-password", keyFn: (req) => req.ip });

router.post("/register", registerLimiter, authController.register);
router.post("/login", loginLimiter, authController.login);
router.get("/me", auth, authController.getMe);
router.get("/verify-email/:token", authController.verifyEmail);
router.post("/resend-verification", authController.resendVerification);

// Forgot password (services/security/passwordReset.js).
router.post("/forgot-password", forgotPasswordLimiter, authController.forgotPassword);
router.post("/reset-password", resetPasswordLimiter, authController.resetPassword);

// Sessions (services/security/session.js). refresh and logout act on the
// session cookies themselves, so they carry the same origin check as any
// other cookie-authenticated state change.
router.post("/refresh", refreshLimiter, requireAllowedOriginForCookies, authController.refresh);
router.post("/logout", requireAllowedOriginForCookies, authController.logout);
router.post("/logout-all", auth, authController.logoutAll);

module.exports = router;
