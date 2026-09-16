/**
 * Ledger of payment-provider webhook deliveries, one row per provider event id.
 *
 * Providers retry a delivery until they get a 2xx, and may deliver the same
 * event more than once; the unique (provider, eventId) index is what makes
 * processing happen once (controllers/webhookController.js). A row is
 * "processing" while its handler runs and "processed" once it has finished;
 * a "processing" row whose claim is old (the server died mid-way) may be
 * taken over by a retry.
 *
 * Rows expire after 30 days -- far beyond Razorpay's 24-hour retry window.
 */

const mongoose = require("mongoose");

const RETENTION_SECONDS = 30 * 24 * 60 * 60;

const WebhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    event: { type: String },
    status: { type: String, enum: ["processing", "processed"], default: "processing" },
    outcome: { type: String, default: null },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null },
    claimedAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

WebhookEventSchema.index({ provider: 1, eventId: 1 }, { name: "uniq_provider_event", unique: true });
WebhookEventSchema.index({ createdAt: 1 }, { name: "ttl_webhook_events", expireAfterSeconds: RETENTION_SECONDS });

module.exports = mongoose.model("WebhookEvent", WebhookEventSchema);
