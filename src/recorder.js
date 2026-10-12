"use strict";
/*
 * The capture engine. Each open document that has a recording gets a
 * session; while it's recording, every real edit (a new history state)
 * triggers a frame shortly afterwards.
 *
 * Why history states: brush strokes, fills, transforms, filters, text and
 * layer changes all create one, while showing/hiding layers, selecting
 * layers, zooming, panning, switching tools and picking colours don't. So
 * visibility toggles are never recorded. (If Photoshop's "Make Layer
 * Visibility Changes Undoable" option is on, toggles *do* create states; the
 * show/hide events are used to recognise and skip those too.)
 *
 * After a show/hide, captures wait for the next real edit, so toggling a
 * layer off and on again never produces a frame, and whatever you then do
 * with a layer hidden is recorded as it looks.
 *
 * Undo can switch layers on or off too (it puts back the visibility the
 * layers had at that step). Frames saved for an undo keep those layers the
 * way the video last showed them; the next real edit is recorded as it looks.
 */

const { core, action, imaging } = require("photoshop");
const settings = require("./settings.js");
const store = require("./store.js");
const raster = require("./raster.js");
const b64 = require("./b64.js");
const ps = require("./psutil.js");
const diag = require("./diag.js");

// A frame is grabbed shortly after an edit; more activity (strokes, switching
// tools...) pushes it back a little, up to a limit while you keep working.
// With a reference layer showing, grabbing a frame locks Photoshop for a
// moment (the layer is hidden for it), and a stroke started right then
// stutters, so those frames wait for a longer pause.
const timing = {
  settleMs: 350,             // quiet time before grabbing a frame...
  maxWaitMs: 2500,           // ...but no longer than this after the first unrecorded edit
  lockedSettleMs: 1000,      // the same while a reference layer is showing
  lockedMaxWaitMs: 6000
};
const VIS_WINDOW_MS = 250;   // a history change this close to a show/hide *is* the show/hide
const SIMILAR_TOL = 4;       // channel difference that counts as "unchanged"...
const SIMILAR_PX = 4;        // ...and frames with this few changed pixels (or fewer) are skipped
const PROFILE = "sRGB IEC61966-2.1";
const EVENTS = ["historyStateChanged", "show", "hide", "select", "set", "open", "close", "make", "save"];

const sessions = new Map();   // document id -> session
const probed = new Set();     // document ids already checked for a linked recording
let onChange = () => {};
let onMessage = () => {};
let captureChain = Promise.resolve();
const modalStrikes = new Map();   // imaging call -> { n: "needs a modal scope" errors in a row, at: last one }
let syncBusy = false, syncAgain = false, syncTimer = null;
let tickCount = 0;
let autoPaused = false;       // auto record held off (e.g. while exporting)
let autoBusy = false;
const noAuto = new Set();     // open documents whose recording was deleted: auto record leaves them alone
let grabbing = 0;             // our own capture is switching layers on/off right now
let ownToggles = { ids: new Set(), until: 0 };   // layers our last capture switched (their show/hide events are ours)

/* ---------------- helpers ---------------- */

