/**
 * scripts/maintenance/setStationLocation.js, run as a real process against the
 * TEST database: refuses bad input, changes nothing in a dry run, backs up then
 * writes on --apply, is a no-op when already set, and --restore undoes it.
 *
 * DEVELOPMENT TEST DATA, test database only: two tagged stations and a
 * temporary backup folder, removed at the end.
 *
 *   node --test test/setStationLocationScript.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const testDb = require("./helpers/testDb");

const SCRIPT = path.join(__dirname, "..", "scripts", "maintenance", "setStationLocation.js");

test("setStationLocation script against MongoDB", async (t) => {
  const MONGO = testDb.uri(); // refuses a database whose name lacks "test"
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const Station = require("../src/models/Station");
  const tag = `setloc-${Date.now()}`;
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuelmart-setloc-"));
  const [target, other] = await Station.create([
    { name: `${tag}-target`, address: "Backfill Road, Pune", status: "Active" },
    { name: `${tag}-other`, address: "Other Road, Pune", status: "Active" },
  ]);

  const run = (...args) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [SCRIPT, ...args],
        { cwd: path.join(__dirname, ".."), env: { ...process.env, MONGO_URI: MONGO }, timeout: 30_000 },
        (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout}${stderr}` }),
      );
    });
  const station = () => Station.collection.findOne({ _id: target._id });
  const id = String(target._id);
  const backups = () => fs.readdirSync(backupDir);

  try {
    await t.test("refuses missing, (0, 0), outside-India and swapped points without touching the database", async () => {
      const cases = [
        [[], /--lat/],
        [["--lat", "18.59"], /--lat/],
        [["--lat", "0", "--lng", "0"], /not a real position/],
        [["--lat", "40.7128", "--lng", "-74.006"], /outside India/],
        [["--lat", "73.7389", "--lng", "18.5913"], /swapped.*--lat 18\.5913 --lng 73\.7389/],
        [["--at", "18.59"], /--at must look like/],
      ];
      for (const [args, message] of cases) {
        const r = await run(...args, "--station", id, "--apply", "--backup-dir", backupDir);
        assert.equal(r.code, 1, `${args.join(" ")}: ${r.out}`);
        assert.match(r.out, message);
      }
      const doc = await station();
      assert.equal(doc.location, undefined);
      assert.equal(doc.coordinates, undefined);
      assert.deepEqual(backups(), []);
    });

    await t.test("with more than one station it lists them and asks for --station", async () => {
      const r = await run("--lat", "18.5913", "--lng", "73.7389", "--apply", "--backup-dir", backupDir);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /more than one station/);
      assert.equal((await station()).location, undefined);
      assert.equal((await Station.collection.findOne({ _id: other._id })).location, undefined);
    });

    await t.test("a dry run prints the change and writes nothing (also when --apply is given too)", async () => {
      for (const extra of [["--dry-run"], [], ["--apply", "--dry-run"]]) {
        const r = await run("--at", "18.5913, 73.7389", "--station", id, ...extra, "--backup-dir", backupDir);
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /mode: dry run/);
        assert.match(r.out, /"coordinates":\[73\.7389,18\.5913\]/);
        assert.match(r.out, /nothing was written/);
      }
      const doc = await station();
      assert.equal(doc.location, undefined);
      assert.deepEqual(backups(), []);
    });

    let backupFile;
    await t.test("--apply backs up, sets coordinates and GeoJSON location only, and nearest search finds it", async () => {
      await Station.init(); // the schema's 2dsphere index on the test database
      const before = await station();
      const r = await run("--lat", "18.5913", "--lng", "73.7389", "--station", id, "--apply", "--backup-dir", backupDir);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /mode: APPLY/);
      assert.match(r.out, /verified: a nearest-station/);

      const doc = await station();
      assert.deepEqual(doc.coordinates, { lat: 18.5913, lng: 73.7389 });
      assert.deepEqual(doc.location, { type: "Point", coordinates: [73.7389, 18.5913] });
      for (const field of ["name", "address", "status", "createdAt"]) {
        assert.deepEqual(doc[field], before[field], `${field} unchanged`);
      }

      assert.equal(backups().length, 1);
      backupFile = path.join(backupDir, backups()[0]);
      const saved = JSON.parse(fs.readFileSync(backupFile, "utf8"));
      assert.equal(saved.stationId, id);
      assert.deepEqual(saved.previous, { coordinates: null, location: null });
      assert.equal((await Station.collection.findOne({ _id: other._id })).location, undefined, "the other station is untouched");
    });

    await t.test("running it again for the same point changes nothing and makes no new backup", async () => {
      const r = await run("--lat", "18.5913", "--lng", "73.7389", "--station", id, "--apply", "--backup-dir", backupDir);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /already at this location/);
      assert.equal(backups().length, 1);
    });

    await t.test("--restore puts back the values from the backup", async () => {
      const dry = await run("--restore", backupFile, "--backup-dir", backupDir);
      assert.equal(dry.code, 0, dry.out);
      assert.match(dry.out, /nothing was written/);
      assert.deepEqual((await station()).coordinates, { lat: 18.5913, lng: 73.7389 });

      const r = await run("--restore", backupFile, "--apply", "--backup-dir", backupDir);
      assert.equal(r.code, 0, r.out);
      const doc = await station();
      assert.equal(doc.location, undefined);
      assert.equal(doc.coordinates, undefined);
    });
  } finally {
    await Station.deleteMany({ _id: { $in: [target._id, other._id] } });
    fs.rmSync(backupDir, { recursive: true, force: true });
    await mongoose.disconnect();
  }
});
