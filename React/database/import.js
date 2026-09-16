/**
 * Restore the JSON snapshot in ./dump (made by export.js) into the database
 * named by MONGO_URI in ../backend/.env.
 *
 *   node database/import.js          refuses if any target collection has data
 *   node database/import.js --drop   replaces those collections with the snapshot
 *
 * WRITES TO MONGODB. Indexes (including the 2dsphere index the nearest-station
 * search needs) are recreated from <collection>.indexes.json.
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
  const drop = process.argv.includes("--drop");

  const dir = path.join(__dirname, "dump");
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`No snapshot found: ${manifestPath} (run export.js first)`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const names = Object.keys(manifest.collections);

  const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    const db = client.db();

    if (!drop) {
      const busy = [];
      for (const name of names) {
        const n = await db.collection(name).estimatedDocumentCount();
        if (n > 0) busy.push(`${name} (${n})`);
      }
      if (busy.length) {
        throw new Error(
          `Database "${db.databaseName}" already has data in: ${busy.join(", ")}. ` +
            "Nothing was changed. Re-run with --drop to replace it with the snapshot.",
        );
      }
    }

    for (const name of names) {
      const col = db.collection(name);
      if (drop) await col.drop().catch((e) => { if (e.codeName !== "NamespaceNotFound") throw e; });

      const docs = BSON.EJSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"), { relaxed: false });
      if (docs.length) await col.insertMany(docs, { ordered: true });

      const idxFile = path.join(dir, `${name}.indexes.json`);
      if (fs.existsSync(idxFile)) {
        for (const idx of JSON.parse(fs.readFileSync(idxFile, "utf8"))) {
          if (idx.name === "_id_") continue;
          const { key, v, ns, ...options } = idx;
          await col.createIndex(key, options);
        }
      }
      console.log(`  ${name}: ${docs.length} documents restored`);
    }
    console.log(`Imported snapshot from ${manifest.exportedAt} into "${db.databaseName}"`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error("Import failed:", e.message);
  process.exit(1);
});
