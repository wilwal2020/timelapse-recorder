"use strict";
/*
 * Turns a recording into an MP4:
 *   0. optionally leave out flicker frames (see deflicker.js)
 *   1. plan which recorded frame appears in each video frame
 *      (length, intro, final flash, hold, slow-down)
 *   2. write that sequence to <recording>/_render/, fitting frames whose canvas
 *      size differs and drawing the work-time badge / flash when needed
 *      (otherwise frames are copied byte for byte, which is fast)
 *   3. encode: Photoshop's own Render Video, or a make_video.bat that runs ffmpeg
 * The video ends up in the file the user picked.
 */

const { core, imaging } = require("photoshop");
const { storage, shell } = require("uxp");
const { localFileSystem: lfs, formats } = storage;
const settings = require("./settings.js");
const store = require("./store.js");
const raster = require("./raster.js");
const plan = require("./plan.js");
const ps = require("./psutil.js");
const decodeJpeg = require("./jpeg-decoder.js");
const deflicker = require("./deflicker.js");
const launcher = require("./launcher.js");

const PROFILE = "sRGB IEC61966-2.1";
const RENDER_DIR = "_render";
const TEMP_VIDEO = "_render_video.mp4";
const FLICKER_DIR = "_flicker";
const BG = { black: [0, 0, 0], white: [255, 255, 255], gray: [45, 45, 45] };

class Cancelled extends Error {
  constructor() { super("Export cancelled"); this.cancelled = true; }
}

function isWindows() {
  try { return require("os").platform() === "win32"; } catch (e) { /* fall through */ }
  try { return /win/i.test(navigator.platform); } catch (e) { return true; }
}

function even(v) { return Math.max(2, Math.floor(v / 2) * 2); }
function pad6(n) { return String(n).padStart(6, "0"); }
function yieldUI() { return new Promise((r) => setTimeout(r, 0)); }
function dirOf(p) { return String(p).replace(/[\\/][^\\/]*$/, ""); }

function options(st) {
  return {
    fps: settings.FPS,
    lengthSec: st.lengthSec === "auto" ? "auto" : Number(st.lengthSec) || 30,
    introSec: st.introOn ? Number(st.introSec) || 1 : 0,
    flash: !!st.flashOn,
    holdSec: st.holdOn ? Number(st.holdSec) || 3 : 0,
    slowEnd: !!st.slowEnd,
    timer: !!st.timerOverlay,
    corner: st.timerCorner || "br",
    bg: BG[st.letterbox] || BG.black,
    hideUndone: !!st.hideUndone,
    deflicker: !!st.deflicker,
    encoder: st.encoder === "ffmpeg" ? "ffmpeg" : "photoshop",
    ffmpegPath: st.ffmpegPath || ""
  };
}

function usableFrames(rec, hideUndone) {
  return rec.meta.frames.filter((f) => !(hideUndone && f.u));
}

// Numbers for the panel, without touching the disk.
function estimate(rec, st) {
  const o = options(st);
  const frames = usableFrames(rec, o.hideUndone);
  if (!frames.length) return null;
  const p = plan.planExport(frames.length, o);
  const last = frames[frames.length - 1];
  return {
    seconds: p.seconds, total: p.total, sourceFrames: frames.length,
    uncheckedFrames: o.deflicker ? uncheckedFrames(rec, frames) : 0,
    width: even(last.x), height: even(last.y),
    resized: frames.some((f) => f.x !== last.x || f.y !== last.y)
  };
}

/* ---------------- time estimates ---------------- */
// Photoshop's Render Video can't report progress, so the bar runs on an
// estimate that learns from your previous exports (time ~ a + b * frames).

const COPY_MS = 8;          // copying a frame that needs no changes
const REDRAW_MS = 300;      // decoding, redrawing and re-encoding one
const THUMB_MS = 7;         // ffmpeg making a flicker-check thumbnail (once per frame, then cached)

// Frames the flicker check hasn't seen yet (their thumbnails aren't cached).
function uncheckedFrames(rec, frames) {
  const upTo = rec.meta.thumbsUpTo || 0;
  return frames.filter((f) => f.n > upTo).length;
}

function flickerEstimateMs(rec, frames, o) {
  if (!o.deflicker) return 0;
  const n = uncheckedFrames(rec, frames);
  return 200 + (n ? 1500 + n * THUMB_MS : 0);
}

