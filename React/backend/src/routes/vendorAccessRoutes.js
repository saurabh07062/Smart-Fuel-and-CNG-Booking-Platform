/**
 * Vendor secret-code access. Mounted at /api/vendor-access.
 *
 * The whole point of this route is to turn "I received an approval email"
 * into a vendor JWT, without the vendor having to already be signed in --
 * they are usually reading the mail on a phone, signed out, and the code is
 * the only credential they have.
 *
 * That makes it an unauthenticated endpoint that mints a session, so it is
 * rate limited harder than the rest of the API: per IP (stops one host
 * grinding through many accounts) and per email (stops a distributed attempt
 * at one account). Both are needed; either alone leaves the other open.
 */

const express = require("express");
const router = express.Router();
const User = require("../models/User");
const { rateLimit } = require("../services/security/rateLimiter");
const secret = require("../services/vendor/vendorSecretCode");

// Per-IP: the loose limit, because an IP is not a person. Vendors behind one
// office NAT or a mobile carrier's CGNAT all share an address, and a tight
// per-IP cap would have them locking each other out of their own accounts. 30
// attempts against a 50-bit code space is not a meaningful attack; the job
// here is to stop automated grinding, and it does.
const perIp = rateLimit({
  // VENDOR_ACCESS_ATTEMPTS_PER_IP overrides the 30 (only the test server
  // raises it). The per-email limit below is never relaxed.
  limit: Math.max(1, Number(process.env.VENDOR_ACCESS_ATTEMPTS_PER_IP) || 30),
  windowMs: 10 * 60 * 1000,
  keyPrefix: "vendor-access-ip",
  keyFn: (req) => req.ip,
});

// Per-email: the tight limit, because this one really does identify a single
// account. It is what stops a distributed attempt at one vendor, which the
// per-IP limit above cannot see. The account's own attempt counter
// (MAX_ATTEMPTS) sits behind this as the final backstop.
const perEmail = rateLimit({
  limit: 8,
  windowMs: 10 * 60 * 1000,
  keyPrefix: "vendor-access-email",
  // Falls back to the IP when no email was sent, so a body-less flood is
  // still counted rather than sharing one "undefined" bucket.
  keyFn: (req) => String((req.body && req.body.email) || req.ip).toLowerCase().trim(),
});

/**
 * Messages for each vendor status, per the access policy.
 *
 * These are the one place this endpoint knowingly confirms that an address
 * belongs to a vendor, and it is a deliberate, required trade-off: a vendor
 * whose code is refused has to be able to find out that the reason is
 * "still pending" or "suspended" rather than a bad code, because no amount of
 * retrying will fix those and support cannot read them the code either.
 *
 * That disclosure is kept to exactly this -- everything else on this route
 * answers identically for a registered and an unregistered address, and the
 * rate limits above bound how fast the distinction can be probed.
 */
const STATUS_MESSAGE = {
  pending: "Your vendor application is still waiting for admin approval.",
  under_review: "Your vendor application is still waiting for admin approval.",
  rejected: "Your vendor application has been rejected.",
  suspended: "Your vendor account is currently suspended.",
};

/** The one message for a wrong code, an unknown address or a vendor with no code. */
const INVALID_MSG = "Invalid Secret Code.";

/**
 * POST /api/vendor-access/verify   { email, code }
 *
 * The code is reusable (services/vendor/vendorSecretCode.js): every correct
 * entry by an approved vendor starts a session, the same code works on the
 * next visit, and it stays active until an admin reissues it. "Invalid Secret
 * Code" is shown only when the code is wrong, revoked or expired.
 *
 * On success starts a session plus returns the vendor's own summary. On
 * failure returns a reason the frontend can branch on, and never anything that
 * would help someone work out what a valid code looks like.
 */
