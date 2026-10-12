"use strict";

const VERSION = "1.5.20";

const { storage } = require("uxp");
const { localFileSystem: lfs } = storage;
const settings = require("./settings.js");
const store = require("./store.js");
const recorder = require("./recorder.js");
const exporter = require("./exporter.js");
const diag = require("./diag.js");
const launcher = require("./launcher.js");

const $ = (id) => document.getElementById(id);

const ui = {
  view: "main",
  exporting: false,
  cancel: false,
  lastExport: null,
  lastPreview: null,
  renderTimer: null,
  toastTimer: null
};

/* ---------------- formatting ---------------- */

function fmtInt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

function fmtClock(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
}

function fmtBytes(b) {
  if (b < 1024 * 1024) return Math.max(0, Math.round(b / 1024)) + " KB";
  if (b < 1024 * 1024 * 1024) { const mb = b / 1048576; return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + " MB"; }
  return (b / 1073741824).toFixed(2) + " GB";
}

function fmtSeconds(s) {
  s = Math.round(s);
  return s < 60 ? s + " s" : Math.floor(s / 60) + " min " + String(s % 60).padStart(2, "0") + " s";
}

function fmtAgo(t) {
  if (!t) return "";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " h ago";
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : d + " days ago";
}

function errText(e) { return (e && e.message) || String(e); }

function fileSafe(s) { return String(s || "timelapse").replace(/[\\/:*?"<>|]+/g, "_").trim() || "timelapse"; }

/* ---------------- small components ---------------- */

function closeAllDropdowns() {
  document.querySelectorAll(".dd.open").forEach((d) => d.classList.remove("open"));
}

// Custom dropdown (native <select> is unreliable in UXP); getOptions() -> [{ value, label }]
function dropdown(mountId, getOptions, getValue, setValue) {
  const dd = document.createElement("div");
  dd.className = "dd";
  const head = document.createElement("div");
  head.className = "dd-head";
  const headText = document.createElement("span");
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▾";
  head.appendChild(headText);
  head.appendChild(caret);
  const list = document.createElement("div");
  list.className = "dd-list";
  dd.appendChild(head);
  dd.appendChild(list);
  $(mountId).appendChild(dd);

  function refreshHead() {
    const cur = String(getValue());
    const sel = getOptions().find((o) => String(o.value) === cur);
    const label = sel ? sel.label : "—";
    if (headText.textContent !== label) headText.textContent = label;
  }
  function buildList() {
    const cur = String(getValue());
    list.innerHTML = "";
    for (const o of getOptions()) {
      const item = document.createElement("div");
      item.className = "dd-item" + (String(o.value) === cur ? " sel" : "");
      item.textContent = o.label;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        dd.classList.remove("open");
        setValue(o.value);
        refreshHead();
      });
      list.appendChild(item);
    }
  }
  head.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = dd.classList.contains("open");
    closeAllDropdowns();
    if (!wasOpen) { buildList(); dd.classList.add("open"); }
  });
  refreshHead();
  return {
    refresh: refreshHead,
    setDisabled(b) { dd.classList.toggle("disabled", !!b); }
  };
}

// On/off pill toggle (was a checkbox; keeps the .chk class)
function checkbox(mountId, label, getValue, setValue) {
  const el = document.createElement("div");
  el.className = "chk";
  const box = document.createElement("span");
  box.className = "sw";                    // pill toggle with a small switch
  const txt = document.createElement("span");
  txt.className = "txt";
  txt.textContent = label;
  el.appendChild(box);
  el.appendChild(txt);
  $(mountId).appendChild(el);
  const refresh = () => el.classList.toggle("on", !!getValue());
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllDropdowns();
    setValue(!getValue());
    refresh();
  });
  refresh();
  return { refresh };
}

// A row with the label on the left and a switch on the right.
function switchRow(mountId, label, getValue, setValue) {
  const row = document.createElement("div");
  row.className = "setrow";
  const l = document.createElement("span");
  l.className = "l";
  l.textContent = label;
  const sw = document.createElement("span");
  sw.className = "switch";
  row.appendChild(l);
  row.appendChild(sw);
  $(mountId).appendChild(row);
  const refresh = () => sw.classList.toggle("on", !!getValue());
  sw.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllDropdowns();
    setValue(!getValue());
    refresh();
  });
  refresh();
  return { refresh };
}

