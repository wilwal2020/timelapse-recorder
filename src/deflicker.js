"use strict";
/*
 * Finds flicker frames: a frame (or a burst of 2-3) that differs from the
 * frames on both sides while those two match each other, e.g. a layer that
 * was briefly hidden, a stroke that was undone right away, a temporary fill.
 * Ported from TimeSplice's "Remove flicker frames", at sensitivity 200.
 *
 * Works on 32x32 greyscale thumbnails (1024 bytes each) that ffmpeg makes
 * from the recorded frames; they're kept in THUMBS_FILE in the recording
 * folder so each frame is only looked at once.
 */

const THUMB = 32 * 32;
const THUMBS_FILE = "thumbs32.bin";   // records of [frame number: uint32 LE][1024 grey bytes]
const RECORD = 4 + THUMB;
const SENSITIVITY = 200;

// Average per-pixel difference of two thumbnails.
function dist(a, b) {
  let sum = 0;
  for (let k = 0; k < THUMB; k++) sum += Math.abs(a[k] - b[k]);
  return sum / THUMB;
}

/**
 * @param thumbs  one thumbnail per frame, in video order (null when unknown)
 * @returns       sorted indexes of the frames to leave out; the first and
 *                last frame are never among them
 */
function findFlicker(thumbs, sensitivity) {
  const s = sensitivity === undefined ? SENSITIVITY : sensitivity;
  // the same thresholds as TimeSplice: T is an absolute floor, R a ratio
  const T = Math.max(0, 30 - s * 0.295);
  const R = Math.max(0.7, 4 - s * 0.029);
  const n = thumbs.length;
  const d = (i, j) => dist(thumbs[i], thumbs[j]);
  const known = (from, to) => { for (let i = from; i <= to; i++) if (!thumbs[i]) return false; return true; };
  const out = new Set();
  if (n < 3) return [];
  // 1-frame flickers
  for (let i = 1; i < n - 1; i++) {
    if (!known(i - 1, i + 1)) continue;
    const dPrev = d(i - 1, i), dNext = d(i, i + 1), dCtx = d(i - 1, i + 1);
    if (dPrev > T && dNext > T && dPrev > R * dCtx && dNext > R * dCtx) out.add(i);
  }
  // 2-frame bursts: i and i+1 match each other but not i-1 / i+2, which match
  for (let i = 1; i < n - 2; i++) {
    if (out.has(i) || out.has(i + 1) || !known(i - 1, i + 2)) continue;
    const dIn = d(i - 1, i), dOut = d(i + 1, i + 2), dRest = d(i - 1, i + 2), dBurst = d(i, i + 1);
    if (dIn > T && dOut > T && dIn > R * dRest && dOut > R * dRest && dBurst < dIn * 0.5) { out.add(i); out.add(i + 1); }
  }
  // 3-frame bursts
  for (let i = 1; i < n - 3; i++) {
    if (out.has(i) || out.has(i + 1) || out.has(i + 2) || !known(i - 1, i + 3)) continue;
    const dIn = d(i - 1, i), dOut = d(i + 2, i + 3), dRest = d(i - 1, i + 3);
    const dB1 = d(i, i + 1), dB2 = d(i + 1, i + 2);
    if (dIn > T && dOut > T && dIn > R * dRest && dOut > R * dRest && dB1 < dIn * 0.5 && dB2 < dIn * 0.5) {
      out.add(i); out.add(i + 1); out.add(i + 2);
    }
  }
  const list = Array.from(out).sort((a, b) => a - b);
  return list.length > n * 0.9 ? [] : list;        // something's off: better to remove nothing
}

// thumbs file bytes -> Map(frame number -> Uint8Array(1024))
function parseThumbs(bytes) {
  const map = new Map();
  if (!bytes) return map;
  for (let off = 0; off + RECORD <= bytes.length; off += RECORD) {
    const n = bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] * 16777216);
    map.set(n, bytes.subarray(off + 4, off + RECORD));
  }
  return map;
}

// Map(frame number -> thumbnail) -> thumbs file bytes
function serializeThumbs(map) {
  const out = new Uint8Array(map.size * RECORD);
  let off = 0;
  for (const [n, t] of map) {
    out[off] = n & 255; out[off + 1] = (n >>> 8) & 255; out[off + 2] = (n >>> 16) & 255; out[off + 3] = (n >>> 24) & 255;
    out.set(t.subarray(0, THUMB), off + 4);
    off += RECORD;
  }
  return out;
}

module.exports = { findFlicker, parseThumbs, serializeThumbs, THUMB, THUMBS_FILE, SENSITIVITY };
