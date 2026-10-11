const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { checkImage, readImageSize, STATION_IMAGE_RULES } = require("../src/services/upload/imageRules");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-img-"));

/** A minimal but real PNG header: signature + IHDR with the given size. */
function writePng(name, width, height) {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  return file;
}

/** A JPEG with one SOF0 frame carrying the size. */
function writeJpeg(name, width, height) {
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8 + 1, 2); // segment length
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xd8]), sof]));
  return file;
}

test("reads the size out of a PNG and a JPEG header", () => {
  assert.deepStrictEqual(readImageSize(writePng("a.png", 1600, 900)), {
    width: 1600,
    height: 900,
    format: "png",
  });
  assert.deepStrictEqual(readImageSize(writeJpeg("a.jpg", 1200, 800)), {
    width: 1200,
    height: 800,
    format: "jpeg",
  });
});

test("a landscape photo of a usable size is accepted", () => {
  assert.strictEqual(checkImage(writePng("good.png", 1600, 900)), null);
  assert.strictEqual(checkImage(writeJpeg("good.jpg", 1024, 576)), null);
});

test("a phone portrait is refused, and the reason says so", () => {
  const why = checkImage(writePng("tall.png", 1080, 1920));
  assert.match(why, /portrait/i);
  assert.match(why, /1080x1920/);
});

test("a thumbnail is refused for being too small", () => {
  const why = checkImage(writePng("small.png", 320, 200));
  assert.match(why, new RegExp(`${STATION_IMAGE_RULES.minWidth}`));
});

test("a letterbox strip is refused for being too wide", () => {
  assert.match(checkImage(writePng("strip.png", 3000, 600)), /too wide/i);
});

test("a file whose header is not an image at all is refused", () => {
  const file = path.join(dir, "not-an-image.png");
  fs.writeFileSync(file, Buffer.from("this is text, renamed"));
  assert.match(checkImage(file), /could not be read/i);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