function uuid() {
  const b = [];
  for (let i = 0; i < 16; i++) b.push(Math.floor(Math.random() * 256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map((x) => (x < 16 ? "0" : "") + x.toString(16)).join("");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}

function idleMs() { return Math.max(5, Number(settings.get().idleSec) || 30) * 1000; }

// layer id -> visible, from ps.layers()
function visOf(items) {
  const m = new Map();
  for (const l of items) m.set(l.id, l.visible);
  return m;
}

// Ids of the visible layers whose name contains the "never record" tag (a
// tagged group hides everything inside it; layers inside a hidden group
// don't count). `vis` can override visibility (id -> visible).
function taggedIds(items, tag, vis) {
  const out = [];
  if (!tag) return out;
  const skip = new Set();                     // items whose contents don't count
  for (let i = 0; i < items.length; i++) {
    const l = items[i];
    if (l.parent >= 0 && skip.has(l.parent)) { skip.add(i); continue; }
    const visible = vis && vis.has(l.id) ? vis.get(l.id) : l.visible;
    if (!visible) { skip.add(i); continue; }
    if (l.name.toLowerCase().indexOf(tag) >= 0) { out.push(l.id); skip.add(i); }
  }
  return out;
}

function excludeTag() { return String(settings.get().excludeTag || "").trim().toLowerCase(); }

// Is a reference layer showing? Then frames need the locking kind of capture.
function noteRefs(s, items) { s.refsVisible = taggedIds(items, excludeTag()).length > 0; }

// Our own capture's show/hide events (they arrive after it's done).
function isOwnToggle(desc) {
  if (Date.now() > ownToggles.until) return false;
  const refs = desc && Array.isArray(desc.null) ? desc.null : desc && desc.null ? [desc.null] : [];
  const ids = refs.filter((r) => r && r._ref === "layer" && typeof r._id === "number").map((r) => r._id);
  return ids.length > 0 && ids.every((id) => ownToggles.ids.has(id));
}

// Layers that exist in both maps but were switched on/off: [[id, visibleBefore], ...]
function visFlips(before, after) {
  const out = [];
  if (!before) return out;
  for (const [id, v] of after) if (before.has(id) && before.get(id) !== v) out.push([id, before.get(id)]);
  return out;
}

function activeId() {
  const d = ps.activeDoc();
  return d ? d.id : null;
}

// Run an imaging call directly; if Photoshop says it needs a modal scope, do
// this one inside one. A modal scope locks Photoshop (strokes and keyboard
// shortcuts wait), and that error often just means Photoshop or another plugin
// was busy for a moment, so the direct way stays the default. Only after
// several in a row are calls made modal straight away, and after a minute the
// direct way is tried again.
const MODAL_STRIKES = 3, MODAL_RETRY_MS = 60000;

function isLocked(key) {
  const m = modalStrikes.get(key);
  return !!m && m.n >= MODAL_STRIKES && Date.now() - m.at < MODAL_RETRY_MS;
}

async function imagingCall(key, fn) {
  if (!isLocked(key)) {
    try {
      const r = await fn();
      if (modalStrikes.has(key)) {
        if (modalStrikes.get(key).n >= MODAL_STRIKES) diag.log("NOTE: " + key + " works without locking Photoshop again");
        modalStrikes.delete(key);
      }
      return r;
    } catch (e) {
      if (!/modal/i.test(String((e && e.message) || e))) throw e;
      const m = modalStrikes.get(key) || { n: 0, at: 0 };
      m.n++; m.at = Date.now();
      modalStrikes.set(key, m);
      diag.log("NOTE: " + key + " needed a modal scope" + (m.n >= MODAL_STRIKES ? " " + m.n + " times in a row (locks Photoshop for the next minute)" : "") +
        ": " + ((e && e.message) || e));
    }
  }
  return core.executeAsModal(() => fn(), { commandName: "Timelapse capture", timeOut: 2000 });
}

/* ---------------- work timer ---------------- */
// Counts time between your actions; after `idleSec` seconds without any
// activity the counter stops until you do something again.

// Time since the last activity that still counts as work.
function activeGap(s, now) {
  return Math.max(0, Math.min((now || Date.now()) - s.lastActivity, idleMs()));
}

function workNow(s, now) {
  const m = s.rec.meta.workMs;
  if (!s.recording || s.lastActivity == null) return m;
  return m + activeGap(s, now);
}

function isIdle(s, now) {
  return s.recording && s.lastActivity != null && (now || Date.now()) - s.lastActivity >= idleMs();
}

function touch(s, now) {
  if (!s.recording) return;
  if (s.lastActivity != null) s.rec.meta.workMs += activeGap(s, now);
  s.lastActivity = Math.max(now, s.lastActivity || 0);
}

function commitWork(s) {
  if (s.lastActivity != null) {
    s.rec.meta.workMs += activeGap(s);
    s.lastActivity = null;
  }
}

/* ---------------- sessions ---------------- */

function newSession(docId, rec) {
  const doc = ps.findDoc(docId);
  return {
    docId, rec,
    docName: doc ? ps.docName(doc) : rec.meta.name,
    key: uuid().slice(0, 8),     // tags frames from this open-document session (history ids restart on reopen)
    recording: false,
    seen: new Set(), lastActiveId: null,
    dirty: false, firstDirtyAt: 0, visBlock: false, lastVisAt: 0,
    vis: null,                    // layer visibility as last seen
    frameVis: null,               // layer visibility in the last frame
    hold: new Map(),              // layer id -> visibility the video keeps (after an undo switched it)
    refsVisible: false,           // a reference layer is showing (frames lock Photoshop briefly)
    timer: null, retryTimer: null, queued: false, failures: 0,
    lastSaveAt: Date.now(),
    lastPixels: null, lastW: 0, lastH: 0, lastFrameN: 0,
    lastActivity: null, preview: null,
    userPaused: false             // paused by hand: auto record leaves it alone
  };
}

function sessionForRec(recId) {
  for (const s of sessions.values()) if (s.rec.id === recId) return s;
  return null;
}

function clearTimers(s) {
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null; }
}

function seedHistory(s) {
  const doc = ps.findDoc(s.docId);
  if (!doc) return;
  try {
    const hs = doc.historyStates;
    for (let i = 0; i < hs.length; i++) s.seen.add(hs[i].id);
    s.lastActiveId = doc.activeHistoryState.id;
  } catch (e) { /* no history yet */ }
  const items = ps.layers(doc);
  s.vis = visOf(items);
  noteRefs(s, items);
  s.frameVis = null;
  s.hold.clear();
}

function attach(docId, rec) {
  const s = newSession(docId, rec);
  sessions.set(docId, s);
  loadPreview(s);
  return s;
}

async function detach(s) {
  clearTimers(s);
  if (s.recording) commitWork(s);   // state stays "recording", so it resumes when the file is reopened
  sessions.delete(s.docId);
  try { await store.saveNow(s.rec); } catch (e) { console.error("Timelapse: save on close failed", e); }
}

function start(s, fresh) {
  const now = Date.now();
  diag.log("recording started: " + s.docName);
  s.recording = true;
  s.lastActivity = now;
  s.rec.meta.state = "recording";
  seedHistory(s);
  store.saveSoon(s.rec, 0);
  if (fresh) {                     // grab the current state right away
    s.dirty = true;
    s.firstDirtyAt = now;
    s.visBlock = false;
    requestCapture(s);
  }
  onChange();
}

function pause(s) {
  diag.log("recording paused: " + s.docName);
  commitWork(s);
  s.recording = false;
  s.dirty = false;
  clearTimers(s);
  s.rec.meta.state = "paused";
  store.saveSoon(s.rec, 0);
  onChange();
}

// The document got a new name (Save As, or renamed while closed): rename the
// recording and its folder to match. Runs between captures, never during an
// export (the export reads from the folder); if it can't happen now, the next
// save or document switch tries again.
function syncName(s) {
  const doc = ps.findDoc(s.docId);
  if (!doc || s.renaming || autoPaused || !store.needsRename(s.rec, ps.docName(doc))) return;
  s.renaming = true;
  captureChain = captureChain.then(async () => {
    try {
      const d = ps.findDoc(s.docId);
      if (d && sessions.get(s.docId) === s && await store.rename(s.rec, ps.docName(d))) onChange();
    } catch (e) {
      console.warn("Timelapse: couldn't rename the recording", e);
    } finally {
      s.renaming = false;
    }
  });
}

// Make sure the document carries this recording's ID (so reopening it finds it).
async function ensureLinked(s, retried) {
  try {
    const doc = ps.findDoc(s.docId);
    if (!doc) return;
    const p = ps.docPath(doc);
    if (p && p !== s.rec.meta.docPath) { s.rec.meta.docPath = p; store.saveSoon(s.rec); }
    syncName(s);
    if ((await ps.readId(s.docId)) !== s.rec.id) {
      const tw = Date.now();
      await ps.writeId(s.docId, s.rec.id);
      diag.log("stored the recording ID in the document: Photoshop LOCKED for " + (Date.now() - tw) + "ms");
    }
  } catch (e) {
    if (!retried) setTimeout(() => ensureLinked(s, true), 1500);   // Photoshop was probably busy
    else console.warn("Timelapse: couldn't store the recording ID in the document", e);
  }
}

// Show the newest frame that will be in the video.
async function loadPreview(s) {
  try {
    const hide = settings.get().hideUndone;
    const frames = s.rec.meta.frames;
    for (let i = frames.length - 1; i >= 0; i--) {
      if (hide && frames[i].u) continue;
      const f = await store.frameFile(s.rec, frames[i].n);
      if (f && !s.preview) { s.preview = b64.encode(await store.readBytes(f)); onChange(); }
      return;
    }
  } catch (e) { /* preview is cosmetic */ }
}

/* ---------------- open documents ---------------- */

async function probeDoc(docId) {
  if (!store.hasRoot()) return;
  const doc = ps.findDoc(docId);
  if (!doc) return;
  const id = await ps.readId(docId);
  let rec = id ? store.get(id) : null;
  if (!rec) rec = store.findByPath(ps.docPath(doc));
  if (!rec || sessionForRec(rec.id)) return;   // not linked, or a duplicate of an open document
  const s = attach(docId, rec);
  syncName(s);
  if (rec.meta.state === "recording") {
    start(s, false);
    onMessage("Resumed recording “" + s.docName + "”.");
  }
}

async function syncDocs() {
  if (syncBusy) { syncAgain = true; return; }
  syncBusy = true;
  try {
    do {
      syncAgain = false;
      const docs = ps.openDocs();
      const ids = new Set(docs.map((d) => d.id));
      for (const s of Array.from(sessions.values())) {
        if (!ids.has(s.docId)) await detach(s);
      }
      for (const id of Array.from(probed)) if (!ids.has(id)) probed.delete(id);
      for (const id of Array.from(noAuto)) if (!ids.has(id)) noAuto.delete(id);
      for (const d of docs) {
        const s = sessions.get(d.id);
        if (s) { s.docName = ps.docName(d); syncName(s); }
        if (!probed.has(d.id)) { probed.add(d.id); await probeDoc(d.id); }
      }
    } while (syncAgain);
    await autoCheck();
  } catch (e) {
    console.error("Timelapse: document sync failed", e);
  } finally {
    syncBusy = false;
  }
  onChange();
}

function scheduleSync() {
  if (syncTimer) return;
  syncTimer = setTimeout(() => { syncTimer = null; syncDocs(); }, 150);
}

/* ---------------- Photoshop events ---------------- */

function handleEvent(name, desc) {
  try {
    const now = Date.now();
    if (name === "historyStateChanged") {
      const id = desc && typeof desc.documentID === "number" ? desc.documentID : activeId();
      onHistory(id, now).catch((e) => console.error("Timelapse: history handling failed", e));
      return;
    }
    if ((name === "show" || name === "hide") && (grabbing || isOwnToggle(desc))) return;   // our capture hiding a reference layer
    if (name === "open" || name === "close" || name === "make" || name === "select") scheduleSync();
    diag.log("event " + name + (desc && desc._obj && desc._obj !== name ? " (" + desc._obj + ")" : ""));
    const id = activeId();
    const s = id !== null ? sessions.get(id) : null;
    if (!s) return;
    if (s.timer && s.dirty) scheduleCapture(s, now);   // you're doing something: don't grab a frame right now
    if (name === "show" || name === "hide") onVisibility(s, now);
    else touch(s, now);
    if (name === "save") setTimeout(() => ensureLinked(s), 400);
  } catch (e) {
    console.error("Timelapse: event handling failed", e);
  }
}

function onVisibility(s, now) {
  if (!s.recording) return;
  const doc = ps.findDoc(s.docId);
  if (!doc) return;
  const items = ps.layers(doc);
  const vis = visOf(items);
  noteRefs(s, items);                          // you may have shown or hidden a reference layer
  // nothing switched compared to what we know: our own capture putting layers
  // back, or a toggle already handled as a history state
  if (s.vis && !visFlips(s.vis, vis).length && vis.size === s.vis.size) return;
  const flips = visFlips(s.vis, vis);
  s.vis = vis;
  touch(s, now);
  visibilityOnly(s, now, flips);
  // With "Make Layer Visibility Changes Undoable" on, the toggle is already a
  // history state; claim it so it isn't taken for an edit when its
  // historyStateChanged arrives late.
  try {
    const aid = doc.activeHistoryState.id;
    if (!s.seen.has(aid)) { s.seen.add(aid); s.lastActiveId = aid; }
  } catch (e) { /* no history */ }
}

// A show/hide by hand: no frame until the next real edit, and layers you
// switched yourself are no longer held from an earlier undo.
function visibilityOnly(s, now, flips) {
  s.lastVisAt = now;
  s.visBlock = true;
  for (const [id] of flips || []) s.hold.delete(id);
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
}

async function onHistory(docId, now) {
  const s = sessions.get(docId);
  if (!s || !s.recording) return;
  try { return await onHistoryInner(s, docId, now); }
  finally { diag.log("history change handled in " + (Date.now() - now) + "ms"); }
}

async function onHistoryInner(s, docId, now) {
  const doc = ps.findDoc(docId);
  if (!doc) return;
  let aid;
  try { aid = doc.activeHistoryState.id; } catch (e) { return; }
  if (aid === s.lastActiveId) return;          // nothing actually changed (e.g. our own rolled-back capture)
  s.lastActiveId = aid;
  touch(s, now);
  const items = ps.layers(doc);
  noteRefs(s, items);                          // e.g. a layer just became a reference layer
  if (s.timer && s.dirty) scheduleCapture(s, now);
  const vis = visOf(items);
  const flips = visFlips(s.vis, vis);
  s.vis = vis;
  if (!s.seen.has(aid)) {
    s.seen.add(aid);
    // a visibility toggle recorded as a history state
    if (now - s.lastVisAt < VIS_WINDOW_MS) return;
    if (flips.length) { visibilityOnly(s, now, flips); return; }
    s.hold.clear();                              // a real edit: recorded as it looks
    markDirty(s, now);
  } else {
    // undo / redo / clicking in the History panel. If that switched layers
    // on or off, the video keeps them the way its last frame showed them.
    for (const [id, before] of flips) {
      const shown = s.frameVis && s.frameVis.has(id) ? s.frameVis.get(id) : before;
      if (shown === vis.get(id)) s.hold.delete(id);
      else s.hold.set(id, shown);
    }
    if (refreshUndoMarks(s, doc, aid)) {
      store.saveSoon(s.rec);
      if (settings.get().hideUndone) { s.preview = null; loadPreview(s); }
      onChange();
    }
    if (!settings.get().hideUndone) markDirty(s, now);
  }
}

// Frames whose history state is currently undone are flagged (u = 1) and
// left out of the video; redo brings them back.
function refreshUndoMarks(s, doc, activeHistoryId) {
  const list = [];
  let activeIdx = -1;
  try {
    const hs = doc.historyStates;
    for (let i = 0; i < hs.length; i++) {
      const h = hs[i];
      if (h.snapshot) continue;
      list.push(h.id);
      if (h.id === activeHistoryId) activeIdx = list.length - 1;
    }
  } catch (e) { return false; }
  for (const id of list) s.seen.add(id);
  const undone = new Set(activeIdx >= 0 ? list.slice(activeIdx + 1) : list);
  const live = new Set(activeIdx >= 0 ? list.slice(0, activeIdx + 1) : []);
  let changed = false;
  const frames = s.rec.meta.frames;
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (f.s !== s.key) break;                  // older sessions come first; their history is gone
    const u = undone.has(f.h) ? 1 : live.has(f.h) ? 0 : f.u;
    if (u !== f.u) { f.u = u; changed = true; }
  }
  if (changed) {
    const last = frames.find((f) => f.n === s.lastFrameN);
    if (!last || last.u) s.lastPixels = null;  // next capture is compared against nothing
  }
  return changed;
}

