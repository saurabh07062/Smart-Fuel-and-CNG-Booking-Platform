const mongoose = require("mongoose");
const { phoneValidator, gstValidator } = require("./shared/fieldValidators");

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  // Validated, not just required. Before this, "gmail.comt" was accepted and
  // the vendor never received their approval email -- see
  // services/notification/emailValidation.js. Enforced on the schema as well as at the
  // route so no future entry point can bypass it.
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    // An address is an identity, not text: stored lowercase so the unique
    // index means one account per address whatever case it was typed in.
    // utils/email.js still looks older mixed-case records up case-insensitively,
    // so nothing already stored stops signing in.
    lowercase: true,
    maxlength: 254,
    validate: {
      validator: (v) => require("../services/notification/emailValidation").isValidEmail(v),
      message: (p) => `"${p.value}" is not a valid email address`,
    },
  },
  // The bcrypt hash, never a password. NOT select:false: every auth path in
  // the app reads it through plain finders, and hiding it here would silently
  // break login rather than protect anything -- what keeps it out of responses
  // is the projection each controller sends (ADMIN_VENDOR_HIDE and friends).
  password: { type: String, required: true },
  role: {
    type: String,
    enum: ["customer", "vendor", "admin"],
    default: "customer",
    index: true,
  },
  // Vendor-specific fields
  vendorStatus: {
    type: String,
    enum: ["pending", "under_review", "active", "suspended", "rejected"],
    default: "pending",
  },
  businessName: { type: String, trim: true, maxlength: 160 },
  gstNumber: { type: String, trim: true, uppercase: true, validate: gstValidator("gstNumber") },
  // Validated in the same words as the registration form
  // (services/validation/accountFields.js): the schema is the last line, so a
  // future entry point cannot store a 9-digit number by skipping the route.
  phone: { type: String, trim: true, validate: phoneValidator("phone") },
  vendorAddress: { type: String, trim: true, maxlength: 400 },
  vendorDescription: { type: String, trim: true, maxlength: 1000 },
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
  // Money and points never go below zero: a negative balance is not a state
  // this app has, it is a bug that has already been written down.
  /**
   * A money balance held for the customer. Zero until something puts money in
   * it, which nothing does: payment is taken at the petrol pump
   * (config/payments.js), so no wallet is topped up, spent or refunded
   * anywhere in this app.
   *
   * It defaulted to 500 -- five hundred rupees of money that did not exist, on
   * every account ever created, returned by the auth API as if it were real.
   * Kept as a field because the API has always returned it and the schema is
   * where a future wallet would live; kept at 0 because a balance nobody
   * credited is not a balance.
   */
  wallet: { type: Number, default: 0, min: 0 },
  /**
   * The reward-point balance.
   *
   * Starts at zero and is only ever changed by services/rewards/rewardService.js,
   * which writes a matching row to models/RewardLedger.js for every movement --
   * so the balance is always explainable, and the sum of the ledger.
   *
   * It used to default to 100, which put points on every dashboard that no
   * entry anywhere accounted for. New accounts are credited their welcome
   * points through the ledger instead (config/rewards.js WELCOME_POINTS).
   */
  rewards: { type: Number, default: 0, min: 0 },
  vehicles: {
    type: [
      {
        vehicleType: { type: String, trim: true }, // 'Car', 'Bike', 'Scooter', 'Other'
        nickname: { type: String, trim: true, maxlength: 40 },
        // Stored the way a number plate is written: upper case, no stray
        // spaces, so the same car cannot be added twice as "mh12ab1234" and
        // "MH12AB1234" (the duplicate check in the controller compares these).
        //
        // No shape rule here on purpose. The controller's own rule is
        // deliberately broad (customerController.addVehicle allows letters,
        // digits and spaces) because plate formats vary -- series, BH-series,
        // older state formats. A stricter rule in the schema would turn a
        // plate the API accepted into a 500 at save time, which is worse than
        // storing an unusual plate.
        registrationNumber: { type: String, trim: true, uppercase: true, maxlength: 20 },
        brand: { type: String, trim: true, maxlength: 40 },
        model: { type: String, trim: true, maxlength: 40 },
        fuelType: { type: String, trim: true },
        color: { type: String, trim: true, maxlength: 30 },
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
},
  // createdAt was a plain field with a Date.now default and there was no
  // updatedAt at all, so nothing recorded when an account last changed.
  // Existing documents keep the createdAt they already have.
  { timestamps: true },
);

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

// The admin vendor list: "vendors, by status, newest first".
UserSchema.index({ role: 1, vendorStatus: 1, createdAt: -1 });
// The admin customer list, and every "how many users" count by role.
UserSchema.index({ role: 1, createdAt: -1 });
// Looking an account up by phone (the duplicate-phone check at registration
// and at profile edit). NOT unique: numbers already stored may repeat, and a
// unique index would refuse to build on that data rather than say so.
UserSchema.index({ phone: 1 }, { partialFilterExpression: { phone: { $type: "string" } } });

module.exports = mongoose.model("User", UserSchema);