function statsKey(encoder) { return encoder === "ffmpeg" ? "ffRenderStats" : "psRenderStats"; }

function renderEstimateMs(frames, encoder) {
  const hist = (settings.get()[statsKey(encoder)] || []).filter((h) => h.frames > 0 && h.ms > 0);
  let a = encoder === "ffmpeg" ? 1500 : 4000, b = encoder === "ffmpeg" ? 12 : 60;   // first-time guess
  if (hist.length) {
    const n = hist.length;
    const mx = hist.reduce((s, h) => s + h.frames, 0) / n, my = hist.reduce((s, h) => s + h.ms, 0) / n;
    const sxx = hist.reduce((s, h) => s + (h.frames - mx) * (h.frames - mx), 0);
    if (sxx > 0) {
      b = hist.reduce((s, h) => s + (h.frames - mx) * (h.ms - my), 0) / sxx;
      a = my - b * mx;
    }
    if (!(sxx > 0) || b < 5 || a < 0) {                     // not enough spread to fit: keep the guessed overhead
      a = Math.min(a, my * 0.6);
      b = Math.max(5, (my - a) / mx);
    }
  }
  return Math.max(encoder === "ffmpeg" ? 800 : 1500, a + b * frames);
}

function learnRender(frames, ms, encoder) {
  const hist = (settings.get()[statsKey(encoder)] || []).slice(-5);
  hist.push({ frames, ms: Math.round(ms) });
  settings.set(statsKey(encoder), hist);
}

// Which output frames need redrawing (vs. a plain copy), without touching the disk.
// A frame can go to the encoder untouched unless it needs drawing on (timer,
// flash). A different canvas size alone is fine with ffmpeg, which scales and
// letterboxes while it encodes (far faster than redrawing in the plugin).
function passThrough(f, label, white, o, W, H) {
  return !label && !white && (o.encoder === "ffmpeg" || (f.x === W && f.y === H));
}

function prepareEstimateMs(frames, p, o, W, H) {
  let ms = 0, prevKey = null;
  for (let k = 0; k < p.total; k++) {
    const at = p.at(k), f = frames[at.src];
    const label = o.timer && at.part !== "intro" ? (at.part === "main" ? raster.formatWorkLabel(f.w) : "final") : "";
    const key = f.n + "|" + label + "|" + at.white;
    if (key !== prevKey) ms += passThrough(f, label, at.white, o, W, H) ? COPY_MS : REDRAW_MS;
    else ms += 2;
    prevKey = key;
  }
  return ms;
}

// Rough total export time for the panel.
function exportTimeEstimate(rec, st) {
  const o = options(st);
  const frames = usableFrames(rec, o.hideUndone);
  if (!frames.length) return 0;
  const last = frames[frames.length - 1];
  const p = plan.planExport(frames.length, o);
  const prep = prepareEstimateMs(frames, p, o, even(last.x), even(last.y));
  return flickerEstimateMs(rec, frames, o) + prep + renderEstimateMs(p.total, o.encoder);
}

function secs(ms) { return ms < 10000 ? (ms / 1000).toFixed(1) + " s" : Math.round(ms / 1000) + " s"; }

async function encodeJpeg(rgb, w, h) {
  const make = () => imaging.createImageDataFromBuffer(rgb, { width: w, height: h, components: 3, colorSpace: "RGB", colorProfile: PROFILE, chunky: true });
  const enc = (imageData) => imaging.encodeImageData({ imageData, base64: false });
  const toBytes = (out) => (out instanceof Uint8Array ? out : Uint8Array.from(out));
  let imageData;
  try {
    imageData = await make();
    return toBytes(await enc(imageData));
  } catch (e) {
    if (!/modal/i.test(String((e && e.message) || e))) throw e;
    return core.executeAsModal(async () => {
      const id2 = await make();
      try { return toBytes(await enc(id2)); } finally { id2.dispose(); }
    }, { commandName: "Preparing timelapse frames" });
  } finally {
    if (imageData) { try { imageData.dispose(); } catch (e) { /* released */ } }
  }
}

function recordExport(rec, path, mode) {
  if (!Array.isArray(rec.meta.exports)) rec.meta.exports = [];
  rec.meta.exports.push({ t: Date.now(), path, mode, frames: rec.meta.frames.length });
  return store.saveNow(rec);
}