function markDirty(s, now) {
  if (!s.dirty) s.firstDirtyAt = now;
  s.dirty = true;
  s.visBlock = false;
  scheduleCapture(s, now);
}

// (Re)starts the wait for a quiet moment before the next frame.
function scheduleCapture(s, now) {
  if (s.timer) clearTimeout(s.timer);
  const locked = needsLock(s);
  const due = Math.min(now + (locked ? timing.lockedSettleMs : timing.settleMs),
    s.firstDirtyAt + (locked ? timing.lockedMaxWaitMs : timing.maxWaitMs));
  s.timer = setTimeout(() => { s.timer = null; requestCapture(s); }, Math.max(0, due - now));
}

/* ---------------- capturing ---------------- */

function requestCapture(s) {
  if (s.queued) return;
  s.queued = true;
  captureChain = captureChain.then(async () => {
    s.queued = false;
    if (!s.recording || !s.dirty || s.visBlock || sessions.get(s.docId) !== s) return;
    await capture(s);
  }).catch((e) => console.error("Timelapse: capture failed", e));
}

function targetSize(w, h, maxLong) {
  const k = Math.min(1, maxLong / Math.max(w, h));
  return {
    width: Math.max(2, Math.floor(w * k / 2) * 2),
    height: Math.max(2, Math.floor(h * k / 2) * 2)
  };
}

