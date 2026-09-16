/**
 * Export the FuelMart database to JSON snapshot files in ./dump.
 *
 * READ-ONLY: connects with MONGO_URI from ../backend/.env, reads every
 * collection and its indexes, writes nothing to MongoDB.
 *
 *   node database/export.js
 *
 * Output: dump/manifest.json, dump/<collection>.json (Extended JSON, so
 * ObjectIds and Dates survive), dump/<collection>.indexes.json.
 * Restore with database/import.js.
 */
const path = require("path");
const fs = require("fs");

const backend = path.join(__dirname, "..", "backend");
const load = (m) => require(require.resolve(m, { paths: [backend] }));
load("dotenv").config({ path: path.join(backend, ".env"), quiet: true });
const { MongoClient, BSON } = load("mongodb");

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set in backend/.env");

  const out = path.join(__dirname, "dump");
  fs.mkdirSync(out, { recursive: true });

  const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    const db = client.db();
    const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((n) => !n.startsWith("system."))
      .sort();

    const manifest = { database: db.databaseName, exportedAt: new Date().toISOString(), collections: {} };
    for (const name of collections) {
      const col = db.collection(name);
      const docs = await col.find({}).toArray();
      const indexes = await col.indexes();
      fs.writeFileSync(path.join(out, `${name}.json`), BSON.EJSON.stringify(docs, null, 2, { relaxed: false }));
      fs.writeFileSync(path.join(out, `${name}.indexes.json`), JSON.stringify(indexes, null, 2));
      manifest.collections[name] = docs.length;
      console.log(`  ${name}: ${docs.length} documents, ${indexes.length} indexes`);
    }
    fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(`Exported database "${db.databaseName}" (${collections.length} collections) to ${out}`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error("Export failed:", e.message);
  process.exit(1);
});
