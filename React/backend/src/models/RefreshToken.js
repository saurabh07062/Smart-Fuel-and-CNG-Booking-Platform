const mongoose = require("mongoose");

/**
 * One refresh token -- one device's long-lived login -- stored only as a hash.
 *
 * The raw token lives in the browser's httpOnly fm_refresh cookie and nowhere
 * else; the database holds its SHA-256 (services/security/session.js), so a
 * leaked database cannot be replayed as a login.
 *
 * Rotation: every refresh revokes the presented token and issues a new one in
 * the same `family`. A revoked token presented again means it was copied, so
 * the whole family -- every token descended from that login -- is revoked.
 *
 * Expired tokens are removed by MongoDB (TTL index below). That is safe here
 * because a TTL index deletes whole documents and a document in this
 * collection is only a token. (models/User.js explains why the same trick
 * would be wrong on a user.)
 */
const RefreshTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // SHA-256 hex of the raw token.
    tokenHash: { type: String, required: true, unique: true },
    // Shared by a login and all its rotations.
    family: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: {
      type: String,
      enum: ["rotated", "logout", "logout_all", "reuse_detected", null],
      default: null,
    },
    replacedBy: { type: mongoose.Schema.Types.ObjectId, ref: "RefreshToken", default: null },
    // For a future "your devices" screen; never used to authenticate.
    userAgent: { type: String, maxlength: 300, default: null },
    ip: { type: String, maxlength: 64, default: null },
  },
  { timestamps: true },
);

RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("RefreshToken", RefreshTokenSchema);