// The next frame has to switch layers (a reference layer showing, or layers an
// undo switched), which locks Photoshop for a moment.
function needsLock(s) { return s.refsVisible || s.hold.size > 0; }

async function grab(s, doc) {
  const opts = {
    documentID: s.docId,
    targetSize: targetSize(doc.width, doc.height, settings.maxLong()),
    componentSize: 8,
    applyAlpha: true,
    colorSpace: "RGB",
    colorProfile: PROFILE
  };
  // All layers in one call (before locking anything), and the visibility the
  // frame shows: layers an undo switched on/off the way the video had them...
  const items = ps.layers(doc);
  const current = visOf(items);
  const frameVis = new Map(current);
  for (const [id, v] of s.hold) if (frameVis.has(id)) frameVis.set(id, v);
  // ...and reference layers hidden.
  const refs = new Set(taggedIds(items, excludeTag(), frameVis));
  noteRefs(s, items);
  const want = (id) => frameVis.get(id) && !refs.has(id);
  const hide = [], show = [];
  for (const [id, v] of current) {
    if (v && !want(id)) hide.push(id);
    else if (!v && want(id)) show.push(id);
  }
  const historyId = doc.activeHistoryState.id;
  let res, lockedMs = null;
  if (hide.length || show.length) {
    // Switch those layers, read the pixels and put everything back inside one
    // modal scope, with one call to Photoshop for each step. Photoshop doesn't
    // repaint the canvas while a modal scope is held, so nothing blinks, and
    // the suspended history is rolled back so no history states are added.
    grabbing++;
    const tl = Date.now();
    try {
      res = await core.executeAsModal(async (ctx) => {
        let susp = null;
        try { susp = await ctx.hostControl.suspendHistory({ documentID: s.docId, name: "Timelapse capture" }); } catch (e) { susp = null; }
        try {
          await ps.setVisible(s.docId, hide, false);
          await ps.setVisible(s.docId, show, true);
          return await imaging.getPixels(opts);
        } finally {
          await ps.setVisible(s.docId, show, false);
          await ps.setVisible(s.docId, hide, true);
          if (susp !== null) { try { await ctx.hostControl.resumeHistory(susp, false); } catch (e) { /* nothing to roll back */ } }
        }
      }, { commandName: "Timelapse capture", timeOut: 2000 });
    } finally {
      grabbing--;
      lockedMs = Date.now() - tl;
      ownToggles = { ids: new Set(hide.concat(show)), until: Date.now() + 1500 };
    }
  } else {
    res = await imagingCall("getPixels", () => imaging.getPixels(opts));
  }

  let imageData = res.imageData;
  const width = imageData.width, height = imageData.height;
  let pixels = await imageData.getData({ chunky: true });
  if (imageData.components === 4) {
    pixels = raster.rgbaOnWhite(pixels, width, height);
    imageData.dispose();
    imageData = await imagingCall("createImageData", () => imaging.createImageDataFromBuffer(pixels,
      { width, height, components: 3, colorSpace: "RGB", colorProfile: PROFILE, chunky: true }));
  } else if (imageData.components !== 3) {
    imageData.dispose();
    throw new Error("Unsupported pixel format (" + imageData.components + " channels)");
  } else {
    pixels = new Uint8Array(pixels);   // own copy; the image data is released below
  }
  return { imageData, pixels, width, height, historyId, frameVis, lockedMs };
}

