/**
 * File uploads. One Multer configuration for the whole application.
 *
 * Replaces services/upload.js, which handled only vendor registration and
 * wrote every file into uploads/vendors regardless of what it was.
 *
 * WHAT MAKES THIS SAFE
 *
 *   Category is chosen by the ROUTE, never by the request. `uploadImage
 *   ("vehicles", ...)` is written into the route table, so a caller cannot
 *   name their own destination and drop a file into, say, documents/. This is
 *   the single most important property here -- a client-supplied destination
 *   is a directory-traversal bug waiting to happen.
 *
 *   Filenames are generated, never taken from the upload. An original name
 *   can contain path separators, null bytes, a double extension
 *   ("photo.jpg.php"), or simply collide with an existing file. The stored
 *   name is <category>-<timestamp>-<16 random hex>.<ext>, where ext is
 *   re-derived from a whitelist rather than copied.
 *
 *   Both the MIME type and the extension must be on the whitelist. Either
 *   alone is trivially spoofed: the browser sets the MIME type from the file
 *   extension, and a renamed file carries whatever extension it likes.
 *
 *   Uploaded files cannot execute. They land outside any route that runs
 *   code, are served by express.static with `Content-Type` forced from the
 *   whitelist and `X-Content-Type-Options: nosniff` (see server.js), and no
 *   executable extension is ever accepted in the first place.
 */

const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Resolved from __dirname, not process.cwd(): the app is started from
// different working directories (npm scripts, node src/server.js, a
// process manager), and cwd-relative paths silently create a second uploads
// tree in whichever directory happened to be current.
const UPLOAD_ROOT = path.join(__dirname, "..", "..", "uploads");

/**
 * The only destinations that exist. A category not in this map cannot be
 * uploaded to, and `resolveDir` refuses anything that escapes UPLOAD_ROOT.
 */
const CATEGORIES = {
  vehicles: { maxBytes: 5 * 1024 * 1024, kind: "image" },
  profiles: { maxBytes: 3 * 1024 * 1024, kind: "image" },
  vendors: { maxBytes: 5 * 1024 * 1024, kind: "image" },
  stations: { maxBytes: 5 * 1024 * 1024, kind: "image" },
  // Documents are what a vendor uploads for verification: a licence, a GST
  // certificate. PDFs are allowed here and nowhere else.
  documents: { maxBytes: 10 * 1024 * 1024, kind: "document" },
};

/** MIME type -> the extension we will store it as. */
const IMAGE_TYPES = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const DOCUMENT_TYPES = {
  ...IMAGE_TYPES,
  "application/pdf": ".pdf",
};

/** Extensions a client may present, checked alongside the MIME type. */
const ALLOWED_EXT = {
  image: [".jpg", ".jpeg", ".png", ".webp"],
  document: [".jpg", ".jpeg", ".png", ".webp", ".pdf"],
};

const HUMAN = {
  image: "JPG, PNG or WEBP",
  document: "JPG, PNG, WEBP or PDF",
};

// ------------------------------------------------------------- directories

/**
 * Absolute path for a category, created on demand.
 *
 * Created lazily rather than all at once on boot so a deployment that never
 * uploads a document does not carry an empty documents/ directory, and so a
 * directory deleted while the server is running is recreated on the next
 * upload instead of failing every request from then on.
 */
function resolveDir(category) {
  const dir = path.join(UPLOAD_ROOT, category);
  // Defence in depth. `category` only ever comes from the CATEGORIES keys
  // below, but if that ever changes this stops a traversal reaching the
  // filesystem.
  const rel = path.relative(UPLOAD_ROOT, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to upload outside the uploads directory: ${category}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** `<category>-<time>-<random>.<ext>` — unguessable and collision-proof. */
function safeFilename(category, mimetype, kind) {
  const table = kind === "document" ? DOCUMENT_TYPES : IMAGE_TYPES;
  const ext = table[mimetype] || ".bin";
  const random = require("crypto").randomBytes(8).toString("hex");
  return `${category}-${Date.now()}-${random}${ext}`;
}

// ------------------------------------------------------------------ multer

function buildUploader(category) {
  const config = CATEGORIES[category];
  if (!config) throw new Error(`Unknown upload category: ${category}`);

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        cb(null, resolveDir(category));
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      cb(null, safeFilename(category, file.mimetype, config.kind));
    },
  });

  function fileFilter(req, file, cb) {
    const table = config.kind === "document" ? DOCUMENT_TYPES : IMAGE_TYPES;
    const ext = path.extname(file.originalname || "").toLowerCase();

    // Both must pass. A .php renamed to .png presents image/png from the
    // browser; a real PNG renamed to .php presents the right MIME with the
    // wrong extension. Neither gets through.
    const mimeOk = Object.prototype.hasOwnProperty.call(table, file.mimetype);
    const extOk = ALLOWED_EXT[config.kind].includes(ext);

    if (mimeOk && extOk) return cb(null, true);

    const err = new Error(
      `"${file.originalname}" is not an accepted file. Upload ${HUMAN[config.kind]}.`,
    );
    err.code = "INVALID_FILE_TYPE";
    return cb(err, false);
  }

  return multer({
    storage,
    fileFilter,
    limits: {
      fileSize: config.maxBytes,
      // Caps the multipart body itself, not just each file: without this a
      // request can carry unlimited non-file fields.
      fields: 40,
      fieldSize: 100 * 1024,
    },
  });
}

