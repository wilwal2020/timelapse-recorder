"use strict";
/* Panel settings, persisted in the plugin's localStorage. */

const KEY = "timelapseRecorder.settings.v2";

// Frame quality: longest side of a saved frame (never larger than the canvas).
const QUALITY = { low: 1280, default: 1920, high: 2880 };
const FPS = 30;

const DEFAULTS = {
  // where recordings live
  rootToken: "",
  rootPath: "",

  // recording
  quality: "default",
  hideUndone: true,         // undo removes the undone frames from the timelapse
  excludeTag: "[ref]",      // layers whose name contains this are hidden in frames
  idleSec: 30,              // work timer stops after this many seconds without activity
  showPreview: false,
  autoRecord: false,        // record whatever document is active

  // export
  rememberToken: "",        // export folder the user chose to remember
  rememberPath: "",
  useRemembered: false,     // save exports there without asking
  encoder: "ffmpeg",        // "ffmpeg" (fast, bundled) | "photoshop"
  ffmpegPath: "",           // empty = use ffmpeg from PATH
  lengthSec: "auto",        // "auto" or seconds
  introOn: false,
  introSec: 1,
  flashOn: false,
  holdOn: false,
  holdSec: 3,
  slowEnd: false,
  deflicker: false,         // leave out frames that flash in and out
  timerOverlay: false,
  timerCorner: "br",
  letterbox: "black"
};

let current = load();

function load() {
  let saved = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) saved = JSON.parse(raw) || {};
    else {
      // carry over what still applies from v1.0.0
      const old = JSON.parse(localStorage.getItem("timelapseRecorder.settings.v1") || "null");
      if (old) for (const k of ["rootToken", "rootPath", "hideUndone", "excludeTag", "encoder", "ffmpegPath"]) if (k in old) saved[k] = old[k];
    }
  } catch (e) { /* first run or storage unavailable */ }
  // 1.4.0 bundles ffmpeg, so it becomes the default once for everyone
  if (!saved.ffmpegDefaulted) { saved.encoder = "ffmpeg"; saved.ffmpegDefaulted = true; }
  return Object.assign({}, DEFAULTS, saved);
}

function get() { return current; }

function set(key, value) {
  current[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch (e) { /* not persisted */ }
}

function maxLong() { return QUALITY[current.quality] || QUALITY.default; }

module.exports = { get, set, maxLong, DEFAULTS, QUALITY, FPS };