async function capture(s) {
  const doc = ps.findDoc(s.docId);
  if (!doc) return;
  s.dirty = false;
  const t0 = Date.now(), parts = [];
  let note = "skipped (no visible change)";
  let g;
  try {
    g = await diag.timed(parts, "grab", () => grab(s, doc));
  } catch (e) {
    diag.log("capture FAILED after " + (Date.now() - t0) + "ms (" + parts.join(", ") + "): " + ((e && e.message) || e));
    // Photoshop busy (dialog open, another plugin running...): try again soon.
    s.dirty = true;
    s.failures++;
    const delay = Math.min(8000, 400 * Math.pow(2, Math.min(5, s.failures)));
    if (s.retryTimer) clearTimeout(s.retryTimer);
    s.retryTimer = setTimeout(() => { s.retryTimer = null; requestCapture(s); }, delay);
    if (s.failures === 4) onMessage("Photoshop is busy — the next frame will be saved when it's free.");
    console.warn("Timelapse: capture deferred", e);
    return;
  }
  s.failures = 0;
  s.frameVis = g.frameVis;
  try {
    // skip frames where (almost) nothing visible changed, e.g. after a selection
    const tc = Date.now();
    const same = s.lastPixels && s.lastW === g.width && s.lastH === g.height &&
        raster.countChanged(g.pixels, s.lastPixels, SIMILAR_TOL, SIMILAR_PX) <= SIMILAR_PX;
    parts.push("compare " + (Date.now() - tc) + "ms");
    if (same) return;
    const encoded = await diag.timed(parts, "encode" + (isLocked("encode") ? " (locked)" : ""),
      () => imagingCall("encode", () => imaging.encodeImageData({ imageData: g.imageData, base64: true })));
    let str, bytes;
    if (typeof encoded === "string") {
      str = encoded.slice(0, 5) === "data:" ? encoded.slice(encoded.indexOf(",") + 1) : encoded;
      bytes = b64.decode(str);
    } else {                                   // got raw bytes instead of base64
      bytes = encoded instanceof Uint8Array ? encoded : Uint8Array.from(encoded);
      str = b64.encode(bytes);
    }
    const rec = s.rec;
    const n = rec.meta.nextIndex++;
    await diag.timed(parts, "write", () => store.writeFrame(rec, n, bytes));
    note = "frame " + n;
    rec.meta.recorded = Date.now();
    rec.meta.frames.push({
      n, t: rec.meta.recorded, w: Math.round(workNow(s)),
      x: g.width, y: g.height, b: bytes.length,
      s: s.key, h: g.historyId, u: 0
    });
    rec.meta.bytes += bytes.length;
    s.lastPixels = g.pixels;
    s.lastW = g.width;
    s.lastH = g.height;
    s.lastFrameN = n;
    s.preview = str;
    store.saveSoon(rec);
    onChange();
  } finally {
    try { g.imageData.dispose(); } catch (e) { /* already released */ }
    diag.log(note + ": " + (Date.now() - t0) + "ms total (" + parts.join(", ") + "), " + g.width + "x" + g.height +
      (g.lockedMs !== null ? ", Photoshop LOCKED for " + g.lockedMs + "ms (reference/held layers)" : "") +
      (isLocked("getPixels") ? ", getPixels LOCKED" : ""));
  }
}

