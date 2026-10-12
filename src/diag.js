"use strict";
/*
 * Diagnostic log: what the recorder asks of Photoshop while recording, and how
 * long each step takes. Kept in LOG_FILE in the recordings folder (the last
 * MAX_LINES lines of this Photoshop session), written a few seconds after the
 * last entry so logging itself doesn't get in the way.
 */

const store = require("./store.js");

const LOG_FILE = "timelapse-log.txt";
const MAX_LINES = 600;
const lines = [];
let timer = null;

function stamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function log(msg) {
  lines.push(stamp() + "  " + msg);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  if (!timer) timer = setTimeout(flush, 4000);
}

async function flush() {
  timer = null;
  try { await store.writeRootText(LOG_FILE, lines.join("\r\n") + "\r\n"); } catch (e) { /* the log is optional */ }
}

// Times an async step: returns its result, adds "name 123ms" to `parts`.
async function timed(parts, name, fn) {
  const t0 = Date.now();
  try { return await fn(); } finally { parts.push(name + " " + (Date.now() - t0) + "ms"); }
}

module.exports = { log, timed, flush, LOG_FILE };
