/**
 * The account-level profile photo: POST/DELETE /api/auth/profile/image.
 *
 * The handlers were already written and already safe -- they read the user id
 * from the verified session and write only that account. What was missing was
 * a route any role could reach, so an admin had no way to set a photo at all.
 * These tests hold the two things that matter about that route:
 *
 *   - an admin (and a vendor, and a customer) can set and clear THEIR OWN photo
 *   - nothing in the request can point it at somebody else's account
 *
 * DEVELOPMENT TEST DATA: users tagged "[photo-test]" and files under
 * uploads/profiles in the test database only, all removed at the end.
 *
 *   node --test test/profilePhoto.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const TAG = "[photo-test]";

/** A real PNG header saying 1200x800 -- enough for the type and size checks. */
function png(width = 1200, height = 800) {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

test("account profile photo against MongoDB", async (t) => {
  const testDb = require("./helpers/testDb");
  const MONGO = testDb.uri();
  testDb.isolateRedis();
  try {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  } catch {
    t.skip("MongoDB not reachable");
    return;
  }

  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const { User } = require("../src/models");
  const uploadRoot = path.join(__dirname, "..", "uploads");

  const tokenFor = (id) =>
    jwt.sign({ user: { id: String(id) } }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "30m" });

  const made = [];
  const uniq = () => Math.random().toString(36).slice(2, 10);
  const makeUser = async (role) => {
    const doc = await User.create({
      name: `${TAG} ${role}`,
      email: `photo.${uniq()}@example.com`,
      password: "x".repeat(60),
      role,
      isVerified: true,
      ...(role === "vendor" ? { vendorStatus: "active", activated: true } : {}),
    });
    made.push(doc._id);
    return doc;
  };

  /** Upload `file` as `token`'s own photo, plus any extra fields to try. */
  const upload = async (token, { bytes = png(), name = "me.png", type = "image/png", extra = {} } = {}) => {
    const body = new FormData();
    body.append("profileImage", new Blob([bytes], { type }), name);
    for (const [k, v] of Object.entries(extra)) body.append(k, v);
    const res = await fetch(`${base}/api/auth/profile/image`, {
      method: "POST",
      headers: token ? { "x-auth-token": token } : {},
      body,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const written = [];

  try {
    await t.test("an admin can set their own photo", async () => {
      const admin = await makeUser("admin");
      const r = await upload(tokenFor(admin._id));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.match(r.body.profileImage, /^\/uploads\/profiles\//);
      written.push(r.body.profileImage);

      const stored = await User.findById(admin._id).select("profileImage").lean();
      assert.equal(stored.profileImage, r.body.profileImage, "written to the admin's own account");
      assert.ok(fs.existsSync(path.join(uploadRoot, r.body.profileImage.replace("/uploads/", ""))), "the file is on disk");
    });

    await t.test("a vendor and a customer can too -- it is the account's own photo", async () => {
      for (const role of ["vendor", "customer"]) {
        const user = await makeUser(role);
        const r = await upload(tokenFor(user._id));
        assert.equal(r.status, 200, `${role}: ${JSON.stringify(r.body)}`);
        written.push(r.body.profileImage);
        assert.equal((await User.findById(user._id).select("profileImage").lean()).profileImage, r.body.profileImage);
      }
    });

    await t.test("the request cannot point the photo at another account", async () => {
      const admin = await makeUser("admin");
      const victim = await makeUser("customer");

      // The classic attempt: name someone else in the body.
      const r = await upload(tokenFor(admin._id), {
        extra: { userId: String(victim._id), id: String(victim._id), email: "victim@example.com" },
      });
      assert.equal(r.status, 200);
      written.push(r.body.profileImage);

      assert.equal(
        (await User.findById(victim._id).select("profileImage").lean()).profileImage,
        null,
        "the other account is untouched",
      );
      assert.equal((await User.findById(admin._id).select("profileImage").lean()).profileImage, r.body.profileImage);
    });

    await t.test("a signed-out caller is refused before any file is written", async () => {
      const before = fs.readdirSync(path.join(uploadRoot, "profiles")).length;
      const r = await upload(null);
      assert.equal(r.status, 401);
      assert.equal(fs.readdirSync(path.join(uploadRoot, "profiles")).length, before, "nothing was stored");
    });

    await t.test("a file that is not an image is refused with a reason", async () => {
      const admin = await makeUser("admin");
      const r = await upload(tokenFor(admin._id), {
        bytes: Buffer.from("not a picture"),
        name: "notes.txt",
        type: "text/plain",
      });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.msg, /JPG, PNG or WEBP/i);
      assert.equal((await User.findById(admin._id).select("profileImage").lean()).profileImage, null);
    });

    await t.test("replacing a photo removes the old file, and clearing it goes back to initials", async () => {
      const admin = await makeUser("admin");
      const token = tokenFor(admin._id);

      const first = await upload(token, { name: "first.png" });
      assert.equal(first.status, 200);
      const firstPath = path.join(uploadRoot, first.body.profileImage.replace("/uploads/", ""));

      const second = await upload(token, { name: "second.png" });
      assert.equal(second.status, 200);
      written.push(second.body.profileImage);
      assert.notEqual(second.body.profileImage, first.body.profileImage);
      assert.equal(fs.existsSync(firstPath), false, "the replaced file is gone, not left behind");

      const cleared = await fetch(`${base}/api/auth/profile/image`, {
        method: "DELETE",
        headers: { "x-auth-token": token },
      });
      assert.equal(cleared.status, 200);
      assert.equal((await User.findById(admin._id).select("profileImage").lean()).profileImage, null);
      assert.equal(
        fs.existsSync(path.join(uploadRoot, second.body.profileImage.replace("/uploads/", ""))),
        false,
        "and its file too",
      );
    });
  } finally {
    // Remove every file these tests stored, then the accounts.
    for (const stored of written) {
      const file = path.join(uploadRoot, String(stored).replace("/uploads/", ""));
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    await User.deleteMany({ _id: { $in: made } });
    server.close();
    await mongoose.disconnect();
  }
});
