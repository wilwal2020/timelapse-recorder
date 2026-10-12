// Node harness for the plugin's Photoshop-free modules.
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const assert = require("assert");
const SRC = path.join(__dirname, "..", "src");
const b64 = require(path.join(SRC, "b64.js"));
const plan = require(path.join(SRC, "plan.js"));
const raster = require(path.join(SRC, "raster.js"));
const decodeJpeg = require(path.join(SRC, "jpeg-decoder.js"));
const encoder = require("jpeg-js").encode;

function writePng(file, rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

// ---- b64
for (const n of [0, 1, 2, 3, 4, 5, 100, 12287, 12288, 12289, 50000]) {
  const bytes = new Uint8Array(n); for (let i = 0; i < n; i++) bytes[i] = (Math.random() * 256) | 0;
  const s = b64.encode(bytes);
  assert.strictEqual(s, Buffer.from(bytes).toString("base64"), "encode " + n);
  const back = b64.decode(s);
  assert.deepStrictEqual(Buffer.from(back), Buffer.from(bytes), "decode " + n);
}
console.log("b64 ok");

// ---- plan
{
  const p = plan.planExport(1000, { fps: 30, lengthSec: "auto", introSec: 1, holdSec: 3, slowEnd: false });
  assert.strictEqual(p.intro, 30); assert.strictEqual(p.hold, 90);
  assert.strictEqual(p.main.length, 1000); // 33.3 s auto -> every frame once
  assert.strictEqual(p.at(0).part, "intro"); assert.strictEqual(p.at(0).src, 999);
  assert.strictEqual(p.at(30).src, 0); assert.strictEqual(p.at(30 + 999).src, 999);
  assert.strictEqual(p.at(p.total - 1).part, "hold");
  for (let j = 1; j < p.main.length; j++) assert.ok(p.main[j] === p.main[j - 1] + 1);
  const big = plan.planExport(5000, { fps: 30, lengthSec: "auto", introSec: 0, holdSec: 0, slowEnd: false });
  assert.strictEqual(big.main.length, 1800); assert.strictEqual(big.seconds, 60);
  const small = plan.planExport(20, { fps: 30, lengthSec: "auto", introSec: 0, holdSec: 0, slowEnd: false });
  assert.strictEqual(small.main.length, 150); assert.strictEqual(small.main[0], 0); assert.strictEqual(small.main[149], 19);
  const slow = plan.planExport(3000, { fps: 30, lengthSec: 30, introSec: 0, holdSec: 0, slowEnd: true });
  assert.strictEqual(slow.main.length, 900); assert.strictEqual(slow.main[0], 0); assert.strictEqual(slow.main[899], 2999);
  for (let j = 1; j < slow.main.length; j++) assert.ok(slow.main[j] >= slow.main[j - 1], "monotonic");
  const early = slow.main[100] - slow.main[99], late = slow.main[898] - slow.main[897];
  console.log("slowEnd step early", early, "late", late, "at 75%:", slow.main[675], "of 2999");
  const one = plan.planExport(1, { fps: 30, lengthSec: "auto", introSec: 0, holdSec: 2, slowEnd: true });
  assert.strictEqual(one.main[0], 0); assert.strictEqual(one.at(one.total - 1).src, 0);
}
console.log("plan ok");

// ---- raster: synthetic "painting"
function makePainting(w, h) {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    rgb[i] = 230 - (y / h) * 90; rgb[i + 1] = 200 + (x / w) * 40; rgb[i + 2] = 170 + ((x + y) % 64);
    const dx = x - w * 0.55, dy = y - h * 0.45;
    if (dx * dx + dy * dy < (h * 0.25) ** 2) { rgb[i] = 60; rgb[i + 1] = 90; rgb[i + 2] = 160; }
  }
  return rgb;
}
{
  const W = 1280, H = 720;
  const img = makePainting(W, H);
  raster.drawBadge(img, W, H, raster.makeBadge(raster.formatWorkLabel((12 * 60 + 34) * 60000), H), "br");
  raster.drawBadge(img, W, H, raster.makeBadge(raster.formatWorkLabel(45 * 60000), H), "tl");
  raster.drawBadge(img, W, H, raster.makeBadge("0123456789", H), "tr");
  writePng(path.join(require("os").tmpdir(), "out_badges.png"), img, W, H);
  // big badge to inspect glyph shapes
  const BW = 900, BH = 260;
  const big = new Uint8Array(BW * BH * 3).fill(120);
  const badge = raster.makeBadge("0123456789", 2600);
  raster.drawBadge(big, BW, BH, badge, "tl");
  const badge2 = raster.makeBadge("1h 58m", 2600);
  raster.drawBadge(big, BW, BH, badge2, "bl");
  writePng(path.join(require("os").tmpdir(), "out_glyphs.png"), big, BW, BH);

  // letterbox a portrait frame into landscape output
  const pw = 600, ph = 900;
  const portrait = makePainting(pw, ph);
  const lb = raster.letterbox(portrait, pw, ph, W, H, [0, 0, 0]);
  writePng(path.join(require("os").tmpdir(), "out_letterbox.png"), lb, W, H);

  // change counting
  const a = makePainting(64, 64), b = new Uint8Array(a);
  assert.strictEqual(raster.countChanged(a, b, 0, 0), 0);
  b[3 * 100] += 3; b[3 * 200 + 1] += 10;
  assert.strictEqual(raster.countChanged(a, b, 0, 10), 2);
  assert.strictEqual(raster.countChanged(a, b, 4, 10), 1);
  assert.strictEqual(raster.countChanged(a, b, 0, 0), 1); // early exit
}
console.log("raster ok");

// ---- jpeg round trip + timing
{
  const W = 1920, H = 1080;
  const rgb = makePainting(W, H);
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0, o = 0; i < rgb.length; i += 3, o += 4) { rgba[o] = rgb[i]; rgba[o + 1] = rgb[i + 1]; rgba[o + 2] = rgb[i + 2]; rgba[o + 3] = 255; }
  const jpg = encoder({ data: rgba, width: W, height: H }, 90).data;
  let t = Date.now();
  const dec = decodeJpeg(new Uint8Array(jpg).buffer, { useTArray: true, formatAsRGBA: false });
  const tDec = Date.now() - t;
  assert.strictEqual(dec.width, W); assert.strictEqual(dec.height, H); assert.strictEqual(dec.data.length, W * H * 3);
  let maxErr = 0; for (let i = 0; i < 3000; i++) { const k = (Math.random() * rgb.length) | 0; maxErr = Math.max(maxErr, Math.abs(dec.data[k] - rgb[k])); }
  t = Date.now();
  const down = raster.resize(makePainting(2560, 1440), 2560, 1440, 1920, 1080);
  const tRes = Date.now() - t;
  t = Date.now();
  const up = raster.letterbox(makePainting(1280, 720), 1280, 720, 1920, 1080, [0, 0, 0]);
  const tUp = Date.now() - t;
  console.log("jpeg ok: decode", tDec, "ms, sample max err", maxErr, "| resize 2560->1920", tRes, "ms | upscale 1280->1920", tUp, "ms", down.length, up.length);
}
