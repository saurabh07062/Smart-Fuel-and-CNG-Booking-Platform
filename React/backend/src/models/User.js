const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  // Validated, not just required. Before this, "gmail.comt" was accepted and
  // the vendor never received their approval email -- see
  // services/notification/emailValidation.js. Enforced on the schema as well as at the
  // route so no future entry point can bypass it.
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    validate: {
      validator: (v) => require("../services/notification/emailValidation").isValidEmail(v),
      message: (p) => `"${p.value}" is not a valid email address`,
    },
  },
  password: { type: String, required: true },
  role: {
    type: String,
    enum: ["customer", "vendor", "admin"],
    default: "customer",
  },
  // Vendor-specific fields
  vendorStatus: {
    type: String,
    enum: ["pending", "under_review", "active", "suspended", "rejected"],
    default: "pending",
  },
  businessName: { type: String },
  gstNumber: { type: String },
  phone: { type: String },
  vendorAddress: { type: String },
  vendorDescription: { type: String },
  // The fuels this vendor sells, chosen at registration (services/vendor/vendorFuels.js).
  // Unset for vendors registered before it was recorded: they keep every fuel.
  vendorFuelTypes: {
    type: [{ type: String, enum: ["petrol", "diesel", "cng"] }],
    default: undefined,
  },
  // Where the applicant pinned their pump on the registration map. Pre-fills
  // the pin of their first "Add station". Only a real position is stored.
  registrationLocation: {
    type: new mongoose.Schema({ lat: Number, lng: Number }, { _id: false }),
    default: undefined,
  },
  // Optional uploaded file references (stored by vendor registration)
  // Vendor uploads. These stored a bare multer filename ("logoFile-123.png"),
  // which no client could resolve to a URL -- and nothing served the folder
  // anyway. They now hold the same public /uploads/... path as every other
  // upload in the app. Reading code should treat a value without a leading
  // slash as a legacy filename (see toPublicUpload in vendorController).
  logoFile: { type: String },
  licenseFile: { type: String },
  gstFile: { type: String },
  approvedAt: { type: Date },
  suspendedAt: { type: Date },
  rejectedAt: { type: Date },
  rejectionReason: { type: String },

  // ── Vendor identity & activation ────────────────────────────────────────
  // Human-readable reference ("VEN-2026-0042"), generated at registration so
  // the applicant has something to quote in support requests and to see on
  // their status page. The Mongo _id stays the real key; this is for humans.
  // Sparse: only vendors have one, and customers must not collide on null.
  vendorCode: { type: String, unique: true, sparse: true },

  // ── Vendor secret code ──────────────────────────────────────────────────
  // Two-step gate: an admin approving sets vendorStatus="active", which issues
  // a secret code emailed to the vendor. Entering it (POST
  // /api/vendor-access/verify) sets activated=true and starts a session, and
  // the same code works again on every later visit until an admin reissues it
  // (services/vendor/vendorSecretCode.js). Approval alone is not access -- it
  // only issues the key.
  //
  // Only the bcrypt hash is stored. Nothing anywhere -- not the database, not
  // the admin UI, not the approve response, not the logs -- ever holds the
  // plaintext after the approval email is handed to the mail transport.
  secretCodeHash: { type: String, default: null, select: false },
  secretCodeCreatedAt: { type: Date, default: null },
  // Deadline for the FIRST use only; cleared by the first successful use, after
  // which the code does not expire.
  secretCodeExpiresAt: { type: Date, default: null },
  // Legacy: set by the former single-use policy. Codes are reusable now and
  // this is never set to true again; a true value on an old document means
  // that code was consumed and reads as revoked.
  secretCodeUsed: { type: Boolean, default: false },
  // Wrong guesses in a row against the CURRENT code. Reset by a successful use
  // and when a new code is issued.
  secretCodeAttempts: { type: Number, default: 0 },
  // When the current code last opened the vendor panel.
  secretCodeLastUsedAt: { type: Date, default: null },

  // Set once the code has been entered successfully. This, not vendorStatus,
  // is what opens the vendor panel; reissuing a code clears it.
  activated: { type: Boolean, default: false },
  // Customer fields
  wallet: { type: Number, default: 500 },
  rewards: { type: Number, default: 100 },
  vehicles: {
    type: [
      {
        vehicleType: { type: String }, // 'Car', 'Bike', 'Scooter', 'Other'
        nickname: { type: String },
        registrationNumber: { type: String },
        brand: { type: String },
        model: { type: String },
        fuelType: { type: String },
        color: { type: String },
        image: { type: String },
        isDefault: { type: Boolean, default: false },
        
        // Legacy fields for backward compatibility
        type: { type: String }, 
        plate: String,
      },
    ],
    default: [],
  },
  // ── uploaded files ──────────────────────────────────────────────────────
  // Public path under /uploads, e.g. "/uploads/profiles/profiles-1788-ab.jpg".
  // Relative on purpose: the same row has to resolve on localhost and behind
  // a real domain. Null for everyone who has never uploaded one, which the
  // UI already handles by falling back to an initial.
  //
  // Before this the profile photo lived only in localStorage as a data URL,
  // so it vanished on another browser and never reached the server at all.
  profileImage: { type: String, default: null },

  createdAt: { type: Date, default: Date.now },
  isVerified: { type: Boolean, default: false },
  verificationToken: { type: String },

  // Bumped to sign the user out everywhere (services/security/session.js
  // revokeAllSessions): each access token carries the version it was issued
  // with and is refused once they differ. Absent on older documents, which
  // reads as 0 -- nothing needs backfilling.
  tokenVersion: { type: Number, default: 0 },

  // Forgot password (services/security/passwordReset.js). Only a SHA-256 hash of
  // the emailed token is stored; the raw token exists only in the email link.
  passwordResetTokenHash: { type: String, default: undefined, select: false },
  passwordResetExpiresAt: { type: Date, default: undefined },
  passwordResetRequestedAt: { type: Date, default: undefined },
});

/**
 * Supports the sweep that clears expired secret codes.
 *
 * Deliberately NOT a Mongo TTL index. A TTL index on secretCodeExpiresAt
 * would delete the entire USER DOCUMENT when the code expired -- the vendor,
 * their login, their station ownership, all of it -- because TTL removes
 * documents, not fields. What has to expire here is five fields on a user who
 * must survive. services/vendor/vendorSecretCode.js#sweepExpired does that, and this
 * partial index is what keeps it cheap.
 */
UserSchema.index(
  { secretCodeExpiresAt: 1 },
  { partialFilterExpression: { secretCodeExpiresAt: { $type: "date" } } },
);

module.exports = mongoose.model("User", UserSchema);