// A row of options where one is picked (Low / Default / High).
function segmented(mountId, options, getValue, setValue) {
  const box = document.createElement("div");
  box.className = "qsel";
  const items = options.map((o) => {
    const el = document.createElement("div");
    el.className = "q";
    el.textContent = o.label;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      setValue(o.value);
      refresh();
    });
    box.appendChild(el);
    return el;
  });
  $(mountId).appendChild(box);
  const refresh = () => items.forEach((el, i) => el.classList.toggle("on", String(options[i].value) === String(getValue())));
  refresh();
  return { refresh };
}

// Buttons are divs, so a focused button can never be re-fired by Space/Enter.
function onClick(el, fn) {
  if (typeof el === "string") el = $(el);
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllDropdowns();
    if (el.classList.contains("disabled")) return;
    ui.lastClicked = el;
    ui.lastClickedAt = Date.now();
    fn(e);
  });
}

// [getter, setter] for a setting; `after` runs once it's saved.
function bind(key, after) {
  return [() => settings.get()[key], (v) => { settings.set(key, v); if (after) after(v); }];
}

// Update text only when it changed (every change makes Photoshop re-layout the
// panel), and hide the element while it's empty.
function setText(id, s) {
  const el = $(id);
  s = s || "";
  if (el.textContent !== s) el.textContent = s;
  el.classList.toggle("hidden", !s);
}

// Show a message in a bubble right under the control it's about (by default
// the last thing clicked). It floats over the page, so nothing shifts.
function toast(msg, anchor) {
  const b = $("bubble");
  if (ui.toastTimer) { clearTimeout(ui.toastTimer); ui.toastTimer = null; }
  if (!msg) { b.classList.add("hidden"); return; }
  const view = $("view-" + ui.view);
  let a = anchor || ui.lastClicked;
  let ok = false;
  try { ok = !!a && view.contains(a) && !a.classList.contains("hidden"); } catch (e) { ok = false; }
  if (!ok) a = ui.view === "main" ? $("btnRecord") : view.firstElementChild;
  setText("bubbleText", msg);
  b.classList.remove("hidden");
  try {
    const sc = $("scroller");
    const sr = sc.getBoundingClientRect(), ar = a.getBoundingClientRect();
    b.style.top = Math.round(ar.bottom - sr.top + sc.scrollTop + 8) + "px";
    const x = ar.left + ar.width / 2 - sr.left - 10 - 5;           // arrow under the control's centre
    b.querySelector(".bubble-arrow").style.left = Math.round(Math.max(10, Math.min(x, sr.width - 42))) + "px";
  } catch (e) { b.style.top = "0px"; }
  ui.toastTimer = setTimeout(() => b.classList.add("hidden"), 7000);
}

function confirmBox(text, okLabel) {
  return new Promise((resolve) => {
    setText("modalText", text);
    setText("modalOk", okLabel || "OK");
    $("modal").classList.remove("hidden");
    const done = (v) => {
      $("modal").classList.add("hidden");
      $("modalOk").onclick = null;
      $("modalCancel").onclick = null;
      resolve(v);
    };
    $("modalOk").onclick = (e) => { e.stopPropagation(); done(true); };
    $("modalCancel").onclick = (e) => { e.stopPropagation(); done(false); };
  });
}

// Through the launcher, so Photoshop's remembered permission applies (launcher.js).
async function openPath(p) {
  if (!p) return;
  try {
    const err = await launcher.open(p);
    if (err) toast("Couldn't open it: " + err);
  } catch (e) { toast("Couldn't open it: " + errText(e)); }
}

function isWindows() {
  try { return require("os").platform() === "win32"; } catch (e) { /* fall through */ }
  try { return /win/i.test(navigator.platform); } catch (e) { return true; }
}

/* ---------------- options ---------------- */

const secs = (list) => list.map((v) => ({ value: v, label: v + " s" }));
const LENGTH_OPTS = [{ value: "auto", label: "Auto" }].concat([10, 15, 20, 30, 45, 60, 90, 120, 180, 300].map((v) => ({
  value: v, label: v < 60 ? v + " seconds" : (v % 60 ? (v / 60).toFixed(1) : v / 60) + " min"
})));
const INTRO_OPTS = secs([0.5, 1, 1.5, 2, 3, 5]);
const HOLD_OPTS = secs([1, 2, 3, 4, 5, 8, 10]);
const CORNER_OPTS = [
  { value: "br", label: "Bottom right" }, { value: "bl", label: "Bottom left" },
  { value: "tr", label: "Top right" }, { value: "tl", label: "Top left" }
];
const ENCODER_OPTS = [{ value: "ffmpeg", label: "ffmpeg (fast)" }, { value: "photoshop", label: "Photoshop (slower)" }];
const LETTERBOX_OPTS = [{ value: "black", label: "Black" }, { value: "white", label: "White" }, { value: "gray", label: "Dark grey" }];
const QUALITY_OPTS = [{ value: "low", label: "Low" }, { value: "default", label: "Default" }, { value: "high", label: "High" }];
const QUALITY_DESC = {
  low: "Smaller files and the quickest capturing. Fine for quick sketches and previews.",
  default: "Full-HD video, good for social media. Recommended.",
  high: "Sharper video for big screens. Uses about twice the disk space."
};
// Reference-layer name tags to choose from (plus whatever is saved, if it's something else)
const TAGS = ["[ref]", "[reference]", "(ref)", "#ref", "_ref"];
function tagOptions() {
  const cur = settings.get().excludeTag || "[ref]";
  const list = TAGS.indexOf(cur) >= 0 ? TAGS : [cur].concat(TAGS);
  return list.map((v) => ({ value: v, label: v }));
}
const IDLE_OPTS = [5, 10, 15, 20, 30, 45, 60].map((v) => ({ value: v, label: v === 60 ? "1 minute" : v + " seconds" }));

