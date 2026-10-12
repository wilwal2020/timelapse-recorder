"use strict";
/*
 * Base64 <-> bytes. Photoshop's JPEG encoder hands frames back as base64
 * (handy for the panel preview); these turn them into bytes for disk and back.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Uint8Array(256).fill(255);
for (let i = 0; i < 64; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;
LOOKUP[45] = 62; // "-" (url-safe variant)
LOOKUP[95] = 63; // "_"

function decode(str) {
  const out = new Uint8Array(Math.floor(str.length * 3 / 4) + 3);
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < str.length; i++) {
    const v = LOOKUP[str.charCodeAt(i)];
    if (v === 255) continue;           // padding, whitespace, data-URI junk
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

function encode(bytes) {
  const parts = [];
  const CHUNK = 3 * 4096;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(bytes.length, start + CHUNK);
    let s = "";
    for (let i = start; i < end; i += 3) {
      const b0 = bytes[i], b1 = i + 1 < end ? bytes[i + 1] : 0, b2 = i + 2 < end ? bytes[i + 2] : 0;
      const n = (b0 << 16) | (b1 << 8) | b2;
      s += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] +
           (i + 1 < end ? ALPHABET[(n >> 6) & 63] : "=") +
           (i + 2 < end ? ALPHABET[n & 63] : "=");
    }
    parts.push(s);
  }
  return parts.join("");
}

module.exports = { decode, encode };