/**
 * @param rec     recording handle from store
 * @param st      settings object
 * @param target  File entry the video should be saved as (from a save dialog)
 * @param ui      { progress(fraction, text), cancelled() }
 * @returns       { mode, file, folderPath, message }
 */
async function run(rec, st, target, ui) {
  const o = options(st);
  await store.saveNow(rec);
  ui.progress(0, "Reading frames…");
  const files = await store.frameFiles(rec);
  let frames = usableFrames(rec, o.hideUndone).filter((f) => files.has(store.frameName(f.n)));
  if (!frames.length) throw new Error("This recording doesn't have any frames yet.");
  const t0 = Date.now();

  // leave out flicker frames; the rest of the bar is scaled into what's left after this step
  const parts = [];      // timing breakdown for the result message
  let warning = "";
  if (o.deflicker) {
    const fShare = flickerShare(rec, frames, o);
    const outer = ui;
    outer.progress(0, "Checking for flicker…");
    try {
      const drop = await findFlickerFrames(rec, frames, files, o, outer,
        (f) => outer.progress(f * fShare, "Checking for flicker… " + Math.round(f * 100) + "%"));
      if (drop.size) frames = frames.filter((f, i) => !drop.has(i));
      parts.push("flicker check " + secs(Date.now() - t0) + " (" + (drop.size === 1 ? "1 frame" : drop.size + " frames") + " left out)");
    } catch (e) {
      if (e && e.cancelled) throw e;
      console.warn("Timelapse: flicker check failed", e);
      warning = " The flicker check didn't work (" + ((e && e.message) || e) + "), so every frame is in the video.";
    }
    ui = { progress: (f, t) => outer.progress(fShare + (1 - fShare) * f, t), cancelled: outer.cancelled };
  }
  const tPrep = Date.now();

  const last = frames[frames.length - 1];
  const W = even(last.x), H = even(last.y);
  const p = plan.planExport(frames.length, o);

  // share of the bar for preparing frames vs. encoding, by expected time
  const prepEst = prepareEstimateMs(frames, p, o, W, H);
  const renderEst = renderEstimateMs(p.total, o.encoder);
  const prepShare = Math.min(0.9, Math.max(0.03, prepEst / (prepEst + renderEst)));

  const renderDir = await store.freshFolder(rec.folder, RENDER_DIR);
  try {
    await writeSequence(renderDir, frames, files, p, o, W, H, ui, prepShare);
  } catch (e) {
    try { await store.removeTree(renderDir); } catch (e2) { /* leave it */ }
    throw e;
  }

  const prepMs = Date.now() - tPrep;
  parts.push("preparing frames " + secs(prepMs));
  const saved = () => "Saved " + target.name + " (" + Math.round(p.seconds) + " s video) in " + secs(Date.now() - t0) + ": ";
  if (o.encoder === "ffmpeg") {
    ui.progress(prepShare, "Making the video with ffmpeg…");
    const encMs = await encodeWithFfmpeg(rec, renderDir, target.nativePath, p.total, o, W, H,
      (f) => ui.progress(prepShare + (1 - prepShare) * f * 0.98, "Making the video with ffmpeg… " + Math.round(f * 100) + "%"));
    learnRender(p.total, encMs, "ffmpeg");
    try { await store.removeTree(renderDir); } catch (e) { /* temp frames can be deleted by hand */ }
    await cleanupFfmpeg(rec);
    await recordExport(rec, target.nativePath, "ffmpeg");
    ui.progress(1, "Done");
    return {
      mode: "ffmpeg",
      file: target.nativePath,
      folderPath: dirOf(target.nativePath),
      message: saved() + parts.concat("ffmpeg " + secs(encMs)).join(", ") + "." + warning
    };
  }

  const tRender = Date.now();
  const renderText = () => {
    const left = Math.max(1, Math.round((renderEst - (Date.now() - tRender)) / 1000));
    return "Photoshop is rendering the video… about " + left + " s left" +
      (Date.now() - tRender > renderEst ? " (taking longer than usual)" : "");
  };
  ui.progress(prepShare, renderText());
  await new Promise((r) => setTimeout(r, 120));           // let the panel repaint before Photoshop gets busy
  // Photoshop may block the panel while it renders; when it doesn't, the bar keeps moving
  const ticker = setInterval(() => {
    const f = Math.min(0.97, (Date.now() - tRender) / renderEst);
    ui.progress(prepShare + (1 - prepShare) * f, renderText());
  }, 250);
  let times;
  try {
    times = await renderInPhotoshop(renderDir, rec.folder, TEMP_VIDEO, o.fps);
  } catch (e) {
    clearInterval(ticker);
    const err = new Error(
      "Photoshop couldn't render the video (" + ((e && e.message) || e) + "). The frames are ready in “" +
      RENDER_DIR + "” inside the recording folder: open the first one with File › Open and tick " +
      "“Image Sequence”, then use File › Export › Render Video. Or switch “Make video with” to ffmpeg (fast).");
    err.folderPath = rec.folder.nativePath;
    throw err;
  }
  clearInterval(ticker);
  learnRender(p.total, times.openMs + times.renderMs, "photoshop");

  // move the video to where the user asked for it
  ui.progress(0.97, "Saving video…");
  const tmp = await store.tryGet(rec.folder, TEMP_VIDEO);
  await target.write(await tmp.read({ format: formats.binary }), { format: formats.binary });
  try { await tmp.delete(); } catch (e) { /* leftover temp file */ }
  try { await store.removeTree(renderDir); } catch (e) { /* temp frames can be deleted by hand */ }
  await recordExport(rec, target.nativePath, "photoshop");
  ui.progress(1, "Done");
  return {
    mode: "photoshop",
    file: target.nativePath,
    folderPath: dirOf(target.nativePath),
    message: saved() + parts.concat("Photoshop opening " + secs(times.openMs), "rendering " + secs(times.renderMs)).join(", ") + "." + warning
  };
}

