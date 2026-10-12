"use strict";
/*
 * Recordings on disk. Layout inside the chosen output folder:
 *
 *   <Output folder>/
 *     <Document name> (<id prefix>)/
 *       recording.json      metadata + one entry per frame
 *       frames/f_000001.jpg captured frames
 *       timelapse_*.mp4     exported videos
 */

const { storage } = require("uxp");
const { localFileSystem: lfs, formats } = storage;
const settings = require("./settings.js");

const META = "recording.json";
const FRAMES = "frames";

const recs = new Map();   // recording id -> handle
let root = null;          // Folder entry of the output folder

function pad(n, width) {
  let s = String(n);
  while (s.length < width) s = "0" + s;
  return s;
}
function frameName(n) { return "f_" + pad(n, 6) + ".jpg"; }

function toArrayBuffer(u8) {
  return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer;
}

// "Portrait (1a2b3c4d)": the document's name plus the start of the recording ID
function folderName(id, nice) { return nice + " (" + id.slice(0, 8) + ")"; }

function safeName(name) {
  const s = String(name || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return s || "Untitled";
}

async function tryGet(folder, name) {
  try { return await folder.getEntry(name); } catch (e) { return null; }
}

async function ensureFolder(parent, name) {
  const e = await tryGet(parent, name);
  if (e && e.isFolder) return e;
  return parent.createFolder(name);
}

async function removeTree(entry) {
  if (entry.isFolder) {
    for (const child of await entry.getEntries()) await removeTree(child);
  }
  await entry.delete();
}

async function freshFolder(parent, name) {
  const old = await tryGet(parent, name);
  if (old) await removeTree(old);
  return parent.createFolder(name);
}

async function writeBytes(folder, name, bytes) {
  const f = await folder.createFile(name, { overwrite: true });
  await f.write(toArrayBuffer(bytes), { format: formats.binary });
  return f;
}

async function writeText(folder, name, text) {
  const f = await folder.createFile(name, { overwrite: true });
  await f.write(text, { format: formats.utf8 });
  return f;
}

async function readBytes(file) {
  return new Uint8Array(await file.read({ format: formats.binary }));
}

/* ---------------- output folder ---------------- */

async function init() {
  root = null;
  const st = settings.get();
  if (st.rootToken) {
    try { root = await lfs.getEntryForPersistentToken(st.rootToken); } catch (e) { root = null; }
  }
  await scan();
  return !!root;
}

async function chooseRoot() {
  const folder = await lfs.getFolder();
  if (!folder) return false;
  const token = await lfs.createPersistentToken(folder);
  settings.set("rootToken", token);
  settings.set("rootPath", folder.nativePath);
  root = folder;
  await scan();
  return true;
}

function hasRoot() { return !!root; }

// A text file directly in the recordings folder (e.g. the diagnostic log).
async function writeRootText(name, text) {
  if (root) await writeText(root, name, text);
}
function rootPath() { return root ? root.nativePath : ""; }

/* ---------------- recordings ---------------- */

function normalizeMeta(m) {
  if (!m || typeof m !== "object" || !m.id) return null;
  m.frames = Array.isArray(m.frames) ? m.frames : [];
  m.workMs = Number(m.workMs) || 0;
  m.bytes = Number(m.bytes) || m.frames.reduce((a, f) => a + (f.b || 0), 0);
  m.nextIndex = Math.max(Number(m.nextIndex) || 1, m.frames.reduce((a, f) => Math.max(a, f.n + 1), 1));
  m.state = m.state === "recording" ? "recording" : "paused";
  m.exports = Array.isArray(m.exports) ? m.exports : [];
  // when something was last recorded (the Library's order); older recordings: their last frame
  m.recorded = Number(m.recorded) || (m.frames.length ? m.frames[m.frames.length - 1].t : 0) || Number(m.created) || 0;
  return m;
}

function makeHandle(folder, meta) {
  return { id: meta.id, folder, framesFolder: null, meta, saveTimer: null, saving: null };
}

// Reads every recording in the folder. Recordings in `keepIds` (the ones open
// documents are recording into) keep their current handle: the copy in memory
// is the newest, and the recorder keeps using that same object.
async function scan(keepIds) {
  const keep = new Map();
  for (const id of keepIds || []) if (recs.has(id)) keep.set(id, recs.get(id));
  recs.clear();
  for (const [id, h] of keep) recs.set(id, h);
  if (!root) return;
  let entries = [];
  try { entries = await root.getEntries(); } catch (e) { return; }
  for (const e of entries) {
    if (!e.isFolder) continue;
    const mf = await tryGet(e, META);
    if (!mf || !mf.isFile) continue;
    try {
      const meta = normalizeMeta(JSON.parse(await mf.read({ format: formats.utf8 })));
      if (meta && !recs.has(meta.id)) recs.set(meta.id, makeHandle(e, meta));
    } catch (err) {
      console.warn("Timelapse: skipping unreadable recording in", e.name, err);
    }
  }
}

async function create({ id, name, docPath }) {
  if (!root) throw new Error("Choose an output folder first.");
  const nice = safeName(name);
  const folder = await ensureFolder(root, folderName(id, nice));
  const now = Date.now();
  const meta = {
    version: 1, id, name: nice, docPath: docPath || "",
    created: now, updated: now, recorded: now, state: "paused",
    workMs: 0, bytes: 0, nextIndex: 1, frames: [], exports: []
  };
  const h = makeHandle(folder, meta);
  recs.set(id, h);
  await saveNow(h);
  return h;
}

function get(id) { return recs.get(id) || null; }

function findByPath(docPath) {
  if (!docPath) return null;
  const norm = (s) => s.replace(/\\/g, "/").toLowerCase();
  const want = norm(docPath);
  for (const h of recs.values()) if (h.meta.docPath && norm(h.meta.docPath) === want) return h;
  return null;
}

// Newest recording activity first. (Not by "updated": deleting frames or
// exporting shouldn't move a recording to the top.)
function list() {
  return Array.from(recs.values()).sort((a, b) => (b.meta.recorded || 0) - (a.meta.recorded || 0));
}

// Removes a recording and its whole folder.
async function deleteRecording(h) {
  if (h.saveTimer) { clearTimeout(h.saveTimer); h.saveTimer = null; }
  try { await h.saving; } catch (e) { /* it's being deleted anyway */ }
  recs.delete(h.id);
  await removeTree(h.folder);
}

function saveSoon(h, delay) {
  if (h.saveTimer) return;
  h.saveTimer = setTimeout(() => {
    h.saveTimer = null;
    saveNow(h).catch((e) => console.error("Timelapse: saving recording failed", e));
  }, delay === undefined ? 2000 : delay);
}

// Writes recording.json via a temp file so a crash mid-write can't corrupt it.
function saveNow(h) {
  if (h.saveTimer) { clearTimeout(h.saveTimer); h.saveTimer = null; }
  const run = async () => {
    h.meta.updated = Date.now();
    const text = JSON.stringify(h.meta);
    const tmp = await writeText(h.folder, META + ".tmp", text);
    try {
      await tmp.moveTo(h.folder, { newName: META, overwrite: true });
    } catch (e) {
      await writeText(h.folder, META, text);
      try { await tmp.delete(); } catch (e2) { /* leftover temp file is harmless */ }
    }
  };
  h.saving = (h.saving || Promise.resolve()).then(run, run);
  return h.saving;
}

/* ---------------- frames ---------------- */

async function framesFolder(h) {
  if (!h.framesFolder) h.framesFolder = await ensureFolder(h.folder, FRAMES);
  return h.framesFolder;
}

async function writeFrame(h, n, bytes) {
  await writeBytes(await framesFolder(h), frameName(n), bytes);
}

async function frameFile(h, n) {
  return tryGet(await framesFolder(h), frameName(n));
}

// name -> File for every frame on disk (one directory listing instead of a lookup per frame)
async function frameFiles(h) {
  const map = new Map();
  for (const e of await (await framesFolder(h)).getEntries()) if (e.isFile) map.set(e.name, e);
  return map;
}

async function clearFrames(h, onProgress) {
  const ff = await framesFolder(h);
  const entries = await ff.getEntries();
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].isFile) { try { await entries[i].delete(); } catch (e) { /* skip locked file */ } }
    if (onProgress && i % 40 === 0) onProgress(i / entries.length);
  }
  const thumbs = await tryGet(h.folder, "thumbs32.bin");     // flicker-check cache (see deflicker.js)
  if (thumbs) { try { await thumbs.delete(); } catch (e) { /* stale cache is harmless */ } }
  h.meta.frames = [];
  h.meta.bytes = 0;
  await saveNow(h);
}