/* ---------------- controls ---------------- */

const c = {};   // control handles

function buildControls() {
  const exportChanged = () => renderExportSettings();

  // quick export (main page) and export settings share the length setting
  c.lengthQuick = dropdown("ddLengthQuick", () => LENGTH_OPTS, ...bind("lengthSec", () => { c.length.refresh(); renderQuickEstimate(); }));
  c.length = dropdown("ddLength", () => LENGTH_OPTS, ...bind("lengthSec", () => { c.lengthQuick.refresh(); exportChanged(); }));
  c.intro = checkbox("chkIntro", "Show finished drawing first", ...bind("introOn", exportChanged));
  c.introSec = dropdown("ddIntro", () => INTRO_OPTS, ...bind("introSec", exportChanged));
  c.flash = checkbox("chkFlash", "Flash before the final image", ...bind("flashOn", exportChanged));
  c.hold = checkbox("chkHold", "Hold final image", ...bind("holdOn", exportChanged));
  c.holdSec = dropdown("ddHold", () => HOLD_OPTS, ...bind("holdSec", exportChanged));
  c.slow = checkbox("chkSlow", "Slow down at the end", ...bind("slowEnd", exportChanged));
  c.deflicker = checkbox("chkDeflicker", "Remove flicker", ...bind("deflicker", exportChanged));
  c.timer = checkbox("chkTimer", "Show work-time counter", ...bind("timerOverlay", exportChanged));
  c.corner = dropdown("ddCorner", () => CORNER_OPTS, ...bind("timerCorner", exportChanged));
  c.encoder = dropdown("ddEncoder", () => ENCODER_OPTS, ...bind("encoder", exportChanged));
  c.letterbox = dropdown("ddLetterbox", () => LETTERBOX_OPTS, ...bind("letterbox", exportChanged));

  c.quality = segmented("segQuality", QUALITY_OPTS, ...bind("quality", () => renderSettings()));
  c.undo = switchRow("swUndo", "Remove frames with undo", ...bind("hideUndone", scheduleRender));
  c.auto = checkbox("chkAuto", "Auto record", ...bind("autoRecord", (on) => autoRecordChanged(on)));
  c.idle = dropdown("ddIdle", () => IDLE_OPTS, ...bind("idleSec"));
  c.useRemembered = checkbox("chkUseRemembered", "Use remembered folder", ...bind("useRemembered"));
  c.remember = checkbox("chkRemember", "Remember this folder",
    () => !!(ui.lastExport && ui.lastExport.remembered),
    (on) => toggleRemember(on));

  c.tag = dropdown("ddTag", tagOptions, () => settings.get().excludeTag || "[ref]", (v) => { settings.set("excludeTag", v); renderMain(); });
}