/* ---------------- periodic work ---------------- */

function tick() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (!s.recording) continue;
    if (now - s.lastSaveAt > 20000) { s.lastSaveAt = now; store.saveSoon(s.rec, 0); }
  }
  if (++tickCount % 2 === 0) scheduleSync();
  onChange();
}

/* ---------------- public API ---------------- */

function init(callbacks) {
  onChange = callbacks.onChange || onChange;
  onMessage = callbacks.onMessage || onMessage;
  try {
    action.addNotificationListener(EVENTS, handleEvent);
  } catch (e) {
    console.error("Timelapse: couldn't listen for Photoshop events", e);
    onMessage("Couldn't connect to Photoshop events — recording won't work.");
  }
  setInterval(tick, 500);
  syncDocs();
}

// The Record / Pause button.
async function toggleActive() {
  const doc = ps.activeDoc();
  if (!doc) { onMessage("Open a document first."); return; }
  let s = sessions.get(doc.id);
  if (s) {
    if (s.recording) { pause(s); s.userPaused = true; }
    else { s.userPaused = false; start(s, true); ensureLinked(s); }
    return;
  }
  await startNew(doc, true);
}

// Create (or re-link) a recording for a document that has no session yet and start it.
async function startNew(doc, askForFolder) {
  if (!store.hasRoot()) {
    if (!askForFolder) return;
    onMessage("Choose a folder for your recordings.");
    if (!(await store.chooseRoot())) { onMessage("Recording needs a folder to save frames in."); return; }
    onMessage("Recordings are saved in " + store.rootPath());
    onChange();
  }
  const xmpId = await ps.readId(doc.id);
  let rec = xmpId ? store.get(xmpId) : null;
  if (!rec) rec = store.findByPath(ps.docPath(doc));
  if (rec && sessionForRec(rec.id)) rec = null;     // duplicate of an open document: start fresh
  if (!rec) {
    const reuse = xmpId && !store.get(xmpId) ? xmpId : null;
    rec = await store.create({ id: reuse || uuid(), name: ps.docName(doc), docPath: ps.docPath(doc) });
  }
  if (sessions.has(doc.id)) return;                  // a sync attached it meanwhile
  probed.add(doc.id);
  const s = attach(doc.id, rec);
  start(s, true);
  ensureLinked(s);
}

