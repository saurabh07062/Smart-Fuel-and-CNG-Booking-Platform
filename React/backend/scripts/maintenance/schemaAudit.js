/**
 * Read-only report: does the data satisfy the schema the app now declares?
 *
 * Adding validation and unique indexes to a schema says what a record must
 * look like from now on. It says nothing about what is already stored, and a
 * unique index simply refuses to build if the collection already holds
 * duplicates -- which is easy to miss in a boot log. This prints the answer:
 *
 *   1. DUPLICATES   values that a unique index forbids but the data contains
 *   2. ORPHANS      references pointing at a document that no longer exists
 *                   (models/index.js RELATIONS is the list of references)
 *   3. INVALID      documents that would fail their own schema validation
 *   4. INDEXES      which declared indexes are actually built
 *
 * It WRITES NOTHING -- no fixes, no deletions, not even a status change. Every
 * problem it can find is one where the right repair is a judgement call
 * (which of two duplicate vendors is the real one?), so it reports and stops.
 *
 *   node scripts/maintenance/schemaAudit.js            # the app database
 *   MONGO_URI=... node scripts/maintenance/schemaAudit.js
 *   node scripts/maintenance/schemaAudit.js --limit 20 # more examples per finding
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const mongoose = require("mongoose");
const { models, RELATIONS } = require("../../src/models");

const argLimit = () => {
  const i = process.argv.indexOf("--limit");
  const n = i > -1 ? Number(process.argv[i + 1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 5;
};
const LIMIT = argLimit();

/** The unique indexes each model declares, as { model, name, keys, filter }. */
function uniqueIndexes() {
  const out = [];
  for (const [name, model] of Object.entries(models)) {
    for (const [keys, options = {}] of model.schema.indexes()) {
      if (options.unique) {
        out.push({ model: name, name: options.name || Object.keys(keys).join("_"), keys, filter: options.partialFilterExpression || null, sparse: Boolean(options.sparse) });
      }
    }
    // Field-level `unique: true` (email, orderId, invoiceNo …) is not in
    // schema.indexes(); it lives on the path.
    model.schema.eachPath((p, type) => {
      if (type.options?.unique) {
        out.push({ model: name, name: `${p}_1`, keys: { [p]: 1 }, filter: null, sparse: Boolean(type.options.sparse) });
      }
    });
  }
  return out;
}

/** Documents sharing a value a unique index forbids. */
async function findDuplicates(index) {
  const model = models[index.model];
  const fields = Object.keys(index.keys).filter((k) => !k.startsWith("$"));
  if (!fields.length) return [];
  const match = { ...(index.filter || {}) };
  // A sparse or partial index ignores missing values; so does this.
  for (const field of fields) match[field] = { ...(match[field] || {}), $exists: true, $ne: null };

  const rows = await model
    .aggregate([
      { $match: match },
      { $group: { _id: Object.fromEntries(fields.map((f) => [f.replace(/\./g, "_"), `$${f}`])), count: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
      { $limit: LIMIT },
    ])
    .catch(() => []);
  return rows;
}

/** References whose target document is gone. */
async function findOrphans(relation) {
  const model = models[relation.model];
  const target = models[relation.ref];
  if (!model || !target) return null;

  const filter = { [relation.path]: { $exists: true, $ne: null } };
  const ids = await model.distinct(relation.path, filter);
  if (!ids.length) return { relation, total: 0, missing: [] };
  const alive = await target.distinct("_id", { _id: { $in: ids } });
  const aliveSet = new Set(alive.map(String));
  const missing = ids.filter((id) => !aliveSet.has(String(id)));
  return { relation, total: ids.length, missing };
}

/** Documents that their own schema would now reject. */
async function findInvalid(name, model) {
  const bad = [];
  let scanned = 0;
  for await (const doc of model.find({}).limit(5000).cursor()) {
    scanned += 1;
    try {
      await doc.validate();
    } catch (err) {
      bad.push({ _id: doc._id, problems: Object.keys(err.errors || {}).slice(0, 4) });
      if (bad.length >= LIMIT) break;
    }
  }
  return { scanned, bad };
}

async function main() {
  const uri = process.env.MONGO_URI || "mongodb://localhost:27017/fuelmart";
  // autoIndex off, or this "read-only" script would quietly BUILD every index
  // a model declares the first time it queries that collection (Mongoose's
  // default), and section 4 would then report the state it had just created.
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, autoIndex: false });
  const { host, port, name } = mongoose.connection;
  console.log(`FuelMart schema audit — ${name} at ${host}:${port}`);
  console.log("Read-only: this script changes nothing.\n");

  let findings = 0;

  console.log("1. DUPLICATES (values a unique index forbids)");
  for (const index of uniqueIndexes()) {
    const rows = await findDuplicates(index);
    if (!rows.length) continue;
    findings += rows.length;
    console.log(`   ✕ ${index.model}.${index.name}`);
    for (const row of rows) {
      console.log(`       ${JSON.stringify(row._id)} — ${row.count} documents: ${row.ids.slice(0, 4).join(", ")}`);
    }
  }
  console.log("   (nothing above = every uniqueness rule already holds)\n");

  console.log("2. ORPHANED REFERENCES");
  for (const relation of RELATIONS) {
    const result = await findOrphans(relation);
    if (!result || !result.missing.length) continue;
    findings += result.missing.length;
    const severity = relation.required ? "✕" : "·";
    console.log(
      `   ${severity} ${relation.model}.${relation.path} → ${relation.ref}: ${result.missing.length} of ${result.total} targets missing` +
        (relation.required ? " (required: these rows are orphans)" : " (optional reference)"),
    );
    console.log(`       e.g. ${result.missing.slice(0, LIMIT).join(", ")}`);
  }
  console.log("   (nothing above = every reference resolves)\n");

  console.log("3. DOCUMENTS THAT FAIL THEIR OWN SCHEMA (first 5000 of each)");
  for (const [name, model] of Object.entries(models)) {
    const { scanned, bad } = await findInvalid(name, model);
    if (!bad.length) continue;
    findings += bad.length;
    console.log(`   ✕ ${name}: ${bad.length}+ of ${scanned} scanned`);
    for (const row of bad) console.log(`       ${row._id} — ${row.problems.join(", ")}`);
  }
  console.log("   (nothing above = stored data satisfies the current rules)\n");

  console.log("4. INDEXES DECLARED vs BUILT");
  // Mongo's own name for an unnamed index is "<field>_<direction>" per key,
  // joined by "_" -- e.g. { station: 1, createdAt: -1 } is
  // "station_1_createdAt_-1". Comparing against the bare field names would
  // report every index in the app as missing.
  const autoName = (keys) =>
    Object.entries(keys)
      .map(([field, direction]) => `${field}_${direction}`)
      .join("_");

  for (const [name, model] of Object.entries(models)) {
    const declared = new Set();
    for (const [keys, options = {}] of model.schema.indexes()) declared.add(options.name || autoName(keys));
    model.schema.eachPath((p, type) => {
      if (type.options?.unique || type.options?.index) declared.add(`${p}_1`);
    });
    const live = await model.collection.indexes().catch(() => []);
    const liveNames = new Set(live.map((i) => i.name));
    const missing = [...declared].filter((d) => !liveNames.has(d));
    console.log(`   ${missing.length ? "·" : "✓"} ${name}: ${live.length} built${missing.length ? `, declared-but-not-built (names may differ): ${missing.join(", ")}` : ""}`);
  }

  console.log(`\n${findings === 0 ? "No problems found." : `${findings} finding(s). Nothing was changed.`}`);
  await mongoose.disconnect();
  process.exit(findings === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Audit failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(2);
});
