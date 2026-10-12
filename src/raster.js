"use strict";
/*
 * Pixel helpers with no Photoshop dependencies: resizing, letterboxing,
 * frame comparison and the work-time badge. Every buffer is tightly packed
 * 8-bit RGB (3 bytes per pixel, rows top to bottom).
 */

/* ---------------- resizing ---------------- */

// Filter taps for resizing srcLen -> dstLen samples: a triangle filter whose
// radius grows when shrinking, so downscales average every source pixel
// (no shimmering) and upscales come out bilinear.
function taps(srcLen, dstLen) {
  const scale = dstLen / srcLen;
  const radius = scale < 1 ? 1 / scale : 1;
  const out = new Array(dstLen);
  for (let i = 0; i < dstLen; i++) {
    const center = (i + 0.5) / scale;
    const lo = Math.max(0, Math.floor(center - radius));
    const hi = Math.min(srcLen - 1, Math.ceil(center + radius));
    const w = [];
    let start = -1, sum = 0;
    for (let j = lo; j <= hi; j++) {
      const d = Math.abs(j + 0.5 - center) / radius;
      if (d >= 1) { if (start >= 0) break; continue; }
      if (start < 0) start = j;
      w.push(1 - d);
      sum += 1 - d;
    }
    if (start < 0) { start = Math.min(srcLen - 1, Math.max(0, Math.floor(center))); w.push(1); sum = 1; }
    const f = new Float32Array(w.length);
    for (let k = 0; k < w.length; k++) f[k] = w[k] / sum;
    out[i] = { start, w: f };
  }
  return out;
}

function resize(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return new Uint8Array(src);
  const tx = taps(sw, dw), ty = taps(sh, dh);
  // horizontal pass -> float rows of width dw
  const tmp = new Float32Array(dw * sh * 3);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 3, trow = y * dw * 3;
    for (let x = 0; x < dw; x++) {
      const t = tx[x], w = t.w;
      let r = 0, g = 0, b = 0, p = row + t.start * 3;
      for (let k = 0; k < w.length; k++, p += 3) {
        const wt = w[k];
        r += src[p] * wt; g += src[p + 1] * wt; b += src[p + 2] * wt;
      }
      const o = trow + x * 3;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b;
    }
  }
  // vertical pass
  const stride = dw * 3;
  const out = new Uint8Array(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    const t = ty[y], w = t.w, base = t.start * stride, orow = y * stride;
    for (let x = 0; x < stride; x++) {
      let acc = 0;
      for (let k = 0, p = base + x; k < w.length; k++, p += stride) acc += tmp[p] * w[k];
      out[orow + x] = acc <= 0 ? 0 : acc >= 255 ? 255 : (acc + 0.5) | 0;
    }
  }
  return out;
}

// Fit src inside a dw x dh frame (keeping its aspect ratio) centred on a
// solid background. Used when the canvas was cropped or resized mid-recording.
function letterbox(src, sw, sh, dw, dh, bg) {
  if (sw === dw && sh === dh) return new Uint8Array(src);
  const s = Math.min(dw / sw, dh / sh);
  const tw = Math.max(1, Math.min(dw, Math.round(sw * s)));
  const th = Math.max(1, Math.min(dh, Math.round(sh * s)));
  const scaled = resize(src, sw, sh, tw, th);
  const out = new Uint8Array(dw * dh * 3);
  const row = new Uint8Array(dw * 3);
  for (let x = 0; x < dw; x++) { row[x * 3] = bg[0]; row[x * 3 + 1] = bg[1]; row[x * 3 + 2] = bg[2]; }
  for (let y = 0; y < dh; y++) out.set(row, y * dw * 3);
  const ox = (dw - tw) >> 1, oy = (dh - th) >> 1;
  for (let y = 0; y < th; y++) {
    out.set(scaled.subarray(y * tw * 3, (y + 1) * tw * 3), ((oy + y) * dw + ox) * 3);
  }
  return out;
}

// Flatten RGBA onto white (only needed if Photoshop ever hands back alpha).
function rgbaOnWhite(src, w, h) {
  const out = new Uint8Array(w * h * 3);
  for (let i = 0, o = 0; i < src.length; i += 4, o += 3) {
    const a = src[i + 3] / 255, k = 255 * (1 - a);
    out[o] = (src[i] * a + k + 0.5) | 0;
    out[o + 1] = (src[i + 1] * a + k + 0.5) | 0;
    out[o + 2] = (src[i + 2] * a + k + 0.5) | 0;
  }
  return out;
}