/* ---------------- auto record ---------------- */
// With "Auto record" on, whatever document you're on is recorded, unless you
// paused it yourself.
async function autoCheck() {
  if (!settings.get().autoRecord || autoPaused || autoBusy || !store.hasRoot()) return;
  const doc = ps.activeDoc();
  if (!doc) return;
  const s = sessions.get(doc.id);
  if (s) {
    if (!s.recording && !s.userPaused) { start(s, true); ensureLinked(s); }
    return;
  }
  if (!probed.has(doc.id)) return;                   // still finding out whether it's linked
  if (noAuto.has(doc.id)) return;                    // you deleted its recording
  autoBusy = true;
  try { await startNew(doc, false); }
  catch (e) { console.warn("Timelapse: auto record couldn't start", e); }
  finally { autoBusy = false; }
}

function setAutoPaused(on) { autoPaused = !!on; }

function activeState() {
  const now = Date.now();
  const doc = ps.activeDoc();
  const out = { hasDoc: !!doc, docName: doc ? ps.docName(doc) : "", hasRoot: store.hasRoot(), session: null, others: [] };
  for (const s of sessions.values()) {
    const info = {
      docName: s.docName, recId: s.rec.id, recording: s.recording, idle: isIdle(s, now),
      workMs: workNow(s, now), frames: liveFrameCount(s.rec), bytes: s.rec.meta.bytes, preview: s.preview
    };
    if (doc && s.docId === doc.id) out.session = info;
    else out.others.push(info);
  }
  return out;
}

function liveFrameCount(rec) {
  if (!settings.get().hideUndone) return rec.meta.frames.length;
  let n = 0;
  for (const f of rec.meta.frames) if (!f.u) n++;
  return n;
}

function isRecordingRec(recId) {
  const s = sessionForRec(recId);
  return !!(s && s.recording);
}

function currentWork(recId) {
  const s = sessionForRec(recId);
  return s ? workNow(s) : null;
}