function wire() {
  document.addEventListener("click", closeAllDropdowns);
  $("bubble").addEventListener("click", (e) => { e.stopPropagation(); toast(""); });

  // Photoshop panels don't scroll with the mouse wheel on their own: size the
  // scroll box under the tabs and scroll it ourselves.
  const sc = $("scroller");
  const fitScroller = () => {
    try { sc.style.top = Math.round(document.querySelector(".tabs").getBoundingClientRect().bottom + 6) + "px"; } catch (e) { /* keep CSS value */ }
  };
  fitScroller();
  setTimeout(fitScroller, 300);
  window.addEventListener("resize", fitScroller);
  let lastWheel = 0;
  const onWheel = (e) => {
    const now = Date.now();
    if (now - lastWheel < 5) return;              // same wheel step seen through both event names
    lastWheel = now;
    let dy = typeof e.deltaY === "number" && e.deltaY !== 0 ? e.deltaY : -(e.wheelDelta || 0);
    if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= sc.clientHeight;
    if (!dy) return;
    sc.scrollTop += dy;
    if (e.cancelable) e.preventDefault();
  };
  document.addEventListener("wheel", onWheel, true);
  document.addEventListener("mousewheel", onWheel, true);

  onClick("btnCollapse", () => { ui.collapsed = !ui.collapsed; renderMain(); });

  onClick("btnRecord", async () => {
    try { await recorder.toggleActive(); } catch (e) { toast("Couldn't start recording: " + errText(e)); }
    renderMain();
  });
  onClick("btnPreview", () => { settings.set("showPreview", !settings.get().showPreview); renderMain(); });
  const setRef = async (want) => {
    try { await recorder.toggleReference(want); } catch (e) { toast("Couldn't change the layer: " + errText(e)); }
    renderMain();
  };
  onClick("segNormal", () => setRef(false));
  onClick("segRef", () => setRef(true));

  onClick("btnExportOpen", () => {
    $("exportBox").classList.toggle("hidden");
    renderMain();
  });
  onClick("btnAdvanced", () => showView("export"));
  onClick("btnConfirm", doExport);
  onClick("btnCancelExport", () => { ui.cancel = true; setText("exportStatus", "Cancelling…"); });
  onClick("btnPlay", () => openPath(ui.lastExport && ui.lastExport.file));
  onClick("btnOpenOut", () => openPath(ui.lastExport && ui.lastExport.folderPath));

  document.querySelectorAll(".tab").forEach((tb) => onClick(tb, () => showView(tb.getAttribute("data-tab"))));
  document.querySelectorAll(".back").forEach((b) => onClick(b, () => showView("main")));

  onClick("btnRefresh", async () => { await store.scan(recorder.openRecIds()); renderLibrary(); });
  onClick("btnOpenRoot", () => openPath(store.rootPath()));

  onClick("btnChooseRoot", async () => {
    try {
      if (!(await store.chooseRoot())) return;
      await recorder.rootChanged();
      toast("Recordings are saved in " + store.rootPath());
    } catch (e) { toast("Couldn't use that folder: " + errText(e)); }
    renderSettings();
  });
}

function showView(name) {
  ui.view = name;
  toast("");
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.id !== "view-" + name));
  const tabName = name === "export" ? "main" : name;       // export settings live under the Record tab
  document.querySelectorAll(".tab").forEach((tb) => tb.classList.toggle("on", tb.getAttribute("data-tab") === tabName));
  if (name === "library") renderLibrary();
  if (name === "export") renderExportSettings();
  if (name === "settings") renderSettings();
  renderMain();
}

/* ---------------- main page ---------------- */

function scheduleRender() {
  if (ui.renderTimer) return;
  ui.renderTimer = setTimeout(() => {
    ui.renderTimer = null;
    const t0 = Date.now();
    renderMain();
    if (ui.view === "export") renderEstimate();
    if (Date.now() - t0 > 40) diag.log("panel update took " + (Date.now() - t0) + "ms");
  }, 60);
}

// The recording of the document you're on (the one Export uses).
function activeRec() {
  const s = recorder.activeState().session;
  return s ? store.get(s.recId) : null;
}