// One uploader per category, built once. multer instances are stateless
// factories, so rebuilding per request would just be waste.
const uploaders = {};
for (const category of Object.keys(CATEGORIES)) {
  uploaders[category] = buildUploader(category);
}

// ------------------------------------------------------------ public API

/**
 * Middleware for a single image field.
 * @param {string} category  one of CATEGORIES — fixed by the route
 * @param {string} field     the multipart field name the client must use
 */
function uploadImage(category, field) {
  assertCategory(category);
  return wrap(uploaders[category].single(field), category);
}

/** Middleware for up to `maxCount` images under one field name. */
function uploadImages(category, field, maxCount = 5) {
  assertCategory(category);
  return wrap(uploaders[category].array(field, maxCount), category);
}

/**
 * Middleware for several differently-named files in one request, e.g. a
 * vendor's licence and GST certificate together.
 * @param {Array<{name: string, maxCount: number}>} fields
 */
function uploadFields(category, fields) {
  assertCategory(category);
  return wrap(uploaders[category].fields(fields), category);
}

function assertCategory(category) {
  if (!CATEGORIES[category]) {
    throw new Error(
      `Unknown upload category "${category}". Add it to CATEGORIES in middleware/upload.js.`,
    );
  }
}

/**
 * Turn Multer's errors into the response shape the rest of this API uses.
 *
 * Without this a rejected upload surfaces as an unhandled error and the
 * global handler answers 500 "Server error" -- which tells the person who
 * picked a 12MB photo nothing at all.
 */
function wrap(mw, category) {
  const limitMb = (CATEGORIES[category].maxBytes / (1024 * 1024)).toFixed(0);

  return function (req, res, next) {
    mw(req, res, (err) => {
      if (!err) return next();

      if (err.code === "INVALID_FILE_TYPE") {
        return res.status(400).json({ msg: err.message, code: err.code });
      }
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          msg: `That file is too large. The limit is ${limitMb}MB.`,
          code: err.code,
        });
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({
          msg: `Too many files, or a file was sent under an unexpected field name (${err.field || "unknown"}).`,
          code: err.code,
        });
      }
      if (err.code && String(err.code).startsWith("LIMIT_")) {
        return res.status(400).json({ msg: "That upload was rejected.", code: err.code });
      }

      // Anything else is ours, not the caller's. Log it server-side; the
      // message may contain a filesystem path, which must not go out.
      console.error(`[upload:${category}]`, err);
      return res.status(500).json({ msg: "The file could not be uploaded. Please try again." });
    });
  };
}

// ------------------------------------------------------------- file helpers

/**
 * The public path stored in the database and handed to the frontend.
 * Relative, so the same row works on localhost and behind a domain.
 */
function publicPath(category, filename) {
  if (!filename) return null;
  return `/uploads/${category}/${filename}`;
}

/** `req.file` -> the value to store, or null when nothing was uploaded. */
function storedPath(file, category) {
  if (!file || !file.filename) return null;
  return publicPath(category, file.filename);
}

/**
 * Delete a previously uploaded file, given the public path stored on a
 * record. Never throws: cleanup failing must not fail the request that
 * triggered it, and a missing file is the desired end state anyway.
 *
 * Refuses anything that is not inside the uploads tree, so a corrupted or
 * hostile database value cannot be used to delete arbitrary files.
 */
function removeUploadedFile(publicPathValue) {
  if (!publicPathValue || typeof publicPathValue !== "string") return false;
  if (!publicPathValue.startsWith("/uploads/")) return false;

  try {
    const abs = path.join(UPLOAD_ROOT, publicPathValue.replace(/^\/uploads\//, ""));
    const rel = path.relative(UPLOAD_ROOT, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    if (!fs.existsSync(abs)) return false;
    fs.unlinkSync(abs);
    return true;
  } catch (err) {
    console.error("[upload] could not remove file:", err.message);
    return false;
  }
}

module.exports = {
  uploadImage,
  uploadImages,
  uploadFields,
  publicPath,
  storedPath,
  removeUploadedFile,
  UPLOAD_ROOT,
  CATEGORIES,
};
