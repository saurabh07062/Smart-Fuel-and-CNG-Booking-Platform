/**
 * Build every model's indexes at boot, and never take the server down doing it.
 *
 * Mongoose's own autoIndex would fire per model at first use and swallow the
 * outcome; the one place that did check (server.js, Booking.init()) covered a
 * single model. This builds all of them once, and -- the part that matters --
 * reports each failure in words an operator can act on:
 *
 *   - a UNIQUE index that will not build means the data already holds
 *     duplicates. That is a real problem, so it is logged loudly (with the
 *     duplicate value Mongo names) and `scripts/schemaAudit.js` lists them.
 *     It is NOT fixed here: deciding which of two duplicate records to keep is
 *     not something a boot routine gets to do silently.
 *   - an index whose definition changed (same name, different keys/options)
 *     is reported as a conflict rather than dropped, for the same reason.
 *
 * The server keeps serving either way: an index is a guarantee and a speed-up,
 * and a missing one must not mean an outage. Every uniqueness rule that
 * protects correctness is ALSO enforced in the code that writes (locks and
 * conditional updates in services/booking, services/inventory), so a failed
 * index build degrades the guarantee to "checked in one place" -- it does not
 * remove it.
 */

const logger = require("../../utils/logger");
const { models } = require("../../models");

const log = logger.child("schema");

/** Mongo's "an index with this name exists with different options" codes. */
const CONFLICT_CODES = new Set([85, 86]); // IndexOptionsConflict, IndexKeySpecsConflict

/**
 * Indexes replaced by a differently-named definition. Mongo cannot change an
 * index in place, so the old one is dropped first -- safe, because dropping an
 * index changes no data and the replacement covers the same queries.
 *
 * bookings.orderId_1  was a plain sparse index; the replacement
 *                     (uniq_booking_order_id) is unique, which is the point.
 *
 * bookings.uniq_active_booking_per_user
 *                     guarded "one live booking per customer" unconditionally,
 *                     which fleet booking is a deliberate exception to. The
 *                     replacement (uniq_active_solo_booking_per_user) is the
 *                     same rule with grouped bookings excluded, so dropping
 *                     this one does not loosen anything for ordinary bookings.
 */
const REPLACED = { Booking: ["orderId_1", "uniq_active_booking_per_user"] };

let ready = null;

/**
 * Build the indexes of one model.
 *
 * @returns {Promise<{model: string, ok: boolean, error?: string, kind?: string}>}
 */
async function buildOne(name, model) {
  try {
    for (const old of REPLACED[name] || []) {
      await model.collection.dropIndex(old).catch(() => {}); // already gone
    }
    await model.createIndexes();
    return { model: name, ok: true };
  } catch (err) {
    const kind = err?.code === 11000 ? "duplicates" : CONFLICT_CODES.has(err?.code) ? "conflict" : "error";
    const detail =
      kind === "duplicates"
        ? `existing documents hold a duplicate value, so the unique index was not created: ${err.message}`
        : kind === "conflict"
          ? `an index of the same name exists with different options; drop it by name to let the new definition build: ${err.message}`
          : err.message;
    log.error(`Index build failed for ${name}`, { model: name, kind, detail });
    return { model: name, ok: false, kind, error: detail };
  }
}

/**
 * Build all indexes. Idempotent and run once per process; a failed run can be
 * retried (the memoised promise is cleared only on an unexpected throw).
 *
 * @returns {Promise<{built: string[], failed: object[]}>}
 */
function ensureSchemaIndexes() {
  if (!ready) {
    ready = (async () => {
      const results = await Promise.all(Object.entries(models).map(([name, model]) => buildOne(name, model)));
      const built = results.filter((r) => r.ok).map((r) => r.model);
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        log.warn(`Indexes ready for ${built.length} of ${results.length} collections`, {
          failed: failed.map((f) => `${f.model} (${f.kind})`),
          hint: "node scripts/schemaAudit.js lists the duplicate and orphan records behind these",
        });
      } else {
        log.info(`Indexes ready for all ${built.length} collections`);
      }
      return { built, failed };
    })().catch((err) => {
      ready = null; // an unexpected failure (no connection yet): let a later call try again
      throw err;
    });
  }
  return ready;
}

module.exports = { ensureSchemaIndexes, CONFLICT_CODES };
