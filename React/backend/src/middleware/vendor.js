const User = require("../models/User");
const auth = require("./auth");
const requireRole = require("./requireRole");

/**
 * Approved AND activated. An admin setting vendorStatus="active" issues the
 * activation code (controllers/vendorController.js's approveVendor); it does
 * not by itself open the panel. The vendor has to enter that code
 * (services/vendor/vendorSecretCode.js -- reusable, until an admin reissues it)
 * before any vendor-panel route will answer them.
 *
 * Admins bypass this entirely -- they need to be able to look at a vendor's
 * panel to support someone who is stuck mid-activation.
 *
 * The 403s below carry a `reason` so the frontend can tell "you still need
 * to enter your code" apart from "you were suspended", which are the same
 * HTTP status but very different things to show a person.
 */
async function requireActivatedVendor(req, res, next) {
  try {
    if (req.user && req.user.role === "admin") return next();

    const vendor = await User.findById(req.user.id).select("role vendorStatus activated");
    if (!vendor) return res.status(401).json({ msg: "Account not found" });
    if (vendor.role === "admin") return next();

    if (vendor.vendorStatus !== "active") {
      return res.status(403).json({
        reason: "NOT_APPROVED",
        vendorStatus: vendor.vendorStatus,
        msg: `Your vendor account is ${vendor.vendorStatus}.`,
      });
    }

    if (!vendor.activated) {
      return res.status(403).json({
        reason: "NOT_ACTIVATED",
        msg: "Enter the activation code from your approval email to open your vendor dashboard.",
      });
    }

    next();
  } catch (err) {
    console.error("[vendorAuth] Error:", err.message);
    res.status(500).json({ msg: "Could not verify vendor access" });
  }
}

/**
 * Full vendor gate: verify the JWT, require the vendor role (an admin token
 * is also accepted, per requireRole's admin-override rule), then require the
 * account to be approved and activated.
 *
 * This used to be a no-op that fabricated an admin identity and always
 * called next() -- every vendor-panel route mounting it was reachable by
 * anyone, no token required.
 */
module.exports = [auth, requireRole("vendor"), requireActivatedVendor];