// Output folder changed: stop everything tied to the old folder, re-link.
async function rootChanged() {
  for (const s of Array.from(sessions.values())) {
    if (s.recording) pause(s);
    await detach(s);
  }
  probed.clear();
  await syncDocs();
}

// Recordings that open documents are recording into (the store keeps these as they are when re-reading the folder).
function openRecIds() {
  return Array.from(sessions.values()).map((s) => s.rec.id);
}

// The recording is being deleted: an open document stops using it (without
// saving it again), and auto record doesn't start a new one for it.
function forget(recId) {
  const s = sessionForRec(recId);
  if (!s) return;
  clearTimers(s);
  s.recording = false;
  sessions.delete(s.docId);
  noAuto.add(s.docId);
  onChange();
}

function afterClear(recId) {
  const s = sessionForRec(recId);
  if (s) { s.lastPixels = null; s.preview = null; s.lastFrameN = 0; }
  onChange();
}

async function flush(recId) {
  const s = sessionForRec(recId);
  if (s) await store.saveNow(s.rec);
}

/* ---------------- reference layers ---------------- */
// A reference layer is any layer whose name contains the tag (default "[ref]");
// it stays visible to you but is hidden in every frame.

function refTag() { return String(settings.get().excludeTag || "").trim() || "[ref]"; }

function selectedLayers(doc) {
  const out = [];
  try { const a = doc.activeLayers; for (let i = 0; i < a.length; i++) out.push(a[i]); } catch (e) { /* none */ }
  return out;
}

function hasTag(layer, tagLc) {
  try { return String(layer.name || "").toLowerCase().indexOf(tagLc) >= 0; } catch (e) { return false; }
}

function withoutTag(name, tag) {
  const i = name.toLowerCase().indexOf(tag.toLowerCase());
  return i < 0 ? name : (name.slice(0, i) + name.slice(i + tag.length)).replace(/\s+/g, " ").trim() || "Layer";
}

// { count: selected layers, tagged: all of them are reference layers,
//   some: how many are, name: the layer's name without the tag (one layer selected) }
function referenceState() {
  const doc = ps.activeDoc();
  if (!doc) return { count: 0, tagged: false, some: 0, name: "" };
  const layers = selectedLayers(doc);
  const tag = refTag(), tagLc = tag.toLowerCase();
  const some = layers.filter((l) => hasTag(l, tagLc)).length;
  let name = "";
  if (layers.length === 1) { try { name = withoutTag(String(layers[0].name || ""), tag); } catch (e) { name = ""; } }
  return { count: layers.length, tagged: layers.length > 0 && some === layers.length, some, name };
}

// Makes the selected layers reference layers (want = true) or normal ones
// (want = false); without `want`, removes the tag if they all have it and
// adds it otherwise.
async function toggleReference(want) {
  const doc = ps.activeDoc();
  if (!doc) { onMessage("Open a document first."); return; }
  const layers = selectedLayers(doc);
  if (!layers.length) { onMessage("Select a layer first."); return; }
  if (!String(settings.get().excludeTag || "").trim()) settings.set("excludeTag", "[ref]");
  const tag = refTag(), tagLc = tag.toLowerCase();
  const remove = typeof want === "boolean" ? !want : layers.every((l) => hasTag(l, tagLc));
  const todo = layers.filter((l) => hasTag(l, tagLc) === remove);
  if (!todo.length) { onChange(); return; }          // already the way you asked
  let failed = 0;
  await core.executeAsModal(async (ctx) => {
    let susp = null;
    try { susp = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: remove ? "Remove Reference Layer" : "Make Reference Layer" }); } catch (e) { susp = null; }
    for (const l of todo) {
      try {
        const name = String(l.name || "");
        l.name = remove ? withoutTag(name, tag) : name + " " + tag;
      } catch (e) { failed++; }
    }
    if (susp !== null) { try { await ctx.hostControl.resumeHistory(susp, true); } catch (e) { /* nothing changed */ } }
  }, { commandName: "Reference layer", timeOut: 5000 });
  const n = todo.length - failed;
  if (failed && !n) onMessage("That layer can't be renamed (the Background layer can't be a reference — duplicate it first).");
  else if (remove) onMessage(n === 1 ? "Removed the reference tag — the layer is recorded again." : "Removed the reference tag from " + n + " layers.");
  else onMessage((n === 1 ? "Reference layer set" : n + " reference layers set") + ": you still see it, the timelapse doesn't.");
  onChange();
}

module.exports = {
  init, toggleActive, activeState, liveFrameCount, isRecordingRec, currentWork,
  rootChanged, afterClear, forget, openRecIds, _timing: timing, flush, referenceState, toggleReference, autoCheck, setAutoPaused
};