function renderMain() {
  const st = recorder.activeState();
  const s = st.session;

  // dot on the Record tab: green while the document you're on is recording, yellow otherwise
  $("tabDot").classList.toggle("idle", !(s && s.recording));
  if (ui.view !== "main") return;

  // record button: Start recording / Recording (green, click to pause) / Paused (grey, click to resume)
  const btn = $("btnRecord");
  let label, btnCls = "btn big", iconCls = "ico-dot", tip = "";
  if (!st.hasDoc) {
    label = "Start recording"; btnCls += " disabled";
  } else if (s && s.recording) {
    label = "Recording"; btnCls += " live"; iconCls = "ico-live"; tip = "Click to pause";
  } else if (s) {
    label = "Paused"; btnCls += " paused"; iconCls = "ico-pause"; tip = "Click to resume recording";
  } else {
    label = "Start recording";
  }
  if (btn.className !== btnCls) btn.className = btnCls;
  const icon = $("btnRecordIcon");
  if (icon.className.replace(" dim", "") !== iconCls) icon.className = iconCls;
  setText("btnRecordText", label);
  if (btn.title !== tip) btn.title = tip;
  setText("recHint", !st.hasDoc ? "Open a document to record it."
    : !s && !st.hasRoot ? "You'll be asked where to save recordings." : "");

  // stats
  setText("stFrames", s ? fmtInt(s.frames) : "–");
  setText("stWork", s ? fmtClock(s.workMs) : "–");
  setText("stIdle", s && s.idle ? "idle" : "");
  setText("stDisk", s ? fmtBytes(s.bytes) : "–");

  // document bar: which file this is about
  setText("recText", st.hasDoc ? st.docName : "No document open");

  // optional live preview
  const showPreview = !!settings.get().showPreview;
  $("btnPreview").classList.toggle("hidden", !st.hasDoc);
  setText("previewArrow", showPreview ? "▾" : "▸");
  $("btnPreview").title = showPreview ? "Hide the live preview" : "Show the newest frame";
  $("previewBox").classList.toggle("hidden", !showPreview);
  if (showPreview) {
    const img = $("previewImg");
    if (s && s.preview) {
      if (ui.lastPreview !== s.preview) { img.src = "data:image/jpeg;base64," + s.preview; ui.lastPreview = s.preview; }
      img.classList.remove("hidden");
      $("previewEmpty").classList.add("hidden");
    } else {
      ui.lastPreview = null;
      img.classList.add("hidden");
      $("previewEmpty").classList.remove("hidden");
      setText("previewEmpty", s && s.recording ? "No frames yet — just start drawing" : "No frames yet");
    }
  }

  // reference layer: the selected layer, and Normal / Reference
  const ref = recorder.referenceState();
  setText("refLayer", !st.hasDoc ? "No document open" : !ref.count ? "No layer selected"
    : ref.count > 1 ? ref.count + " layers selected" : ref.name || "Layer");
  $("refLayer").classList.toggle("none", !ref.count);
  setText("refState", !ref.count ? "" : ref.tagged ? "Not recorded"
    : ref.some ? ref.some + " of " + ref.count + " not recorded" : "Recorded");
  $("refChip").classList.toggle("ref", ref.some > 0);
  $("refSeg").classList.toggle("disabled", !st.hasDoc);
  $("segNormal").classList.toggle("on", ref.count > 0 && !ref.some);
  $("segRef").classList.toggle("on", ref.tagged);
  $("segRef").classList.toggle("green", ref.tagged);

  // export button: Export video / Export again / Cancel (closes the export box)
  const rec = s ? store.get(s.recId) : null;
  const canExport = !!(rec && recorder.liveFrameCount(rec));
  if (!canExport) $("exportBox").classList.add("hidden");
  const boxOpen = !$("exportBox").classList.contains("hidden");
  const ex = $("btnExportOpen");
  const exLabel = boxOpen ? "Cancel" : rec && rec.meta.exports && rec.meta.exports.length ? "Export again" : "Export video";
  if (ex.textContent !== exLabel) ex.textContent = exLabel;
  const exCls = "btn mid" + (boxOpen ? " cancel" : " primary") + (!canExport || ui.exporting ? " disabled" : "");
  if (ex.className !== exCls) ex.className = exCls;
  if (boxOpen) renderQuickEstimate();
  const showArrow = !!ui.hasResults && !boxOpen && !ui.exporting;
  $("btnCollapse").classList.toggle("hidden", !showArrow);
  const arrow = ui.collapsed ? "\u25BE" : "\u25B4";
  if ($("btnCollapse").textContent !== arrow) $("btnCollapse").textContent = arrow;
  $("btnCollapse").title = ui.collapsed ? "Show the export results" : "Hide the export results";
  $("exportResults").classList.toggle("hidden", !!ui.collapsed && !ui.exporting);
}

function pulse() {
  const el = $("btnRecordIcon");
  if ($("btnRecord").classList.contains("live")) el.classList.toggle("dim");
  else el.classList.remove("dim");
}

// Auto record: needs a recordings folder, so ask for one when it's switched on.
async function autoRecordChanged(on) {
  if (on && !store.hasRoot()) {
    toast("Choose a folder for your recordings.");
    let ok = false;
    try { ok = await store.chooseRoot(); } catch (e) { /* treated as cancelled */ }
    if (!ok) { settings.set("autoRecord", false); c.auto.refresh(); toast("Auto record needs a folder to save recordings in."); return; }
    await recorder.rootChanged();
    renderSettings();
  }
  if (on) recorder.autoCheck();
  renderMain();
}

/* ---------------- export ---------------- */

