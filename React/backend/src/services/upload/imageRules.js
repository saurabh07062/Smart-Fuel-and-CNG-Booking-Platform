/**
 * What a station photo has to be before it is kept.
 *
 * Type and size are already settled by middleware/upload.js. What it cannot
 * check is the picture itself, and that is where the real damage was: a tall
 * phone photo, or a 300px thumbnail, is stored happily and then stretched
 * across the customer's banner, where it reads as a zoomed-in smear. The fix
 * has to be at the door -- once a bad photo is in the database every page
 * that shows it has to cope with it.
 *
 * So the rule is checked here, on the server, and the file is deleted when it
 * fails. The vendor panel checks the same numbers in the browser first, which
 * is a courtesy (a message before a 4MB upload), never the guarantee.
 *
 * Dimensions are read from the file header directly. JPEG, PNG and WEBP are
 * the only formats the uploader accepts, and each states its size in the
 * first few hundred bytes, so this costs one small read and no dependency.
 */

const fs = require("fs");

/** Station and pump photos: a landscape picture big enough for the banner. */
const STATION_IMAGE_RULES = Object.freeze({
  minWidth: 800,
  minHeight: 450,
  maxWidth: 8000,
  maxHeight: 8000,
  /** width / height. 1.2 keeps portraits out; 2.6 keeps letterbox strips out. */
  minRatio: 1.2,
  maxRatio: 2.6,
  label: "at least 800 x 450 pixels and landscape (between 1.2:1 and 2.6:1)",
});

// ------------------------------------------------------------ header reader

/** PNG: an 8-byte signature, then an IHDR chunk with two big-endian uint32s. */
function pngSize(buf) {
  if (buf.length < 24) return null;
  const isPng = buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a;
  if (!isPng || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: "png" };
}

/**
 * JPEG: walk the marker segments until a start-of-frame (SOFn) carries the
 * height and width. SOF4, SOF8 and SOFC are not frame markers, and the
 * restart markers have no length, which is why this is a loop and not an
 * offset.
 */
function jpegSize(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1; // padding between segments
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = buf.readUInt16BE(i + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), format: "jpeg" };
    }
    i += 2 + length;
  }
  return null;
}

/** WEBP: "RIFF....WEBP" then one of three chunk layouts (lossy, lossless, extended). */
function webpSize(buf) {
  if (buf.length < 30) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buf.toString("ascii", 12, 16);

  if (chunk === "VP8 ") {
    // Lossy: a 3-byte frame tag, a 3-byte sync code, then 14-bit dimensions.
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: "webp" };
  }
  if (chunk === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: "webp" };
  }
  if (chunk === "VP8X") {
    const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
    const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
    return { width: w + 1, height: h + 1, format: "webp" };
  }
  return null;
}

/**
 * Pixel dimensions of an uploaded image, or null when the header cannot be
 * read (a corrupt file, or a format this does not know).
 */
function readImageSize(absPath) {
  let fd;
  try {
    fd = fs.openSync(absPath, "r");
    const buf = Buffer.alloc(65536);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, read);
    return pngSize(head) || jpegSize(head) || webpSize(head) || null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Check one uploaded file against a rule set.
 * @returns {string|null} the reason it fails, or null when it is acceptable.
 */
function checkImage(absPath, rules = STATION_IMAGE_RULES) {
  const size = readImageSize(absPath);
  if (!size || !size.width || !size.height) {
    return "That image could not be read. Upload a JPG, PNG or WEBP photo.";
  }

  const { width, height } = size;
  if (width < rules.minWidth || height < rules.minHeight) {
    return `That photo is ${width}x${height}. Upload one that is ${rules.label}.`;
  }
  if (width > rules.maxWidth || height > rules.maxHeight) {
    return `That photo is ${width}x${height}, which is larger than ${rules.maxWidth}x${rules.maxHeight}. Resize it and try again.`;
  }

  const ratio = width / height;
  if (ratio < rules.minRatio) {
    return `That photo is portrait (${width}x${height}). A station photo must be ${rules.label}.`;
  }
  if (ratio > rules.maxRatio) {
    return `That photo is too wide (${width}x${height}). A station photo must be ${rules.label}.`;
  }
  return null;
}

module.exports = { STATION_IMAGE_RULES, readImageSize, checkImage };