// Mix the frame toward white (0 = unchanged, 1 = all white).
function whiten(rgb, amount) {
  if (amount <= 0) return;
  const k = Math.min(1, amount);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (rgb[i] + (255 - rgb[i]) * k + 0.5) | 0;
}

/* ---------------- frame comparison ---------------- */

// Counts pixels where any channel differs by more than `tol`. Stops counting
// once the result passes `limit` (the caller only needs to know "more than").
function countChanged(a, b, tol, limit) {
  let n = 0;
  for (let i = 0, len = a.length; i < len; i += 3) {
    let d0 = a[i] - b[i]; if (d0 < 0) d0 = -d0;
    let d1 = a[i + 1] - b[i + 1]; if (d1 < 0) d1 = -d1;
    let d2 = a[i + 2] - b[i + 2]; if (d2 < 0) d2 = -d2;
    if (d0 > tol || d1 > tol || d2 > tol) {
      if (++n > limit) return n;
    }
  }
  return n;
}

/* ---------------- work-time badge ---------------- */
// A small single-stroke vector font (digits, "h", "m", ":") plus a clock
// icon, rasterised with anti-aliasing so the overlay needs no font files.
// Glyphs live in a box 1 unit tall (y grows downward).

function arc(cx, cy, rx, ry, a0, a1, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = (a0 + (a1 - a0) * i / steps) * Math.PI / 180;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

const DIGIT_ADV = 0.66;   // every digit gets the same width so the counter doesn't jiggle
const GLYPHS = {};
function glyph(ch, adv, lines) {
  let minX = Infinity, maxX = -Infinity;
  for (const line of lines) for (const p of line) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; }
  const shift = lines.length ? (adv - (maxX - minX)) / 2 - minX : 0;   // centre the ink in its advance
  GLYPHS[ch] = { adv, lines, shift };
}
glyph("0", DIGIT_ADV, [arc(0.28, 0.28, 0.26, 0.26, 180, 360, 12).concat(arc(0.28, 0.72, 0.26, 0.26, 0, 180, 12), [[0.02, 0.28]])]);
glyph("1", DIGIT_ADV, [[[0.12, 0.2], [0.33, 0.02], [0.33, 0.98]]]);
glyph("2", DIGIT_ADV, [arc(0.28, 0.28, 0.25, 0.26, 200, 375, 14).concat([[0.03, 0.98], [0.55, 0.98]])]);
glyph("3", DIGIT_ADV, [arc(0.27, 0.26, 0.24, 0.24, 200, 450, 16), arc(0.27, 0.735, 0.27, 0.245, 270, 520, 16)]);
glyph("4", DIGIT_ADV, [[[0.42, 0.98], [0.42, 0.02], [0.02, 0.68], [0.56, 0.68]]]);
glyph("5", DIGIT_ADV, [[[0.52, 0.02], [0.1, 0.02], [0.075, 0.5]].concat(arc(0.29, 0.7, 0.26, 0.28, 215, 520, 18))]);
glyph("6", DIGIT_ADV, [[[0.47, 0.02], [0.09, 0.56]], arc(0.29, 0.72, 0.26, 0.26, 0, 360, 24)]);
glyph("7", DIGIT_ADV, [[[0.03, 0.02], [0.55, 0.02], [0.2, 0.98]]]);
glyph("8", DIGIT_ADV, [arc(0.28, 0.265, 0.22, 0.235, 0, 360, 20), arc(0.28, 0.73, 0.26, 0.25, 0, 360, 22)]);
glyph("9", DIGIT_ADV, [arc(0.27, 0.28, 0.26, 0.26, 0, 360, 24), [[0.47, 0.44], [0.09, 0.98]]]);
glyph(":", 0.3, [[[0.1, 0.34], [0.1, 0.34]], [[0.1, 0.8], [0.1, 0.8]]]);
glyph("h", 0.62, [[[0.05, 0], [0.05, 0.98]], arc(0.27, 0.62, 0.22, 0.22, 180, 360, 12).concat([[0.49, 0.98]])]);
glyph("m", 0.8, [[[0.05, 0.4], [0.05, 0.98]],
  arc(0.2, 0.58, 0.15, 0.17, 180, 360, 10).concat([[0.35, 0.98]]),
  arc(0.5, 0.58, 0.15, 0.17, 180, 360, 10).concat([[0.65, 0.98]])]);
glyph(" ", 0.32, []);

const CLOCK = [arc(0.5, 0.5, 0.44, 0.44, 0, 360, 32), [[0.5, 0.22], [0.5, 0.5], [0.7, 0.62]]];