router.post("/verify", perIp, perEmail, async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    const code = String((req.body && req.body.code) || "").trim();

    if (!email || !code) {
      return res.status(400).json({
        ok: false,
        reason: "MISSING_FIELDS",
        msg: "Enter both your registered email and your secret code.",
      });
    }

    // Case-insensitive: people capitalise their own address inconsistently,
    // and being told "no such vendor" because of a capital letter is a
    // support ticket nobody needs.
    const vendor = await User.findOne({
      email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
      role: "vendor",
    }).select("+secretCodeHash");

    // Same response for "no such vendor" as for a bad code, so this endpoint
    // cannot be used to enumerate which addresses are registered vendors.
    if (!vendor) {
      return res.status(400).json({
        ok: false,
        reason: "INVALID",
        msg: INVALID_MSG,
      });
    }

    if (vendor.vendorStatus !== "active") {
      return res.status(403).json({
        ok: false,
        reason: vendor.vendorStatus.toUpperCase(),
        vendorStatus: vendor.vendorStatus,
        msg: STATUS_MESSAGE[vendor.vendorStatus] || "Your vendor account is not active.",
      });
    }

    const { result } = await secret.verifySecretCode(vendor, code);

    if (result !== secret.RESULT.OK) {
      await vendor.save(); // persist the attempt count even on failure
      // A vendor with no code at all answers exactly like a wrong code.
      const body = {
        ok: false,
        reason: result === secret.RESULT.NO_CODE ? secret.RESULT.INVALID : result,
        msg: INVALID_MSG,
      };
      if (result === secret.RESULT.TOO_MANY_ATTEMPTS) {
        body.msg =
          "Too many incorrect attempts. This code has been locked — ask an administrator to issue a new one.";
      } else if (result === secret.RESULT.REVOKED) {
        body.msg = "Invalid Secret Code. This code is no longer active — ask an administrator to issue a new one.";
      } else if (result === secret.RESULT.EXPIRED) {
        body.msg = "Invalid Secret Code. This code has expired — ask an administrator to issue a new one.";
      }
      // Deliberately NOT reporting attempts-remaining here. It reads as a
      // helpful hint, but it only ever appears for an email that IS a
      // registered vendor -- so an unknown address and a real one with a
      // wrong code would give different answers, and this endpoint would
      // become a way to discover which addresses are vendors. The attempt
      // policy is stated up-front on the page instead, which is just as
      // useful and tells an attacker nothing. A test asserts these two cases
      // stay byte-identical.
      return res.status(400).json(body);
    }

    await vendor.save();

    // An ordinary session, exactly like a login (services/security/session.js):
    // httpOnly cookies, never a token in the body; synchronous signing inside
    // this try.
    await require("../services/security/session").issueSession(req, res, vendor);

    // No code, no hash, nothing derived from either.
    res.json({
      ok: true,
      msg: "Secret code verified.",
      user: {
        id: vendor._id,
        name: vendor.name,
        email: vendor.email,
        role: vendor.role,
        vendorStatus: vendor.vendorStatus,
        vendorCode: vendor.vendorCode || null,
        businessName: vendor.businessName || null,
        activated: true,
      },
    });
  } catch (err) {
    // Never interpolate req.body here -- it contains the code.
    console.error("[vendor-access] verify failed:", err.message);
    res.status(500).json({ ok: false, reason: "SERVER_ERROR", msg: "Server error" });
  }
});

/**
 * GET /api/vendor-access/session
 *
 * "Is the token in my hand actually a working vendor session?" The frontend
 * calls this the moment anyone lands on the vendor dashboard route.
 *
 * It matters because localStorage is writable by the person sitting at the
 * browser: anyone can set `fm-vendor-token` to a made-up string and type the
 * dashboard URL. A client-side check of "is a token present" is therefore not
 * a check at all. This asks the server, which verifies the signature and the
 * account state, and it is the answer that decides whether the dashboard is
 * allowed to stay on screen.
 *
 * Mounted behind the same vendor middleware as the panel itself, so it cannot
 * drift out of step with what the panel will actually accept.
 */
router.get("/session", require("../middleware/vendor"), async (req, res) => {
  const vendor = await User.findById(req.user.id).select(
    "name email role vendorStatus vendorCode businessName activated",
  );
  if (!vendor) return res.status(401).json({ ok: false, msg: "Account not found" });

  res.json({
    ok: true,
    user: {
      id: vendor._id,
      name: vendor.name,
      email: vendor.email,
      role: vendor.role,
      vendorStatus: vendor.vendorStatus,
      vendorCode: vendor.vendorCode || null,
      businessName: vendor.businessName || null,
      activated: !!vendor.activated,
    },
  });
});

module.exports = router;