// Does the recording still carry the document's old name (after Save As, or a rename)?
function needsRename(h, docName) {
  const nice = safeName(docName);
  return h.meta.name !== nice || h.folder.name !== folderName(h.id, nice);
}

// Renames the recording and its folder to match the document. If the folder
// can't be renamed right now (a file in it is open elsewhere), the recording
// keeps its old folder and the next call tries again.
async function rename(h, docName) {
  if (!needsRename(h, docName)) return false;
  const nice = safeName(docName);
  const want = folderName(h.id, nice);
  h.meta.name = nice;
  if (root && h.folder.name !== want && !(await tryGet(root, want))) {
    if (h.saveTimer) { clearTimeout(h.saveTimer); h.saveTimer = null; }
    try { await h.saving; } catch (e) { /* the save below writes it again */ }
    try {
      await h.folder.moveTo(root, { newName: want });
      const moved = await tryGet(root, want);
      if (moved && moved.isFolder) { h.folder = moved; h.framesFolder = null; }
    } catch (e) {
      console.warn("Timelapse: couldn't rename the recording folder", e);
    }
  }
  await saveNow(h);
  return true;
}

module.exports = {
  init, chooseRoot, hasRoot, rootPath, scan,
  create, get, findByPath, list, deleteRecording, saveSoon, saveNow, needsRename, rename,
  writeFrame, frameFile, frameFiles, frameName, clearFrames,
  readBytes, writeBytes, writeText, writeRootText, tryGet, ensureFolder, freshFolder, removeTree, safeName
};