function renderQuickEstimate() {
  c.lengthQuick.refresh();
  const rec = activeRec();
  const est = rec ? exporter.estimate(rec, settings.get()) : null;
  let line = est ? "≈ " + fmtSeconds(est.seconds) + " video from " + fmtInt(est.sourceFrames) + " frames." : "";
  if (est) {
    const ms = exporter.exportTimeEstimate(rec, settings.get());
    line += " Exporting takes about " + (ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + " s" : Math.round(ms / 60000) + " min") + ".";
  }
  setText("quickEstimate", line);
  $("btnConfirm").classList.toggle("disabled", !est || ui.exporting);
  const st = settings.get();
  $("rowUseRemembered").classList.toggle("hidden", !st.rememberPath);
  setText("rememberedPath", st.rememberPath);
  c.useRemembered.refresh();
}

function dirOf(p) { return String(p || "").replace(/[\\/][^\\/]*$/, ""); }
function samePath(a, b) { return !!a && !!b && a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase(); }

// Where the video goes: the remembered folder (if ticked), otherwise a save dialog.
async function pickTarget(rec) {
  const base = fileSafe(rec.meta.name) + " timelapse";
  const st = settings.get();
  if (st.useRemembered && st.rememberToken) {
    try {
      const folder = await lfs.getEntryForPersistentToken(st.rememberToken);
      let name = base + ".mp4";
      for (let i = 2; await store.tryGet(folder, name); i++) name = base + " " + i + ".mp4";
      return await folder.createFile(name, { overwrite: false });
    } catch (e) {
      toast("Couldn't use the remembered folder — choose where to save instead.");
    }
  }
  return lfs.getFileForSaving(base + ".mp4", { types: ["mp4"] });
}

// A folder entry for a path; falls back to asking if Photoshop can't open it directly.
async function folderEntryFor(p) {
  if (lfs.getEntryWithUrl) {
    const fwd = p.replace(/\\/g, "/").replace(/^\/+/, "");
    for (const url of ["file:/" + fwd, "file:///" + fwd]) {
      try { const e = await lfs.getEntryWithUrl(url); if (e && e.isFolder) return e; } catch (e) { /* try the next form */ }
    }
  }
  toast("Choose the folder to remember.");
  return lfs.getFolder();
}

async function toggleRemember(on) {
  const ex = ui.lastExport;
  if (!on) {
    settings.set("rememberToken", "");
    settings.set("rememberPath", "");
    settings.set("useRemembered", false);
    if (ex) ex.remembered = false;
  } else if (ex && ex.outFolder) {
    try {
      const folder = await folderEntryFor(ex.outFolder);
      if (folder) {
        settings.set("rememberToken", await lfs.createPersistentToken(folder));
        settings.set("rememberPath", folder.nativePath);
        settings.set("useRemembered", true);
        ex.remembered = true;
        toast("Remembered. Tick “Use remembered folder” when exporting to save there straight away.");
      }
    } catch (e) { toast("Couldn't remember that folder: " + errText(e)); }
  }
  c.remember.refresh();
}

function renderExportSettings() {
  for (const k of ["length", "intro", "introSec", "flash", "hold", "holdSec", "slow", "deflicker", "timer", "corner", "encoder", "letterbox"]) c[k].refresh();
  const st = settings.get();
  c.introSec.setDisabled(!st.introOn);
  c.holdSec.setDisabled(!st.holdOn);
  c.corner.setDisabled(!st.timerOverlay);
  renderEstimate();
}

function renderEstimate() {
  const box = $("estimate");
  const lines = [];
  const add = (cls, text) => lines.push([cls, text]);
  const flush = () => {                     // rebuild only when the text changed
    const key = JSON.stringify(lines);
    if (box.getAttribute("data-key") === key) return;
    box.setAttribute("data-key", key);
    box.innerHTML = "";
    for (const [cls, text] of lines) { const d = document.createElement("div"); d.className = cls; d.textContent = text; box.appendChild(d); }
  };
  const rec = activeRec();
  const est = rec ? exporter.estimate(rec, settings.get()) : null;
  if (!est) { add("note", "Record something in this document to see how long the video will be."); flush(); return; }
  const st = settings.get();
  add("big", "≈ " + fmtSeconds(est.seconds) + " video");
  add("note", fmtInt(est.sourceFrames) + " recorded frames · " + est.width + "×" + est.height);
  if (st.lengthSec === "auto") add("note", "Auto shows every frame once (at least 5 s, at most 1 min).");
  if (est.resized) add("note", "The canvas size changed during recording; earlier frames are fitted inside the final size.");
  if (st.timerOverlay || st.flashOn || (est.resized && st.encoder !== "ffmpeg")) add("note", "Frames that need redrawing make the export slower.");
  if (st.deflicker) {
    add("note", "Remove flicker leaves out frames that flash in and out (a layer hidden for a moment, a stroke undone right away), so the video can be a bit shorter.");
    if (est.uncheckedFrames > 1000) add("note", "The first check of " + fmtInt(est.uncheckedFrames) + " frames takes about " + fmtSeconds(est.uncheckedFrames * 0.007 + 1.5) + "; after that only new frames are checked.");
  }
  if (st.encoder === "ffmpeg" && ui.ffmpegSource === "path") add("note", "No ffmpeg found with the plugin — it has to be installed on your PC (see Settings).");
  flush();
}