function pushSegments(out, lines, ox, oy, scale) {
  for (let line of lines) {
    if (line.length === 1) line = [line[0], line[0]];
    for (let i = 0; i + 1 < line.length; i++) {
      out.push([ox + line[i][0] * scale, oy + line[i][1] * scale, ox + line[i + 1][0] * scale, oy + line[i + 1][1] * scale]);
    }
  }
}

// Paint round-capped strokes into a coverage map (0..1), keeping the max so
// overlapping strokes don't double up.
function strokeSegments(cov, W, H, segs, half) {
  for (const s of segs) {
    const x1 = s[0], y1 = s[1], x2 = s[2], y2 = s[3];
    const minX = Math.max(0, Math.floor(Math.min(x1, x2) - half - 1));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(x1, x2) + half + 1));
    const minY = Math.max(0, Math.floor(Math.min(y1, y2) - half - 1));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(y1, y2) + half + 1));
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - (x1 + t * dx), ey = py - (y1 + t * dy);
        const c = half + 0.5 - Math.sqrt(ex * ex + ey * ey);
        if (c > 0) {
          const i = y * W + x, v = c > 1 ? 1 : c;
          if (v > cov[i]) cov[i] = v;
        }
      }
    }
  }
}

// "2h 05m" / "45m"
function formatWorkLabel(ms) {
  const totalMin = Math.floor(Math.max(0, ms) / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h > 0 ? h + "h " + (m < 10 ? "0" : "") + m + "m" : m + "m";
}

const BADGE_BG_ALPHA = 0.55;

// Build a badge sprite (pill background + clock icon + label) sized for a
// frame `frameH` pixels tall.
function makeBadge(label, frameH) {
  const cap = Math.max(12, Math.min(110, Math.round(frameH * 0.03)));
  const half = cap * 0.07;              // stroke half-width
  const icon = cap * 1.1;
  const gap = cap * 0.42;
  let textW = 0;
  for (const ch of label) textW += (GLYPHS[ch] || GLYPHS[" "]).adv;
  const padX = Math.round(cap * 0.6), padY = Math.round(cap * 0.5);
  const W = Math.ceil(icon + gap + textW * cap + 2 * padX);
  const H = Math.ceil(cap + 2 * padY);

  const segs = [];
  pushSegments(segs, CLOCK, padX, padY + (cap - icon) / 2, icon);
  const iconSegs = segs.length;
  let x = padX + icon + gap;
  for (const ch of label) {
    const g = GLYPHS[ch] || GLYPHS[" "];
    pushSegments(segs, g.lines, x + g.shift * cap, padY, cap);
    x += g.adv * cap;
  }
  const fg = new Float32Array(W * H);
  strokeSegments(fg, W, H, segs.slice(0, iconSegs), half * 0.85);
  strokeSegments(fg, W, H, segs.slice(iconSegs), half);

  // capsule-shaped background with a soft 1px edge
  const bg = new Float32Array(W * H);
  const r = H / 2, ax = r, bx = W - r;
  for (let y = 0; y < H; y++) {
    const dy = y + 0.5 - r;
    for (let xx = 0; xx < W; xx++) {
      const px = xx + 0.5;
      const cx = px < ax ? ax : px > bx ? bx : px;
      const d = Math.sqrt((px - cx) * (px - cx) + dy * dy) - r;
      const a = 0.5 - d;
      bg[y * W + xx] = a <= 0 ? 0 : a >= 1 ? 1 : a;
    }
  }
  return { W, H, fg, bg };
}

// corner: "br" | "bl" | "tr" | "tl"
function drawBadge(rgb, fw, fh, badge, corner) {
  const m = Math.round(Math.min(fw, fh) * 0.035);
  const x0 = corner[1] === "l" ? m : fw - m - badge.W;
  const y0 = corner[0] === "t" ? m : fh - m - badge.H;
  for (let y = 0; y < badge.H; y++) {
    const fy = y0 + y;
    if (fy < 0 || fy >= fh) continue;
    for (let x = 0; x < badge.W; x++) {
      const fx = x0 + x;
      if (fx < 0 || fx >= fw) continue;
      const i = y * badge.W + x;
      const a = badge.bg[i] * BADGE_BG_ALPHA, t = badge.fg[i];
      if (a === 0 && t === 0) continue;
      const p = (fy * fw + fx) * 3;
      for (let c = 0; c < 3; c++) {
        const v = rgb[p + c] * (1 - a);
        rgb[p + c] = (v * (1 - t) + 255 * t + 0.5) | 0;
      }
    }
  }
}

module.exports = { resize, letterbox, whiten, rgbaOnWhite, countChanged, formatWorkLabel, makeBadge, drawBadge };
