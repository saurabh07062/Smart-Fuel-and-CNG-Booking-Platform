/**
 * File uploads, end to end against the running API.
 *
 * Covers the whole path a real request takes: multipart in, multer to disk,
 * public path into MongoDB, and the file actually fetchable over HTTP. A test
 * that stopped at "the controller returned 200" would miss the case this
 * codebase was already in -- files written correctly and then unreachable,
 * because nothing served the directory.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const API = require("./helpers/testDb").apiUrl();
const MONGO = require("./helpers/testDb").uri();
const { UPLOAD_ROOT } = require("../src/middleware/upload");

// A real 1x1 PNG. Multer inspects the declared MIME type rather than the
// bytes, but using genuine image data keeps the test honest about what is
// being stored.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function pngFile(name = "photo.png", type = "image/png", buf = PNG_1PX) {
  return new File([buf], name, { type });
}

test("vehicle, profile and station uploads: end to end", async (t) => {
  const reachable = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    t.skip(`API not reachable at ${API} — start the stack to run this test`);
    return;
  }

  const mongoose = require("mongoose");
  const bcrypt = require("bcryptjs");
  const jwt = require("jsonwebtoken");
  await mongoose.connect(MONGO);

  const User = require("../src/models/User");
  const tag = `uptest-${Date.now()}`;

  const customer = await User.create({
    name: `${tag}-cust`,
    email: `${tag}-cust@fuelmart.test`,
    password: await bcrypt.hash("uptest12345", 8),
    role: "customer",
    isVerified: true,
  });
  const token = jwt.sign({ user: { id: customer.id } }, process.env.JWT_SECRET, {
    expiresIn: "1h",
  });

  const post = (url, form) =>
    fetch(`${API}${url}`, { method: "POST", headers: { "x-auth-token": token }, body: form });

  const created = []; // public paths, for cleanup assertions
  let failure = null;

  try {
    // ------------------------------------------------ valid vehicle image
    await t.test("a vehicle image is stored, recorded and then served", async () => {
      const form = new FormData();
      form.append("nickname", "Test Car");
      form.append("registrationNumber", "MH12XY0001");
      form.append("vehicleType", "Car");
      form.append("fuelType", "Petrol");
      form.append("vehicleImage", pngFile());

      const res = await post("/api/customer/vehicles", form);
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));

      const vehicle = body.vehicles.find((v) => v.registrationNumber === "MH12XY0001");
      assert.ok(vehicle, "vehicle was not saved");
      assert.ok(vehicle.image, "no image path recorded on the vehicle");
      assert.match(vehicle.image, /^\/uploads\/vehicles\/vehicles-\d+-[a-f0-9]{16}\.png$/);
      created.push(vehicle.image);

      // The original filename must not survive into storage.
      assert.ok(!vehicle.image.includes("photo"), "stored name came from the upload");

      // On disk...
      const abs = path.join(UPLOAD_ROOT, vehicle.image.replace("/uploads/", ""));
      assert.ok(fs.existsSync(abs), "file is not on disk");

      // ...and actually reachable, which is the part that was broken before.
      const fetched = await fetch(`${API}${vehicle.image}`);
      assert.equal(fetched.status, 200, "uploaded file is not served");
      assert.equal(fetched.headers.get("content-type"), "image/png");
      assert.equal(fetched.headers.get("x-content-type-options"), "nosniff");
    });

    // ------------------------------------------------ image stays optional
    await t.test("a vehicle can still be added with no image at all", async () => {
      const res = await fetch(`${API}/api/customer/vehicles`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-auth-token": token },
        body: JSON.stringify({
          nickname: "No Photo",
          registrationNumber: "MH12XY0002",
          vehicleType: "Bike",
          fuelType: "Petrol",
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      const v = body.vehicles.find((x) => x.registrationNumber === "MH12XY0002");
      assert.ok(v, "JSON request without a file stopped working");
      assert.ok(!v.image, "an image appeared from nowhere");
    });

    // -------------------------------------------- multiple, each its own
    await t.test("each of several vehicles keeps its own distinct image", async () => {
      const paths = [];
      for (const reg of ["MH12XY0003", "MH12XY0004"]) {
        const form = new FormData();
        form.append("nickname", "Car " + reg);
        form.append("registrationNumber", reg);
        form.append("vehicleType", "Car");
        form.append("fuelType", "Diesel");
        form.append("vehicleImage", pngFile());
        const res = await post("/api/customer/vehicles", form);
        const body = await res.json();
        assert.equal(res.status, 200, JSON.stringify(body));
        paths.push(body.vehicles.find((v) => v.registrationNumber === reg).image);
      }
      assert.equal(new Set(paths).size, 2, "two vehicles share one image path");
      paths.forEach((p) => created.push(p));
    });

    // ------------------------------------------------ rejected file types
    await t.test("an executable disguised as an image is rejected", async () => {
      const form = new FormData();
      form.append("nickname", "Bad");
      form.append("registrationNumber", "MH12XY0009");
      form.append("vehicleType", "Car");
      form.append("fuelType", "Petrol");
      form.append("vehicleImage", new File(["<?php echo 1; ?>"], "shell.php", {
        type: "application/x-php",
      }));

      const res = await post("/api/customer/vehicles", form);
      const body = await res.json();
      assert.equal(res.status, 400);
      assert.equal(body.code, "INVALID_FILE_TYPE");
      assert.match(body.msg, /JPG, PNG or WEBP/);
      // ...and no vehicle was created as a side effect.
      const after = await User.findById(customer._id).lean();
      assert.ok(!after.vehicles.some((v) => v.registrationNumber === "MH12XY0009"));
    });

    await t.test("a PHP file claiming image/png is still rejected", async () => {
      // The extension check is what catches this: the browser-declared MIME
      // type is attacker-controlled and says image/png.
      const form = new FormData();
      form.append("nickname", "Bad2");
      form.append("registrationNumber", "MH12XY0010");
      form.append("vehicleType", "Car");
      form.append("fuelType", "Petrol");
      form.append("vehicleImage", new File(["<?php ?>"], "shell.php", { type: "image/png" }));

      const res = await post("/api/customer/vehicles", form);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "INVALID_FILE_TYPE");
    });

    await t.test("PDF is refused for a vehicle but allowed as a document", async () => {
      const form = new FormData();
      form.append("nickname", "Pdf");
      form.append("registrationNumber", "MH12XY0011");
      form.append("vehicleType", "Car");
      form.append("fuelType", "Petrol");
      form.append("vehicleImage", new File(["%PDF-1.4"], "doc.pdf", { type: "application/pdf" }));

      const res = await post("/api/customer/vehicles", form);
      assert.equal(res.status, 400, "a PDF was accepted as a vehicle photo");
    });

    // ---------------------------------------------------- size limiting
    await t.test("an oversized image is rejected with a usable message", async () => {
      const big = Buffer.alloc(6 * 1024 * 1024, 0x41); // 6MB, limit is 5MB
      const form = new FormData();
      form.append("nickname", "Huge");
      form.append("registrationNumber", "MH12XY0012");
      form.append("vehicleType", "Car");
      form.append("fuelType", "Petrol");
      form.append("vehicleImage", pngFile("huge.png", "image/png", big));

      const res = await post("/api/customer/vehicles", form);
      const body = await res.json();
      assert.equal(res.status, 400);
      assert.equal(body.code, "LIMIT_FILE_SIZE");
      assert.match(body.msg, /5MB/);
    });

    // ------------------------------------------- replacing an image
    await t.test("replacing a vehicle image deletes the old file", async () => {
      const before = await User.findById(customer._id).lean();
      const target = before.vehicles.find((v) => v.registrationNumber === "MH12XY0001");
      const oldPath = target.image;
      const oldAbs = path.join(UPLOAD_ROOT, oldPath.replace("/uploads/", ""));
      assert.ok(fs.existsSync(oldAbs));

      const form = new FormData();
      form.append("vehicleImage", pngFile("replacement.png"));
      const res = await fetch(`${API}/api/customer/vehicles/${target._id}`, {
        method: "PUT",
        headers: { "x-auth-token": token },
        body: form,
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));

      const updated = body.vehicles.find((v) => v.registrationNumber === "MH12XY0001");
      assert.notEqual(updated.image, oldPath, "the image path did not change");
      created.push(updated.image);

      assert.ok(!fs.existsSync(oldAbs), "the superseded file was left on disk");
      const newAbs = path.join(UPLOAD_ROOT, updated.image.replace("/uploads/", ""));
      assert.ok(fs.existsSync(newAbs), "the replacement is missing");
    });

    // --------------------------------------------------- deleting
    await t.test("deleting a vehicle removes its image", async () => {
      const before = await User.findById(customer._id).lean();
      const target = before.vehicles.find((v) => v.registrationNumber === "MH12XY0003");
      const abs = path.join(UPLOAD_ROOT, target.image.replace("/uploads/", ""));
      assert.ok(fs.existsSync(abs));

      const res = await fetch(`${API}/api/customer/vehicles/${target._id}`, {
        method: "DELETE",
        headers: { "x-auth-token": token },
      });
      assert.equal(res.status, 200);
      assert.ok(!fs.existsSync(abs), "the image outlived its vehicle");
    });

    // --------------------------------------------------- profile image
    await t.test("a profile photo is stored on the user and served", async () => {
      const form = new FormData();
      form.append("profileImage", pngFile("me.png"));
      const res = await post("/api/customer/profile/image", form);
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.match(body.profileImage, /^\/uploads\/profiles\//);
      created.push(body.profileImage);

      const fresh = await User.findById(customer._id).lean();
      assert.equal(fresh.profileImage, body.profileImage);

      const served = await fetch(`${API}${body.profileImage}`);
      assert.equal(served.status, 200);
    });

    // ------------------------------------------------- authorisation
    await t.test("uploading requires authentication", async () => {
      const form = new FormData();
      form.append("profileImage", pngFile());
      const res = await fetch(`${API}/api/customer/profile/image`, {
        method: "POST",
        body: form,
      });
      assert.equal(res.status, 401, "an anonymous caller could upload");
    });

    await t.test("one customer cannot touch another's vehicle", async () => {
      const other = await User.create({
        name: `${tag}-other`,
        email: `${tag}-other@fuelmart.test`,
        password: await bcrypt.hash("uptest12345", 8),
        role: "customer",
        isVerified: true,
      });
      const otherToken = jwt.sign({ user: { id: other.id } }, process.env.JWT_SECRET, {
        expiresIn: "1h",
      });

      const mine = await User.findById(customer._id).lean();
      const victim = mine.vehicles.find((v) => v.registrationNumber === "MH12XY0004");

      const form = new FormData();
      form.append("vehicleImage", pngFile());
      const res = await fetch(`${API}/api/customer/vehicles/${victim._id}`, {
        method: "PUT",
        headers: { "x-auth-token": otherToken },
        body: form,
      });
      assert.equal(res.status, 404, "a vehicle was editable by the wrong user");

      // The victim's image must be untouched.
      const still = await User.findById(customer._id).lean();
      const after = still.vehicles.find((v) => v.registrationNumber === "MH12XY0004");
      assert.equal(after.image, victim.image);

      await User.deleteOne({ _id: other._id });
    });
  } catch (err) {
    failure = err;
  } finally {
    // Remove anything this test wrote, whether or not it asserted on it.
    const fresh = await User.findById(customer._id).lean().catch(() => null);
    if (fresh) {
      (fresh.vehicles || []).forEach((v) => v.image && created.push(v.image));
      if (fresh.profileImage) created.push(fresh.profileImage);
    }
    for (const p of new Set(created)) {
      const abs = path.join(UPLOAD_ROOT, String(p).replace("/uploads/", ""));
      try {
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch {
        /* best effort */
      }
    }
    await User.deleteMany({ email: { $regex: `^${tag}-` } });
    await mongoose.disconnect();
    await require("../src/services/core/lock").close();
    await require("../src/services/security/rateLimiter").close();
  }

  if (failure) throw failure;
});
