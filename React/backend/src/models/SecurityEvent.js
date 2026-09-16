const mongoose = require("mongoose");

/**
 * A record of one blocked (or flagged) request from the risk engine.
 *
 * Deliberately narrow: a reason, which rule fired, and a score -- never the
 * raw request body. That's the whole point of logging this way rather than
 * dumping requests wholesale: the event log stays useful for an admin
 * dashboard and safe to keep around without becoming its own liability.
 */
const SecurityEventSchema = new mongoose.Schema(
  {
    rule: { type: String, required: true }, // e.g. 'velocity', 'duplicate-slot', 'impossible-travel'
    reason: { type: String, required: true }, // human-readable, shown to an admin
    score: { type: Number, required: true },
    threshold: { type: Number, required: true },
    action: { type: String, enum: ["blocked", "flagged"], default: "blocked" },

    // Enough to investigate a pattern without storing anything sensitive.
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    station: { type: mongoose.Schema.Types.ObjectId, ref: "Station", default: null },
    route: { type: String, default: null }, // e.g. 'POST /api/bookings'

    // Set only by recordOnce(): "<action>:<rule>:<user>:<time bucket>", unique,
    // so an event meant to be logged once per window is logged once even when
    // concurrent requests (or server instances) try at the same moment.
    dedupeKey: { type: String, default: undefined },
  },
  { timestamps: true },
);

SecurityEventSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } },
);

/**
 * Log `event` at most once per action, rule and user in each `windowMs`
 * bucket. Atomic: an upsert on the unique dedupeKey, so a check-then-insert
 * race cannot write it twice.
 *
 * @returns {Promise<boolean>} true if this call wrote the event
 */
SecurityEventSchema.statics.recordOnce = async function recordOnce(event, { windowMs, now = new Date() }) {
  const bucket = Math.floor(now.getTime() / windowMs);
  const dedupeKey = `${event.action}:${event.rule}:${event.user}:${bucket}`;
  try {
    const result = await this.updateOne({ dedupeKey }, { $setOnInsert: { ...event, dedupeKey } }, { upsert: true });
    return result.upsertedCount === 1;
  } catch (err) {
    if (err?.code === 11000) return false; // a concurrent call inserted it first
    throw err;
  }
};

/**
 * Retention: security events are investigation records, kept longer than the
 * 30-day booking attempts they summarise but not forever.
 * SECURITY_EVENT_RETENTION_DAYS overrides the 180-day default.
 */
const RETENTION_DAYS = (() => {
  const raw = process.env.SECURITY_EVENT_RETENTION_DAYS;
  const n = Number(raw);
  if (raw === undefined || raw === "") return 180;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`SECURITY_EVENT_RETENTION_DAYS must be a positive whole number of days, got "${raw}"`);
  }
  return n;
})();

SecurityEventSchema.index({ createdAt: -1 });
SecurityEventSchema.index({ user: 1, createdAt: -1 });
SecurityEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 });

module.exports = mongoose.model("SecurityEvent", SecurityEventSchema);
