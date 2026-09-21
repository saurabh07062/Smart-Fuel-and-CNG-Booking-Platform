/**
 * Petrol and CNG pump photos, end to end through the real app (src/app.js):
 * the owner uploads both -> the /uploads paths are saved on the station ->
 * the files are served -> replacing one removes the old file and leaves the
 * other photo alone -> the public station view carries them -> another
 * vendor, a signed-out caller, a wrong type, an oversize file and an empty
 * request are all refused and leave no file behind.
 *
 * DEVELOPMENT TEST DATA, test database only: tagged vendors and a station,
 * and the few image files uploaded here, all removed at the end.
 *
 *   node --test test/pumpImages.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const testDb = require("./helpers/testDb");

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

// The smallest valid PNG (1x1). Real image bytes, not a URL.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test("pump images against MongoDB", async (t) => {
  const MONGO = testDb.uri();
  testDb.isolateRedis();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const jwt = require("jsonwebtoken");
  const User = require("../src/models/User");
  const Station = require("../src/models/Station");
  const { UPLOAD_ROOT, removeUploadedFile } = require("../src/middleware/upload");
  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const stationsDir = path.join(UPLOAD_ROOT, "stations");
  const listFiles = () => (fs.existsSync(stationsDir) ? new Set(fs.readdirSync(stationsDir)) : new Set());
  const onDisk = (publicPath) => fs.existsSync(path.join(UPLOAD_ROOT, publicPath.replace(/^\/uploads\//, "")));

  const tag = `pumpimg-${Date.now()}`;
  const tokenFor = (id) =>
    jwt.sign({ user: { id: String(id) } }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "30m" });
  const vendor = (suffix) =>
    User.create({
      name: `${tag}-${suffix}`,
      email: `${tag}-${suffix}@example.com`,
      password: "not-used-in-this-test",
      role: "vendor",
      vendorStatus: "active",
      activated: true,
      isVerified: true,
      businessName: `${tag} ${suffix}`,
    });

  /** PUT pump-images; `files` is { fieldName: { bytes, name, type } }. */
  const upload = async (stationId, files, token) => {
    const form = new FormData();
    for (const [field, f] of Object.entries(files)) form.append(field, new Blob([f.bytes], { type: f.type }), f.name);
    const res = await fetch(`${base}/api/vendor-panel/stations/${stationId}/pump-images`, {
      method: "PUT",
      headers: token ? { "x-auth-token": token } : {},
      body: form,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const png = (name) => ({ bytes: PNG, name, type: "image/png" });

  const owner = await vendor("owner");
  const other = await vendor("other");
  const station = await Station.create({ name: `${tag}-station`, address: "Pump Photo Road, Pune", owner: owner._id });
  const saved = new Set();

  try {
    await t.test("the owner uploads both photos; the paths are saved and the files are served", async () => {
      const r = await upload(station._id, { petrolImage: png("petrol.png"), cngImage: png("cng.png") }, tokenFor(owner._id));
      assert.equal(r.status, 200, JSON.stringify(r.body));

      const doc = await Station.findById(station._id).lean();
      for (const key of ["petrol", "cng"]) {
        assert.match(doc.pumpImages[key], /^\/uploads\/stations\/stations-\d+-[0-9a-f]{16}\.png$/, key);
        assert.ok(onDisk(doc.pumpImages[key]), `${key} file exists`);
        saved.add(doc.pumpImages[key]);
        const served = await fetch(`${base}${doc.pumpImages[key]}`);
        assert.equal(served.status, 200, `${key} is served`);
      }
      assert.notEqual(doc.pumpImages.petrol, doc.pumpImages.cng);
      assert.deepEqual(r.body.pumpImages, doc.pumpImages);
      assert.deepEqual(doc.images, [], "the existing station photos are untouched");
    });

    await t.test("replacing the petrol photo deletes the old file and keeps the CNG photo", async () => {
      const before = await Station.findById(station._id).lean();
      const r = await upload(station._id, { petrolImage: png("petrol-new.png") }, tokenFor(owner._id));
      assert.equal(r.status, 200, JSON.stringify(r.body));

      const after = await Station.findById(station._id).lean();
      assert.notEqual(after.pumpImages.petrol, before.pumpImages.petrol);
      assert.equal(after.pumpImages.cng, before.pumpImages.cng);
      assert.ok(onDisk(after.pumpImages.petrol));
      assert.equal(onDisk(before.pumpImages.petrol), false, "the replaced file is gone");
      saved.add(after.pumpImages.petrol);
    });

    await t.test("customers see the photos in the public station view", async () => {
      const doc = await Station.findById(station._id).lean();
      const res = await fetch(`${base}/api/stations/${station._id}`);
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      const view = body.station ?? body;
      assert.deepEqual(view.pumpImages, doc.pumpImages);
      assert.equal(view.owner, undefined, "still no private fields");
    });

    await t.test("another vendor cannot change the photos, and their upload is not kept", async () => {
      const before = await Station.findById(station._id).lean();
      const filesBefore = listFiles();
      const r = await upload(station._id, { petrolImage: png("intruder.png") }, tokenFor(other._id));
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.deepEqual((await Station.findById(station._id).lean()).pumpImages, before.pumpImages);
      assert.deepEqual([...listFiles()].filter((f) => !filesBefore.has(f)), [], "no file left behind");
    });

    await t.test("a signed-out caller is refused before any file is written", async () => {
      const filesBefore = listFiles();
      const r = await upload(station._id, { petrolImage: png("anon.png") });
      assert.equal(r.status, 401, JSON.stringify(r.body));
      assert.deepEqual([...listFiles()].filter((f) => !filesBefore.has(f)), []);
    });

    await t.test("a file that is not an image, or too large, is refused with a reason", async () => {
      const before = await Station.findById(station._id).lean();
      const filesBefore = listFiles();

      const notImage = await upload(
        station._id,
        { petrolImage: { bytes: Buffer.from("hello"), name: "notes.txt", type: "text/plain" } },
        tokenFor(owner._id),
      );
      assert.equal(notImage.status, 400, JSON.stringify(notImage.body));
      assert.match(notImage.body.msg, /JPG, PNG or WEBP/);

      const disguised = await upload(
        station._id,
        { cngImage: { bytes: PNG, name: "script.php", type: "image/png" } },
        tokenFor(owner._id),
      );
      assert.equal(disguised.status, 400, "the extension is checked as well as the type");

      const big = await upload(
        station._id,
        { cngImage: { bytes: Buffer.alloc(5 * 1024 * 1024 + 1), name: "huge.png", type: "image/png" } },
        tokenFor(owner._id),
      );
      assert.equal(big.status, 400, JSON.stringify(big.body));
      assert.match(big.body.msg, /too large.*5MB/);

      assert.deepEqual((await Station.findById(station._id).lean()).pumpImages, before.pumpImages);
      assert.deepEqual([...listFiles()].filter((f) => !filesBefore.has(f)), []);
    });

    await t.test("a request with no photo is refused", async () => {
      const r = await upload(station._id, {}, tokenFor(owner._id));
      assert.equal(r.status, 400);
      assert.match(r.body.msg, /Choose a Petrol Pump Image or a CNG Pump Image/);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const doc = await Station.findById(station._id).lean();
    [...saved, doc?.pumpImages?.petrol, doc?.pumpImages?.cng].forEach((p) => p && removeUploadedFile(p));
    await Station.deleteMany({ _id: station._id });
    await User.deleteMany({ _id: { $in: [owner._id, other._id] } });
    await mongoose.disconnect();
  }
});