/* ---------------- flicker check ---------------- */

// Share of the progress bar for the flicker check, by expected time.
function flickerShare(rec, frames, o) {
  const fEst = flickerEstimateMs(rec, frames, o);
  const last = frames[frames.length - 1];
  const p = plan.planExport(frames.length, o);
  const rest = prepareEstimateMs(frames, p, o, even(last.x), even(last.y)) + renderEstimateMs(p.total, o.encoder);
  return Math.min(0.8, fEst / (fEst + rest));
}

// Indexes (into `frames`) of the flicker frames to leave out. Thumbnails
// come from the cache in the recording folder; ffmpeg makes the missing ones.
async function findFlickerFrames(rec, frames, files, o, ui, onProgress) {
  const cacheFile = await store.tryGet(rec.folder, deflicker.THUMBS_FILE);
  const cache = deflicker.parseThumbs(cacheFile ? await store.readBytes(cacheFile) : null);
  const missing = frames.filter((f) => !cache.has(f.n));
  if (missing.length) {
    if (!isWindows()) throw new Error("it needs Windows for now");
    const dir = await store.freshFolder(rec.folder, FLICKER_DIR);
    try {
      // paths in the list are relative to the list file
      await store.writeText(dir, "list.txt", "ffconcat version 1.0\n" +
        missing.map((f) => "file '../frames/" + store.frameName(f.n) + "'").join("\n") + "\n");
      const ff = await findFfmpeg(o);
      await runFfmpegJob(rec, dir, FLICKER_DIR, "check_flicker", jobBat(ff.path, FLICKER_DIR, thumbArgs("\\")),
        missing.length, onProgress, ff, "checking for flicker");
      const rawFile = await store.tryGet(dir, "thumbs.raw");
      const raw = rawFile ? await store.readBytes(rawFile) : new Uint8Array(0);
      const got = Math.floor(raw.length / deflicker.THUMB);
      if (got !== missing.length) throw new Error("ffmpeg read " + got + " of " + missing.length + " frames");
      missing.forEach((f, i) => cache.set(f.n, raw.slice(i * deflicker.THUMB, (i + 1) * deflicker.THUMB)));
      for (const n of Array.from(cache.keys())) if (!files.has(store.frameName(n))) cache.delete(n);   // deleted frames
      await store.writeBytes(rec.folder, deflicker.THUMBS_FILE, deflicker.serializeThumbs(cache));
      rec.meta.thumbsUpTo = Math.max(rec.meta.thumbsUpTo || 0, ...missing.map((f) => f.n));
      store.saveSoon(rec);
    } finally {
      try { await store.removeTree(dir); } catch (e) { /* temp files can be deleted by hand */ }
      await cleanupScripts(rec, "check_flicker");
    }
  }
  if (ui.cancelled()) throw new Cancelled();
  onProgress(1);
  return new Set(deflicker.findFlicker(frames.map((f) => cache.get(f.n) || null)));
}