async function doExport() {
  if (ui.exporting) return;
  const rec = activeRec();
  if (!rec || !recorder.liveFrameCount(rec)) { toast("Nothing recorded in this document yet."); return; }
  let target;
  try {
    target = await pickTarget(rec);
  } catch (e) { toast("Couldn't open the save dialog: " + errText(e)); return; }
  if (!target) return;                                   // cancelled

  ui.exporting = true;
  ui.hasResults = false;
  ui.collapsed = false;
  recorder.setAutoPaused(true);     // don't auto-record the frame sequence Photoshop opens
  ui.cancel = false;
  ui.lastExport = null;
  $("exportBox").classList.add("hidden");
  $("btnExportOpen").classList.add("disabled");
  $("exportProgress").classList.remove("hidden");
  $("btnCancelExport").classList.remove("hidden");
  $("exportActions").classList.add("hidden");
  $("exportBar").style.width = "0%";
  try {
    await recorder.flush(rec.id);
    const res = await exporter.run(rec, settings.get(), target, {
      progress: (f, text) => {
        $("exportBar").style.width = Math.round(Math.min(1, f) * 100) + "%";
        if (text && !ui.cancel) setText("exportStatus", text);
      },
      cancelled: () => ui.cancel
    });
    res.outFolder = dirOf(target.nativePath);
    res.remembered = samePath(settings.get().rememberPath, res.outFolder);
    ui.lastExport = res;
    setText("exportStatus", res.message);
    $("btnPlay").classList.toggle("hidden", !res.file);
    $("chkRemember").classList.remove("hidden");
    c.remember.refresh();
    $("exportActions").classList.remove("hidden");
  } catch (e) {
    if (e && e.cancelled) {
      setText("exportStatus", "Export cancelled.");
    } else {
      setText("exportStatus", "Export failed: " + errText(e));
      if (e && e.folderPath) {
        ui.lastExport = { folderPath: e.folderPath };
        $("btnPlay").classList.add("hidden");
        $("chkRemember").classList.add("hidden");
        $("exportActions").classList.remove("hidden");
      }
    }
  } finally {
    ui.exporting = false;
    ui.hasResults = true;
    recorder.setAutoPaused(false);
    $("exportProgress").classList.add("hidden");
    $("btnCancelExport").classList.add("hidden");
    renderMain();
  }
}

/* ---------------- library ---------------- */

function lastExport(h) {
  const ex = h.meta.exports || [];
  return ex.length ? ex[ex.length - 1] : null;
}

