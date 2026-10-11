/**
 * The employee photo: POST/PUT/DELETE /api/vendor-panel/employees.
 *
 * A staff list that shows faces is read at a glance; one that shows initials
 * is read letter by letter. The photo is stored exactly as a customer's
 * profile photo is (models/User.js profileImage) -- a path under /uploads,
 * never the image itself -- so these tests hold the three things that go
 * wrong with file-backed fields:
 *
 *   - the path is stored and the file is actually on disk
 *   - replacing a photo deletes the old file, and only after the new path
 *     has committed; a failed save must not take the old image with it
 *   - removing the employee removes the image too, rather than leaving an
 *     orphan in uploads/ forever
 *
 * And the one thing that goes wrong with vendor-scoped records: one vendor
 * must not be able to photograph another vendor's staff.
 *
 * DEVELOPMENT TEST DATA: vendors and employees tagged "empphoto-<time>" plus
 * files under uploads/profiles, in the TEST database only, all removed at the
 * end.
 *
 *   node --test test/employeePhoto.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const testDb = require("./helpers/testDb");

/** A real PNG header saying 1200x800 -- enough for the type and size checks. */
function png() {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8); // IHDR length
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(1200, 16);
  buf.writeUInt32BE(800, 20);
  return buf;
}
const PNG = png();

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("employee photo against MongoDB", async (t) => {
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
  const Employee = require("../src/models/Employee");
  const { UPLOAD_ROOT } = require("../src/middleware/upload");
  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const profilesDir = path.join(UPLOAD_ROOT, "profiles");
  const countFiles = () => (fs.existsSync(profilesDir) ? fs.readdirSync(profilesDir).length : 0);
  const onDisk = (publicPath) => fs.existsSync(path.join(UPLOAD_ROOT, String(publicPath).replace(/^\/uploads\//, "")));

  const tag = `empphoto-${Date.now()}`;
  const tokenFor = (id) =>
    jwt.sign({ user: { id: String(id) } }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "30m" });
  const makeVendor = (suffix) =>
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

  // Phone numbers must be unique per vendor, so hand each case its own.
  let nextPhone = 9810000000;
  const phone = () => String(++nextPhone);

  /** POST or PUT an employee, with or without a photo part. */
  const send = async (method, url, token, fields, file) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    if (file) form.append("employeePhoto", new Blob([file.bytes], { type: file.type }), file.name);
    const res = await fetch(`${base}${url}`, {
      method,
      headers: token ? { "x-auth-token": token } : {},
      body: form,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const create = (token, extra = {}, file = { bytes: PNG, name: "face.png", type: "image/png" }) =>
    send("POST", "/api/vendor-panel/employees", token, { name: `${tag} attendant`, phone: phone(), ...extra }, file);

  const owner = await makeVendor("owner");
  const other = await makeVendor("other");
  const ownerToken = tokenFor(owner._id);
  const written = [];
  const remember = (p) => {
    if (p) written.push(p);
    return p;
  };
  /** The employee document, whatever shape the handler wraps its reply in. */
  const docOf = (body) => body.employee || body.data || body;

  try {
    await t.test("a photo sent with a new employee is stored as a path, and the file is on disk", async () => {
      const r = await create(ownerToken);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const emp = docOf(r.body);
      assert.match(emp.photo, /^\/uploads\/profiles\//, "a path, not the image");
      remember(emp.photo);

      const stored = await Employee.findById(emp._id).lean();
      assert.equal(stored.photo, emp.photo, "the same path is on the record");
      assert.equal(String(stored.vendor), String(owner._id), "owned by the vendor who sent it");
      assert.ok(onDisk(emp.photo), "the file itself was written");
    });

    await t.test("the photo is optional -- no part means null, and the list falls back to initials", async () => {
      const r = await send("POST", "/api/vendor-panel/employees", ownerToken, {
        name: `${tag} no-photo`,
        phone: phone(),
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const emp = docOf(r.body);
      assert.equal(emp.photo, null, "null is a perfectly good answer");

      const list = await fetch(`${base}/api/vendor-panel/employees`, { headers: { "x-auth-token": ownerToken } });
      assert.equal(list.status, 200);
      const rows = await list.json();
      const arr = Array.isArray(rows) ? rows : Object.values(rows).find(Array.isArray) || [];
      const mine = arr.find((e) => String(e._id) === String(emp._id));
      assert.ok(mine, "the new employee is in the vendor's own list");
      assert.equal(mine.photo, null);
    });

    await t.test("replacing the photo stores the new file and deletes the old one", async () => {
      const created = docOf((await create(ownerToken)).body);
      const first = remember(created.photo);
      assert.ok(onDisk(first));

      const r = await send(
        "PUT",
        `/api/vendor-panel/employees/${created._id}`,
        ownerToken,
        { name: `${tag} renamed` },
        { bytes: PNG, name: "second.png", type: "image/png" },
      );
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const second = remember(docOf(r.body).photo);

      assert.notEqual(second, first, "a new file, not the old name reused");
      assert.ok(onDisk(second), "the replacement is on disk");
      assert.equal(onDisk(first), false, "the replaced file is gone, not left behind");
      assert.equal((await Employee.findById(created._id).lean()).photo, second);
    });

    await t.test("a file that is not an image is refused, and the employee keeps the photo it had", async () => {
      const created = docOf((await create(ownerToken)).body);
      const kept = remember(created.photo);
      const before = countFiles();

      const r = await send(
        "PUT",
        `/api/vendor-panel/employees/${created._id}`,
        ownerToken,
        {},
        { bytes: Buffer.from("not a picture"), name: "notes.txt", type: "text/plain" },
      );
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.msg, /JPG, PNG or WEBP/i, "and says why");

      assert.equal((await Employee.findById(created._id).lean()).photo, kept, "the good photo survived a bad upload");
      assert.ok(onDisk(kept));
      assert.equal(countFiles(), before, "and nothing was stored for the rejected file");
    });

    await t.test("removing the employee removes the image too", async () => {
      const created = docOf((await create(ownerToken)).body);
      const stored = created.photo;
      assert.ok(onDisk(stored));

      const res = await fetch(`${base}/api/vendor-panel/employees/${created._id}`, {
        method: "DELETE",
        headers: { "x-auth-token": ownerToken },
      });
      assert.equal(res.status, 200);
      assert.equal(await Employee.findById(created._id), null);
      assert.equal(onDisk(stored), false, "no orphan left in uploads/");
    });

    await t.test("another vendor cannot photograph this vendor's staff", async () => {
      const created = docOf((await create(ownerToken)).body);
      const mine = remember(created.photo);
      const before = countFiles();

      const r = await send(
        "PUT",
        `/api/vendor-panel/employees/${created._id}`,
        tokenFor(other._id),
        { name: "hijacked" },
        { bytes: PNG, name: "theirs.png", type: "image/png" },
      );
      assert.ok(r.status === 403 || r.status === 404, `refused, got ${r.status}`);

      const after = await Employee.findById(created._id).lean();
      assert.equal(after.photo, mine, "the photo is untouched");
      assert.equal(after.name, `${tag} attendant`, "and so is the name");
      assert.equal(countFiles(), before, "nothing was written for the rejected caller");
    });

    await t.test("a signed-out caller is refused before any file is written", async () => {
      const before = countFiles();
      const r = await create(null);
      assert.equal(r.status, 401);
      assert.equal(countFiles(), before, "nothing was stored");
    });
  } finally {
    for (const stored of written) {
      const file = path.join(UPLOAD_ROOT, String(stored).replace(/^\/uploads\//, ""));
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    const leftovers = await Employee.find({ vendor: { $in: [owner._id, other._id] } }).lean();
    for (const e of leftovers) {
      if (e.photo) {
        const file = path.join(UPLOAD_ROOT, String(e.photo).replace(/^\/uploads\//, ""));
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    }
    await Employee.deleteMany({ vendor: { $in: [owner._id, other._id] } });
    await User.deleteMany({ _id: { $in: [owner._id, other._id] } });
    server.close();
    await mongoose.disconnect();
  }
});