// 32x32 greyscale thumbnail of every listed frame, as raw bytes. -lowres 3 lets
// the JPEG decoder work at 1/8 size, which is much faster and plenty for this.
function thumbArgs(sep) {
  return '-lowres 3 -f concat -safe 0 -i "' + FLICKER_DIR + sep + 'list.txt"' +
    ' -vf "scale=32:32:flags=area,format=gray" -fps_mode passthrough -f rawvideo "' + FLICKER_DIR + sep + 'thumbs.raw"';
}

async function writeSequence(renderDir, frames, files, p, o, W, H, ui, share) {
  const last = frames[frames.length - 1];
  const finalLabel = o.timer ? raster.formatWorkLabel(last.w) : null;
  let prevKey = null, prevBytes = null;
  let decoded = { n: -1, img: null };
  let badge = { label: null, sprite: null };

  for (let k = 0; k < p.total; k++) {
    if (ui.cancelled()) throw new Cancelled();
    const at = p.at(k);
    const f = frames[at.src];
    const label = o.timer && at.part !== "intro" ? (at.part === "main" ? raster.formatWorkLabel(f.w) : finalLabel) : null;
    const key = f.n + "|" + (label || "") + "|" + at.white;
    let bytes;
    if (key === prevKey) {
      bytes = prevBytes;                                   // repeated frame (hold, intro, slow-down)
    } else {
      const file = files.get(store.frameName(f.n));
      if (passThrough(f, label, at.white, o, W, H)) {
        bytes = await store.readBytes(file);               // nothing to change: copy as is
      } else {
        if (decoded.n !== f.n) {
          decoded = { n: f.n, img: decodeJpeg(await store.readBytes(file), { useTArray: true, formatAsRGBA: false }) };
        }
        const img = decoded.img;
        const rgb = raster.letterbox(img.data, img.width, img.height, W, H, o.bg);
        if (label) {
          if (badge.label !== label) badge = { label, sprite: raster.makeBadge(label, H) };
          raster.drawBadge(rgb, W, H, badge.sprite, o.corner);
        }
        raster.whiten(rgb, at.white);
        bytes = await encodeJpeg(rgb, W, H);
      }
      prevKey = key;
      prevBytes = bytes;
    }
    await store.writeBytes(renderDir, "frame_" + pad6(k + 1) + ".jpg", bytes);
    if (k % 3 === 0 || k === p.total - 1) {
      ui.progress((k + 1) / p.total * share, "Preparing frames… " + (k + 1) + " / " + p.total);
      await yieldUI();
    }
  }
}

async function renderInPhotoshop(renderDir, outFolder, outName, fps) {
  const old = await store.tryGet(outFolder, outName);
  if (old) await old.delete();
  const first = await renderDir.getEntry("frame_000001.jpg");
  const seqToken = lfs.createSessionToken(first);
  const dirToken = lfs.createSessionToken(outFolder);
  const times = { openMs: 0, renderMs: 0 };
  await core.executeAsModal(async () => {
    const before = new Set(ps.openDocs().map((d) => d.id));
    let t = Date.now();
    // File › Open with "Image Sequence" ticked
    await ps.bp([{
      _obj: "open",
      null: { _path: seqToken, _kind: "local" },
      sequence: true,
      frameRate: fps,
      _options: { dialogOptions: "dontDisplay" }
    }]);
    const seqDoc = ps.openDocs().find((d) => !before.has(d.id));
    if (!seqDoc) throw new Error("the frame sequence didn't open");
    times.openMs = Date.now() - t;
    t = Date.now();
    try {
      // File › Export › Render Video (H.264, document size and frame rate)
      await ps.bp([{
        _obj: "export",
        using: {
          _obj: "videoExport",
          directory: { _path: dirToken, _kind: "local" },
          name: outName,
          ameFormatName: "H.264",
          amePresetName: "1_High Quality.epr",
          useDocumentSize: true,
          useDocumentFrameRate: true,
          pixelAspectRatio: { _enum: "pixelAspectRatio", _value: "document" },
          fieldOrder: { _enum: "videoField", _value: "preset" },
          manage: true,
          allFrames: true,
          renderAlpha: { _enum: "alphaRendering", _value: "none" },
          quality: 1,
          Z3DPrefHighQualityErrorThreshold: 5
        },
        _options: { dialogOptions: "dontDisplay" }
      }]);
      times.renderMs = Date.now() - t;
    } finally {
      try { await seqDoc.closeWithoutSaving(); } catch (e) { /* already closed */ }
    }
  }, { commandName: "Rendering timelapse video", timeOut: 10000 });
  if (!(await store.tryGet(outFolder, outName))) throw new Error("no video file was written");
  return times;
}