function renderLibrary() {
  const rootEl = $("libRoot");
  rootEl.textContent = store.rootPath() || "Not chosen yet — see Settings";
  rootEl.classList.toggle("empty", !store.hasRoot());
  $("btnOpenRoot").classList.toggle("disabled", !store.hasRoot());

  const list = store.list();
  const total = list.reduce((a, h) => a + (h.meta.bytes || 0), 0);
  // "1.7 GB · 7 recordings", the size in large type
  const tot = $("libTotal");
  tot.innerHTML = "";
  if (list.length) {
    const b = document.createElement("b");
    b.textContent = fmtBytes(total);
    tot.appendChild(b);
    tot.appendChild(document.createTextNode("· " + list.length + (list.length === 1 ? " recording" : " recordings")));
  }

  const host = $("libList");
  host.innerHTML = "";
  if (!list.length) {
    const e = document.createElement("div");
    e.className = "empty-state";
    e.textContent = store.hasRoot() ? "No recordings yet." : "Recordings will be listed here once you've chosen a folder.";
    host.appendChild(e);
    return;
  }
  for (const h of list) {
    const item = document.createElement("div");
    item.className = "lib-item";

    const name = document.createElement("div");
    name.className = "lib-name";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = h.meta.name;
    name.appendChild(nm);
    const tags = document.createElement("span");
    tags.className = "tags";
    name.appendChild(tags);
    const addTag = (cls, text) => { const t = document.createElement("span"); t.className = "tag " + cls; t.textContent = text; tags.appendChild(t); };
    if (recorder.isRecordingRec(h.id)) addTag("rec", "REC");
    const ex = lastExport(h);
    if (ex) addTag("done", "EXPORTED");
    else if (h.meta.frames.length) addTag("todo", "NOT EXPORTED");
    item.appendChild(name);

    const work = recorder.currentWork(h.id);
    const meta = document.createElement("div");
    meta.className = "lib-meta";
    meta.textContent = fmtInt(recorder.liveFrameCount(h)) + " frames · " + fmtBytes(h.meta.bytes || 0) +
      " · " + fmtClock(work === null ? h.meta.workMs : work) + " work · recorded " + fmtAgo(h.meta.recorded) +
      (ex ? " · exported " + fmtAgo(ex.t) : "");
    item.appendChild(meta);
    if (ex && h.meta.frames.length > (ex.frames || 0)) {
      const note = document.createElement("div");
      note.className = "lib-meta";
      note.textContent = "Recorded more since the last export.";
      item.appendChild(note);
    }

    const row = document.createElement("div");
    row.className = "btnrow centered";
    const mk = (label, cls, fn) => {
      const b = document.createElement("div");
      b.className = "btn small" + (cls ? " " + cls : "");
      b.textContent = label;
      onClick(b, fn);
      row.appendChild(b);
      return b;
    };
    mk("Open folder", "", () => openPath(h.folder.nativePath));
    if (h.meta.frames.length) {
      mk("Delete frames", "danger", () => clearFrames(h));
    } else {
      // frames already deleted: the recording itself can go
      const del = mk("Delete folder", "danger", () => deleteRecording(h));
      if (recorder.isRecordingRec(h.id)) { del.classList.add("disabled"); del.title = "Pause the recording first"; }
    }
    item.appendChild(row);
    host.appendChild(item);
  }
}

async function clearFrames(h) {
  const ex = lastExport(h);
  const size = fmtInt(h.meta.frames.length) + " frames (" + fmtBytes(h.meta.bytes || 0) + ")";
  let text;
  if (!ex) {
    text = "“" + h.meta.name + "” hasn't been exported yet. If you delete its " + size +
      ", you can't make a video of it anymore. This can't be undone.";
  } else {
    text = "Delete the " + size + " of “" + h.meta.name + "”? It was exported " + fmtAgo(ex.t) + "." +
      (h.meta.frames.length > (ex.frames || 0) ? " You've recorded more since then, and that part isn't in the video." : "") +
      " Your videos and the work timer are kept. This can't be undone.";
  }
  if (!(await confirmBox(text, "Delete frames"))) return;
  toast("Deleting frames…");
  try {
    await store.clearFrames(h);
    recorder.afterClear(h.id);
    toast("Frames deleted.");
  } catch (e) { toast("Couldn't delete all frames: " + errText(e)); }
  renderLibrary();
}

async function deleteRecording(h) {
  const text = "Delete “" + h.meta.name + "” and its folder? It's removed from the library, along with its work time. " +
    "Videos you exported stay where you saved them. This can't be undone.";
  if (!(await confirmBox(text, "Delete folder"))) return;
  try {
    recorder.forget(h.id);
    await store.deleteRecording(h);
    toast("Deleted “" + h.meta.name + "”.");
  } catch (e) { toast("Couldn't delete the whole folder: " + errText(e)); }
  renderLibrary();
  scheduleRender();
}

/* ---------------- settings ---------------- */

function renderSettings() {
  const st = settings.get();
  const rootEl = $("setRoot");
  rootEl.textContent = store.rootPath() || "Not chosen yet";
  rootEl.classList.toggle("empty", !store.hasRoot());
  setText("btnChooseRoot", store.hasRoot() ? "Change folder…" : "Choose folder…");
  for (const k of ["quality", "undo", "tag", "idle"]) c[k].refresh();
  setText("qualityDesc", QUALITY_DESC[st.quality] || "");
}

/* ---------------- init ---------------- */

async function init() {
  setText("version", "v" + VERSION);
  buildControls();
  wire();
  try { await store.init(); }
  catch (e) { toast("Couldn't open the recordings folder: " + errText(e)); }
  // a message right after a click is about that button; otherwise (e.g. "Resumed recording") the record button
  recorder.init({ onChange: scheduleRender, onMessage: (m) => toast(m,
    Date.now() - (ui.lastClickedAt || 0) < 3000 ? ui.lastClicked : ui.view === "main" ? $("btnRecord") : null) });
  exporter.findFfmpeg(settings.get()).then((f) => { ui.ffmpegSource = f.source; }).catch(() => {});
  renderSettings();
  renderMain();
  setInterval(pulse, 600);
}

init();
