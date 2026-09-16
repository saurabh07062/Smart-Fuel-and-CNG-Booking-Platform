const { MongoMemoryServer } = require("mongodb-memory-server");
const path = require("path");
const fs = require("fs");

async function start() {
  const dbPath = path.join(__dirname, "..", "..", "data", "mongo-db");
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
  }

  console.log("Initializing MongoDB on port 27017...");
  const mongod = await MongoMemoryServer.create({
    instance: {
      port: 27017,
      dbPath: dbPath,
      storageEngine: "wiredTiger",
    },
  });

  const uri = mongod.getUri();
  console.log("✅ MongoDB started successfully!");
  console.log("URI:", uri);
  console.log("Port: 27017");
  console.log("Storage: " + dbPath);

  // Keep process alive
  process.on("SIGINT", async () => {
    console.log("Stopping MongoDB...");
    await mongod.stop();
    process.exit(0);
  });
}

start().catch((err) => {
  console.error("MongoDB start failed:", err);
  process.exit(1);
});