/* ---------------- ffmpeg ---------------- */
// UXP can't start programs directly, so the plugin writes a small .bat and has
// the launcher's helper script run it hidden (no console window; launcher.js);
// ffmpeg reports its progress to a file the panel reads, and the .bat writes
// ffmpeg's exit code when it's done.

const FF_PROGRESS = "progress.txt";   // inside _render
const FF_LOG = "ffmpeg_log.txt";
const FF_DONE = "done.txt";

let bundledFfmpeg;                    // cached: path of the ffmpeg.exe shipped with the plugin, or ""
async function bundledFfmpegPath() {
  if (bundledFfmpeg !== undefined) return bundledFfmpeg;
  bundledFfmpeg = "";
  try {
    const bin = await store.tryGet(await lfs.getPluginFolder(), "bin");
    const exe = bin && bin.isFolder ? await store.tryGet(bin, isWindows() ? "ffmpeg.exe" : "ffmpeg") : null;
    if (exe) bundledFfmpeg = exe.nativePath;
  } catch (e) { /* not bundled */ }
  return bundledFfmpeg;
}

// { path, source: "custom" | "bundled" | "path" }
// The copy shipped with the plugin wins; a custom path (older versions let you
// pick one) or ffmpeg on the PATH are only fallbacks.
async function findFfmpeg(st) {
  const b = await bundledFfmpegPath();
  if (b) return { path: b, source: "bundled" };
  if (st.ffmpegPath) return { path: st.ffmpegPath, source: "custom" };
  return { path: "ffmpeg", source: "path" };
}

function hex(bg) { return "0x" + bg.map((v) => (v < 16 ? "0" : "") + v.toString(16)).join(""); }

// Every frame is fitted into W x H (keeping its shape) and centred on the bars colour.
function scaleFilter(W, H, bg) {
  return "scale=" + W + ":" + H + ":force_original_aspect_ratio=decrease:flags=bicubic:out_range=tv," +
    "pad=" + W + ":" + H + ":(ow-iw)/2:(oh-ih)/2:color=" + hex(bg) + ",setsar=1,format=yuv420p";
}

// ffmpeg arguments for the video (paths relative to the recording folder)
function encodeArgs(fps, outPath, sep, W, H, bg) {
  return "-framerate " + fps + ' -i "' + RENDER_DIR + sep + "frame_%06d.jpg" + '"' +
    ' -vf "' + scaleFilter(W, H, bg) + '"' +
    " -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -color_range tv -movflags +faststart" +
    ' "' + outPath + '"';
}

// A .bat in the recording folder that runs ffmpeg with `args` and reports into
// workDir: progress, ffmpeg's messages, and its exit code when it's done.
function jobBat(ffmpegPath, workDir, args) {
  return [
    "@echo off",
    "chcp 65001 >nul",
    'cd /d "%~dp0"',
    '"' + ffmpegPath + '" -hide_banner -nostats -loglevel error -y -progress "' + workDir + "\\" + FF_PROGRESS + '" ' +
      args + ' 2> "' + workDir + "\\" + FF_LOG + '"',
    '> "' + workDir + "\\" + FF_DONE + '" echo %errorlevel%'
  ].join("\r\n") + "\r\n";
}

function batScript(outPath, fps, ffmpegPath, W, H, bg) {
  return jobBat(ffmpegPath, RENDER_DIR, encodeArgs(fps, outPath, "\\", W, H, bg).replace("%06d", "%%06d"));
}

function shScript(outPath, fps, ffmpegPath, W, H, bg) {
  return [
    "#!/bin/sh",
    'cd "$(dirname "$0")" || exit 1',
    '"' + ffmpegPath + '" -hide_banner -nostats -loglevel error -y -progress "' + RENDER_DIR + "/" + FF_PROGRESS + '" ' +
      encodeArgs(fps, outPath, "/", W, H, bg) + ' 2> "' + RENDER_DIR + "/" + FF_LOG + '"',
    'echo $? > "' + RENDER_DIR + "/" + FF_DONE + '"'
  ].join("\n") + "\n";
}

async function readText(folder, name) {
  const f = await store.tryGet(folder, name);
  if (!f) return null;
  try { return await f.read({ format: formats.utf8 }); } catch (e) { return null; }
}

async function openScript(entry, why) {
  try { return (await shell.openPath(entry.nativePath, why)) || ""; }
  catch (e) { return (e && e.message) || String(e); }
}

// Writes <name>.bat into the recording folder, starts it hidden through the
// launcher (one fixed helper script, so Photoshop's remembered permission
// applies; see launcher.js) and waits, reporting real progress (frames done /
// total). Returns elapsed ms. `what` says what ffmpeg is doing, for error messages.
async function runFfmpegJob(rec, workDir, workDirName, name, bat, total, onProgress, ff, what) {
  const fail = (text) => { const e = new Error(text); e.folderPath = rec.folder.nativePath; return e; };
  const b = await store.writeText(rec.folder, name + ".bat", bat);
  const t0 = Date.now();
  let err = await launcher.runBat(b.nativePath);
  if (err) {                                          // fall back to the visible console
    console.warn("Timelapse: launcher couldn't start ffmpeg (" + err + "), opening the .bat directly");
    err = await openScript(b, "Runs ffmpeg for " + what + ".");
  }
  if (err) throw fail("the ffmpeg script couldn't be started (" + err + "). You can double-click " + name + ".bat in the recording folder.");
  let started = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    const done = await readText(workDir, FF_DONE);
    if (done !== null && done.trim() !== "") {
      const code = parseInt(done.trim(), 10);
      if (code === 0) return Date.now() - t0;
      const log = ((await readText(workDir, FF_LOG)) || "").trim().split(/\r?\n/).slice(-3).join(" ");
      throw fail("ffmpeg stopped with an error" + (log ? ": " + log : ".") +
        (ff.source === "path" ? " Is ffmpeg installed? You can pick ffmpeg.exe under Settings." : ""));
    }
    const prog = await readText(workDir, FF_PROGRESS);
    if (prog !== null) {
      started = true;
      const m = prog.match(/frame=(\d+)(?![\s\S]*frame=)/);
      if (m) onProgress(Math.min(1, parseInt(m[1], 10) / total));
    }
    if (!started && Date.now() - t0 > 60000) throw fail("ffmpeg didn't start. You can double-click " + name + ".bat in the recording folder.");
  }
}

// Starts ffmpeg on the prepared frames and waits for it. Returns elapsed ms.
async function encodeWithFfmpeg(rec, renderDir, outPath, total, o, W, H, onProgress) {
  const ff = await findFfmpeg(o);
  if (!isWindows()) {
    await store.writeText(rec.folder, "make_video.sh", shScript(outPath, o.fps, ff.path, W, H, o.bg));
    const err = new Error("On macOS, run this in Terminal to make the video: sh \"" + rec.folder.nativePath + "/make_video.sh\"");
    err.folderPath = rec.folder.nativePath;
    throw err;
  }
  return runFfmpegJob(rec, renderDir, RENDER_DIR, "make_video", batScript(outPath, o.fps, ff.path, W, H, o.bg),
    total, onProgress, ff, "turning the timelapse frames into a video");
}

async function cleanupScripts(rec, name) {
  for (const n of [name + ".bat", name + ".vbs"]) {   // .vbs: left by versions before the launcher
    const f = await store.tryGet(rec.folder, n);
    if (f) { try { await f.delete(); } catch (e) { /* leave it */ } }
  }
}

async function cleanupFfmpeg(rec) { return cleanupScripts(rec, "make_video"); }

module.exports = { run, estimate, exportTimeEstimate, findFfmpeg, Cancelled, _scripts: { batScript, jobBat, thumbArgs } };
