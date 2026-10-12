// Loads the real panel (index.html + main.js) in jsdom with mock Photoshop/UXP
// and clicks through it, failing on any runtime error.
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");
const { JSDOM } = require("jsdom");
const jpegEncode = require("jpeg-js").encode;
const SRC = path.join(__dirname, "..", "src");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- storage mock ---- */
class Entry {
  constructor(p) { this.nativePath = p; this.name = path.basename(p); }
  get isFile() { return fs.existsSync(this.nativePath) && fs.statSync(this.nativePath).isFile(); }
  get isFolder() { return fs.existsSync(this.nativePath) && fs.statSync(this.nativePath).isDirectory(); }
  async delete() { if (this.isFolder) fs.rmdirSync(this.nativePath); else fs.unlinkSync(this.nativePath); }
  async moveTo(folder, o) { const d = path.join(folder.nativePath, (o && o.newName) || this.name); fs.renameSync(this.nativePath, d); this.nativePath = d; }
}
class File extends Entry {
  async read(o) { const b = fs.readFileSync(this.nativePath); return o && o.format === "binary" ? b.buffer.slice(b.byteOffset, b.byteOffset + b.length) : b.toString("utf8"); }
  async write(d, o) { if (o && o.format === "binary") fs.writeFileSync(this.nativePath, Buffer.from(new Uint8Array(d))); else fs.writeFileSync(this.nativePath, d, "utf8"); }
}
class Folder extends Entry {
  async getEntries() { return fs.readdirSync(this.nativePath).map((n) => wrap(path.join(this.nativePath, n))); }
  async getEntry(n) { const p = path.join(this.nativePath, n); if (!fs.existsSync(p)) throw new Error("nf"); return wrap(p); }
  async createFile(n) { const p = path.join(this.nativePath, n); fs.writeFileSync(p, ""); return new File(p); }
  async createFolder(n) { const p = path.join(this.nativePath, n); fs.mkdirSync(p); return new Folder(p); }
}
const wrap = (p) => (fs.statSync(p).isDirectory() ? new Folder(p) : new File(p));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tlr-ui-"));
const ROOT = path.join(TMP, "Recordings"); fs.mkdirSync(ROOT);
const opened = [];
// Imitates ffmpeg started through make_video.vbs: reports progress, writes the video, exit code.
const ffRuns = [];
let ffFail = false;
function fakeFfmpeg(vbsPath) {
  const dir = path.dirname(vbsPath);
  const bat = fs.readFileSync(path.join(dir, "make_video.bat"), "utf8");
  const out = bat.match(/"([^"]+\.mp4)"/)[1];
  const render = path.join(dir, "_render");
  const frames = fs.readdirSync(render).filter((f) => f.startsWith("frame_")).sort();
  const snap = fs.mkdtempSync(path.join(os.tmpdir(), "tlr-ffsnap-"));
  for (const f of frames) fs.copyFileSync(path.join(render, f), path.join(snap, f));
  ffRuns.push({ bat, out, frames: frames.length, snap });
  setTimeout(() => fs.writeFileSync(path.join(render, "progress.txt"), "frame=" + Math.floor(frames.length / 2) + "\nprogress=continue\n"), 150);
  setTimeout(() => {
    if (ffFail) { fs.writeFileSync(path.join(render, "ffmpeg_log.txt"), "Unknown encoder 'libx264'\n"); fs.writeFileSync(path.join(render, "done.txt"), "1\r\n"); return; }
    fs.writeFileSync(out, "ffmpeg mp4");
    fs.writeFileSync(path.join(render, "progress.txt"), "frame=" + frames.length + "\nprogress=end\n");
    fs.writeFileSync(path.join(render, "done.txt"), "0\r\n");
  }, 500);
}
const PLUGIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tlr-plugin-"));
fs.mkdirSync(path.join(PLUGIN_DIR, "bin")); fs.writeFileSync(path.join(PLUGIN_DIR, "bin", "ffmpeg.exe"), "");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tlr-data-"));
const shellCalls = [];   // what Photoshop was asked to open (on Windows: always the launcher)
// `opened` gets what was actually run or opened, whether through the launcher or directly
function startTarget(p) { opened.push(p); if (p.endsWith(".bat")) fakeFfmpeg(p); }
// Does what the launcher's "Timelapse Recorder.vbs" does with the jobs it finds.
function runLauncher(script) {
  const jobs = path.join(path.dirname(script), "jobs");
  for (const n of fs.readdirSync(jobs).filter((n) => n.endsWith(".job")).sort()) {
    const [, target] = fs.readFileSync(path.join(jobs, n), "utf8").split("\n");
    fs.unlinkSync(path.join(jobs, n));
    startTarget(target);
  }
}

const saveAsked = [];
let saveAnswer;
const uxpMock = {
  storage: {
    formats: { utf8: "utf8", binary: "binary" },
    localFileSystem: {
      getFolder: async () => new Folder(ROOT),
      createPersistentToken: async (e) => "tok:" + e.nativePath,
      getEntryForPersistentToken: async (t) => new Folder(t.slice(4)),
      createSessionToken: (e) => "sess:" + e.nativePath,
      getFileForOpening: async () => new File("C:\\tools\\ffmpeg\\bin\\ffmpeg.exe"),
      getPluginFolder: async () => new Folder(PLUGIN_DIR),
      getDataFolder: async () => new Folder(DATA_DIR),
      getEntryWithUrl: async (url) => { const p = path.normalize(url.replace(/^file:\/*/, "")); if (!fs.existsSync(p)) throw new Error("nf"); return wrap(p); },
      getFileForSaving: async (name) => { saveAsked.push(name); return saveAnswer === null ? null : new File(path.join(TMP, saveAnswer || name)); }
    }
  },
  shell: { openPath: async (p) => { shellCalls.push(p); if (p.endsWith("Timelapse Recorder.vbs")) runLauncher(p); else startTarget(p); return ""; }, openExternal: async (u) => { opened.push(u); return ""; } }
};

/* ---- photoshop mock ---- */
let hid = 1;
const app = { documents: [], activeDocument: null };
let listener = null;
function mkDoc(id, name) {
  const d = { id, name, title: name, path: "C:\\art\\" + name, xmp: "", width: 400, height: 300, layers: [], activeLayers: [],
    hist: [{ id: hid++, snapshot: false }], active: 0, color: 255 };
  Object.defineProperty(d, "historyStates", { get: () => d.hist.map((h) => ({ id: h.id, snapshot: h.snapshot })) });
  Object.defineProperty(d, "activeHistoryState", { get: () => d.hist[d.active] });
  d.edit = () => { d.color = (d.color + 97) % 256; d.hist = d.hist.slice(0, d.active + 1); d.hist.push({ id: hid++, snapshot: false }); d.active = d.hist.length - 1; };
  d.closeWithoutSaving = () => { app.documents.splice(app.documents.indexOf(d), 1); };
  return d;
}
const img = (px, w, h) => ({ width: w, height: h, components: 3, _px: px, getData: async () => px, dispose() {} });
const psMock = {
  app,
  action: {
    addNotificationListener: (e, fn) => { listener = fn; },
    batchPlay: async (cmds) => cmds.map((c) => {
      const d = c._target && c._target[1] && app.documents.find((x) => x.id === c._target[1]._id);
      if (c._obj === "get") return { XMPMetadataAsUTF8: d ? d.xmp : "" };
      if (c._obj === "set") { d.xmp = c.to.XMPMetadataAsUTF8; return {}; }
      if (c._obj === "open") { const s = mkDoc(900, "seq"); app.documents.push(s); return {}; }
      if (c._obj === "export") { fs.writeFileSync(path.join(c.using.directory._path.slice(5), c.using.name), "mp4"); return {}; }
      return {};
    })
  },
  core: { executeAsModal: async (fn) => fn({ hostControl: { suspendHistory: async () => 1, resumeHistory: async () => {} } }) },
  imaging: {
    getPixels: async (o) => {
      const d = app.documents.find((x) => x.id === o.documentID);
      const w = o.targetSize.width, h = o.targetSize.height;
      const px = new Uint8Array(w * h * 3).fill(d.color);
      return { imageData: img(px, w, h) };
    },
    encodeImageData: async ({ imageData, base64 }) => {
      const rgba = Buffer.alloc(imageData.width * imageData.height * 4, 255);
      for (let i = 0, o = 0; i < imageData._px.length; i += 3, o += 4) { rgba[o] = imageData._px[i]; rgba[o + 1] = imageData._px[i + 1]; rgba[o + 2] = imageData._px[i + 2]; }
      const jpg = jpegEncode({ data: rgba, width: imageData.width, height: imageData.height }, 85).data;
      return base64 ? jpg.toString("base64") : Array.from(jpg);
    },
    createImageDataFromBuffer: async (buf, o) => img(buf, o.width, o.height)
  }
};

/* ---- wire the module system ---- */
const origLoad = Module._load;
Module._load = function (req) {
  if (req === "photoshop") return psMock;
  if (req === "uxp") return uxpMock;
  return origLoad.apply(this, arguments);
};
const ls = new Map();
global.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) };
global.navigator = { platform: "Win32" };

const html = fs.readFileSync(path.join(SRC, "index.html"), "utf8").replace('<script src="main.js"></script>', "");
const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
const errors = [];
process.on("unhandledRejection", (e) => { errors.push(e); console.error("UNHANDLED", e); });

// main.js expects browser globals + require
global.document = doc;
const mainSrc = fs.readFileSync(path.join(SRC, "main.js"), "utf8");
const localRequire = (m) => (m === "uxp" ? uxpMock : m === "photoshop" ? psMock : m === "os" ? require("os") : require(path.join(SRC, m)));
Object.assign(localRequire("recorder.js")._timing, { settleMs: 350, maxWaitMs: 2500 });   // the tests' timings were written for these
new Function("require", "document", "navigator", "window", mainSrc)(localRequire, doc, global.navigator, window);

const $ = (id) => doc.getElementById(id);
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const text = (id) => $(id).textContent;
const visible = (id) => !$(id).classList.contains("hidden");
const back = () => click(doc.querySelector(".view:not(.hidden) .back"));
const tab = (name) => click(doc.querySelector('.tab[data-tab="' + name + '"]'));
const ddItems = (mountId) => { click($(mountId).querySelector(".dd-head")); return Array.from($(mountId).querySelectorAll(".dd-item")); };
// true if element a comes before element b on the page
const before = (a, b) => !!($(a).compareDocumentPosition($(b)) & window.Node.DOCUMENT_POSITION_FOLLOWING);
const saved = () => JSON.parse(ls.get("timelapseRecorder.settings.v2"));

(async () => {
  await sleep(300);
  assert.strictEqual(text("recText"), "No document open");
  assert.ok($("btnRecord").classList.contains("disabled"));
  assert.ok($("btnExportOpen").classList.contains("disabled"), "nothing to export yet");
  assert.ok(!visible("previewBox"), "preview off by default");
  assert.ok(before("chkAuto", "btnRecord"), "auto record above the record button");
  assert.ok($("chkAuto").querySelector(".chk .sw"), "auto record is a pill toggle");

  const d = mkDoc(1, "Forest.psd");
  d.layers = [{ name: "Background", visible: true }, { name: "Photo", visible: true }];
  app.documents.push(d); app.activeDocument = d;
  listener("open", {}); await sleep(1200);
  assert.strictEqual(text("recText"), "Forest.psd");
  assert.strictEqual(text("btnRecordText"), "Start recording");
  assert.ok(!$("refSeg").classList.contains("disabled"), "reference switch always clickable with a document open");
  assert.strictEqual(text("refLayer"), "No layer selected");
  assert.ok(!$("segNormal").classList.contains("on") && !$("segRef").classList.contains("on"), "nothing picked without a layer");
  click($("segRef")); await sleep(100);
  assert.ok(visible("bubble") && text("bubbleText") === "Select a layer first.", "message shown in a bubble");
  assert.ok(parseInt($("bubble").style.top, 10) >= 0, "bubble positioned under the button");
  click($("bubble")); assert.ok(!visible("bubble"), "click dismisses the bubble");
  assert.ok(text("refCard").includes("works like a normal layer, but won't show up in the timelapse."));

  // start (prompts for folder -> mock returns ROOT)
  click($("btnRecord")); await sleep(900);
  assert.strictEqual(text("recText"), "Forest.psd");
  assert.strictEqual(text("recText"), "Forest.psd", "document bar: the name...");
  assert.ok($("recbar").contains($("btnPreview")) && visible("btnPreview"), "...with the preview button inside it");
  assert.strictEqual(text("btnRecordText"), "Recording");
  assert.ok($("btnRecord").classList.contains("live"), "green while recording");
  assert.strictEqual(text("recHint"), "", "no explanation text while recording");
  assert.ok(!visible("recHint"), "empty hint is hidden, not just blank");
  assert.ok(!$("tabDot").classList.contains("hidden") && !$("tabDot").classList.contains("idle"), "record tab dot is green while recording");
  // the document bar sits below the stats
  assert.ok(before("btnRecord", "btnExportOpen") && before("btnExportOpen", "stFrames"), "export sits under the record button");
  assert.ok(before("stFrames", "recbar") && before("recbar", "btnPreview") && before("btnPreview", "refCard"), "document info, then preview, then layers");
  assert.strictEqual($("view-main").querySelectorAll(".sec-title").length, 2, "Recording and Reference layer headings");
  assert.strictEqual($("refCard").parentElement.id, "view-main", "reference layer card stands on its own");
  assert.ok($("btnExportOpen").closest(".card").contains($("btnRecord")), "export sits in the Recording section");
  assert.ok(!text("refCard").includes("REF"));
  assert.strictEqual(text("stFrames"), "1");
  for (let k = 0; k < 3; k++) { d.edit(); listener("historyStateChanged", { documentID: 1 }); await sleep(500); }
  assert.strictEqual(text("stFrames"), "4");
  console.log("record ok:", text("recText"), "|", text("stWork"), "|", text("stDisk"));

  // reference layer button
  d.activeLayers = [d.layers[1]];
  await sleep(600);
  assert.strictEqual(text("refLayer"), "Photo");
  assert.ok($("segNormal").classList.contains("on") && !$("segRef").classList.contains("on"), "Normal picked");
  click($("segRef")); await sleep(300);
  assert.strictEqual(d.layers[1].name, "Photo [ref]");
  assert.strictEqual(text("refLayer"), "Photo", "name shown without the tag");
  assert.strictEqual(text("refState"), "Not recorded");
  assert.ok($("segRef").classList.contains("on") && $("segRef").classList.contains("green"), "Reference picked, green");
  assert.ok($("refChip").classList.contains("ref"));
  click($("segRef")); await sleep(300);
  assert.strictEqual(d.layers[1].name, "Photo [ref]", "picking Reference again changes nothing");
  // two layers, one of them a reference
  d.activeLayers = [d.layers[0], d.layers[1]]; listener("select", {}); await sleep(300);
  assert.strictEqual(text("refLayer"), "2 layers selected");
  assert.strictEqual(text("refState"), "1 of 2 not recorded");
  assert.ok(!$("segNormal").classList.contains("on") && !$("segRef").classList.contains("on"), "mixed: neither picked");
  click($("segNormal")); await sleep(300);
  assert.strictEqual(d.layers[0].name, "Background"); assert.strictEqual(d.layers[1].name, "Photo", "Normal clears the tag");
  assert.ok($("segNormal").classList.contains("on"));
  d.activeLayers = [d.layers[1]]; listener("select", {}); await sleep(300);
  console.log("reference button ok");

  // pause/resume
  click($("btnRecord")); await sleep(200);
  assert.strictEqual(text("btnRecordText"), "Paused");
  assert.ok($("btnRecord").classList.contains("paused"), "grey while paused");
  assert.ok(!$("tabDot").classList.contains("hidden") && $("tabDot").classList.contains("idle"), "record tab dot is yellow when not recording");
  click($("btnRecord")); await sleep(400);

  // settings page
  tab("settings"); await sleep(50);
  assert.ok(doc.querySelector('.tab[data-tab="settings"]').classList.contains("on"));
  assert.ok(visible("view-settings") && !visible("view-main"));
  assert.ok(text("setRoot").includes("Recordings"));
  assert.ok(text("view-settings").includes("Frames folder") && !text("view-settings").includes("Recordings folder"));
  const q = () => Array.from($("segQuality").querySelectorAll(".q"));
  assert.deepStrictEqual(q().map((e) => e.textContent), ["Low", "Default", "High"]);
  assert.ok(q()[1].classList.contains("on"), "Default picked");
  click(q()[2]); await sleep(20);
  assert.ok(text("qualityDesc").includes("Sharper"));
  assert.strictEqual(saved().quality, "high");
  assert.ok(q()[2].classList.contains("on") && !q()[1].classList.contains("on"));
  click(q()[1]);
  // remove frames with undo: a switch row
  const undoSw = $("swUndo").querySelector(".switch");
  assert.ok(undoSw.classList.contains("on"));
  click(undoSw); await sleep(20);
  assert.strictEqual(saved().hideUndone, false);
  click(undoSw); await sleep(20);
  assert.strictEqual(saved().hideUndone, true);
  assert.strictEqual(text("btnChooseRoot"), "Change folder…");
  assert.ok(text("view-settings").includes("Remove frames with undo"));
  assert.ok(text("view-settings").includes("Undoing something removes those recorded frames."));
  assert.ok(!text("view-settings").includes("nearly identical"));
  assert.ok(!text("view-settings").includes("Capture a frame"));
  assert.deepStrictEqual(ddItems("ddIdle").map((e) => e.textContent), ["5 seconds", "10 seconds", "15 seconds", "20 seconds", "30 seconds", "45 seconds", "1 minute"]);
  click(ddItems("ddIdle")[1]); assert.strictEqual(saved().idleSec, 10);
  assert.ok(!doc.getElementById("chkPreview"), "live preview moved to the Record tab");
  assert.ok(!doc.getElementById("setFfmpeg") && !text("view-settings").toLowerCase().includes("ffmpeg"), "no ffmpeg section");
  // name tag is a dropdown of common tags
  const tagItems = ddItems("ddTag").map((e) => e.textContent);
  assert.deepStrictEqual(tagItems, ["[ref]", "[reference]", "(ref)", "#ref", "_ref"]);
  click($("ddTag").querySelectorAll(".dd-item")[3]); await sleep(20);
  assert.strictEqual(saved().excludeTag, "#ref");
  click(ddItems("ddTag")[0]); await sleep(20);
  assert.strictEqual(saved().excludeTag, "[ref]");
  tab("main"); await sleep(100);
  assert.ok(visible("view-main"));
  assert.ok(!visible("previewBox"));
  assert.strictEqual(text("btnPreview"), "Preview▸");
  click($("btnPreview")); await sleep(50);
  assert.strictEqual(saved().showPreview, true);
  assert.strictEqual(text("previewArrow"), "▾");
  assert.ok(visible("previewBox") && visible("previewImg"), "preview turned on");
  assert.ok($("previewImg").src.startsWith("data:image/jpeg;base64,"));
  console.log("settings ok");

  // quick export panel
  assert.ok(!$("btnExportOpen").classList.contains("disabled"));
  assert.strictEqual(text("btnExportOpen"), "Export video");
  click($("btnExportOpen")); await sleep(50);
  assert.ok(visible("exportBox"));
  assert.strictEqual(text("btnExportOpen"), "Cancel");
  assert.ok($("btnExportOpen").classList.contains("cancel"), "Cancel is red");
  assert.ok(!visible("rowUseRemembered"), "nothing remembered yet");
  assert.ok(text("quickEstimate").includes("video from 4 frames"), text("quickEstimate"));
  click(ddItems("ddLengthQuick")[4]); await sleep(20);          // 30 seconds
  assert.ok(text("quickEstimate").includes("30 s video"), text("quickEstimate"));

  // advanced settings page shares the length
  click($("btnAdvanced")); await sleep(50);
  assert.ok(visible("view-export"));
  assert.ok(!doc.getElementById("ddRec") && !doc.getElementById("ddFps"), "no recording / fps pickers");
  assert.strictEqual($("ddLength").querySelector(".dd-head span").textContent, "30 seconds");
  const optOrder = Array.from($("view-export").querySelectorAll(".optrow .chk .txt")).map((e) => e.textContent);
  assert.deepStrictEqual(optOrder.slice(0, 3), ["Show finished drawing first", "Flash before the final image", "Hold final image"]);
  click($("chkFlash").querySelector(".chk")); await sleep(20);
  assert.ok(text("estimate").includes("31 s video"), text("estimate"));
  click($("chkFlash").querySelector(".chk")); await sleep(20);
  assert.ok(optOrder.includes("Remove flicker"), optOrder.join(", "));
  assert.strictEqual(saved().deflicker, false, "off by default");
  click($("chkDeflicker").querySelector(".chk")); await sleep(20);
  assert.strictEqual(saved().deflicker, true);
  assert.ok(text("estimate").includes("flash in and out"), text("estimate"));
  click($("chkDeflicker").querySelector(".chk")); await sleep(20);
  assert.ok(!text("estimate").includes("flash in and out"));
  click(ddItems("ddLength")[0]); await sleep(20);              // back to auto
  back(); await sleep(50);

  // confirm -> save dialog cancelled -> nothing happens
  if (!visible("exportBox")) { click($("btnExportOpen")); await sleep(20); }
  saveAnswer = null;
  click($("btnConfirm")); await sleep(100);
  assert.strictEqual(saveAsked.length, 1);
  assert.ok(saveAsked[0].endsWith(".mp4"));
  assert.strictEqual(text("exportStatus"), "");
  // confirm -> pick a file -> export
  saveAnswer = "Forest final.mp4";
  click($("btnConfirm")); await sleep(50);
  for (let i = 0; i < 100 && visible("btnCancelExport"); i++) await sleep(100);
  assert.ok(text("exportStatus").startsWith("Saved Forest final.mp4"), text("exportStatus"));
  assert.ok(fs.existsSync(path.join(TMP, "Forest final.mp4")));
  assert.ok(visible("exportActions"));
  click($("btnPlay")); await sleep(20);
  assert.ok(opened[opened.length - 1].endsWith("Forest final.mp4"));
  click($("btnOpenOut")); await sleep(20);
  assert.strictEqual(opened[opened.length - 1], TMP);
  if (process.platform === "win32") {
    // export, Play video and Show in folder all asked Photoshop for the same one script
    assert.ok(shellCalls.length >= 3 && new Set(shellCalls).size === 1 && shellCalls[0] === path.join(DATA_DIR, "launcher", "Timelapse Recorder.vbs"),
      "only the launcher is opened: " + shellCalls.join(", "));
  }
  assert.strictEqual(text("btnExportOpen"), "Export again");
  // collapse arrow next to "Export again"
  assert.ok(visible("btnCollapse") && text("btnCollapse") === "\u25B4");
  click($("btnCollapse")); await sleep(50);
  assert.ok(!visible("exportResults") && text("btnCollapse") === "\u25BE", "results collapsed");
  click($("btnCollapse")); await sleep(50);
  assert.ok(visible("exportResults"), "results expanded again");
  console.log("export ok:", text("exportStatus"));

  assert.ok(before("chkRemember", "btnPlay"), "remember is above the buttons");
  // remember the folder -> next export goes straight there
  assert.ok(!$("chkRemember").querySelector(".chk").classList.contains("on"));
  click($("chkRemember").querySelector(".chk")); await sleep(100);
  assert.ok($("chkRemember").querySelector(".chk").classList.contains("on"));
  assert.strictEqual(saved().rememberPath, TMP);
  assert.strictEqual(saved().useRemembered, true);
  click($("btnExportOpen")); await sleep(50);
  assert.ok(visible("rowUseRemembered"));
  assert.ok($("chkUseRemembered").querySelector(".chk").classList.contains("on"));
  assert.strictEqual(text("rememberedPath"), TMP);
  const asked = saveAsked.length;
  click($("btnConfirm")); await sleep(50);
  for (let i = 0; i < 100 && visible("btnCancelExport"); i++) await sleep(100);
  assert.strictEqual(saveAsked.length, asked, "no save dialog");
  assert.ok(fs.existsSync(path.join(TMP, "Forest timelapse.mp4")), text("exportStatus"));
  assert.ok($("chkRemember").querySelector(".chk").classList.contains("on"), "shown as remembered");
  click($("btnExportOpen")); await sleep(50);
  click($("btnConfirm")); await sleep(50);
  for (let i = 0; i < 100 && visible("btnCancelExport"); i++) await sleep(100);
  assert.ok(fs.existsSync(path.join(TMP, "Forest timelapse 2.mp4")), "doesn't overwrite");
  // untick "use remembered folder" -> dialog again
  click($("btnExportOpen")); await sleep(50);
  click($("chkUseRemembered").querySelector(".chk")); await sleep(20);
  saveAnswer = null;
  click($("btnConfirm")); await sleep(100);
  assert.strictEqual(saveAsked.length, asked + 1, "dialog when unticked");
  click($("btnExportOpen")); await sleep(20);                    // Cancel closes the box
  assert.ok(!visible("exportBox"));
  console.log("remember folder ok");

  // library
  tab("library"); await sleep(50);
  assert.ok($("btnOpenRoot").parentElement.contains($("libTotal")), "open folder on the same line as the totals");
  assert.ok(before("libRoot", "btnOpenRoot") && before("btnRefresh", "libList"), "path above, Refresh under the folder card");
  assert.ok(/^\d[\d.]* (KB|MB|GB)$/.test($("libTotal").querySelector("b").textContent) && text("libTotal").includes("1 recording"), text("libTotal"));
  assert.ok(!$("btnRefresh").classList.contains("btn") && text("btnRefresh").includes("Refresh"), "Refresh is plain text");
  assert.ok(doc.querySelector(".lib-item .btnrow").classList.contains("centered"), "item buttons centred");
  const items = doc.querySelectorAll(".lib-item");
  assert.strictEqual(items.length, 1);
  assert.ok(items[0].textContent.includes("REC") && items[0].textContent.includes("EXPORTED"), items[0].textContent);
  const btns = items[0].querySelectorAll(".btn");
  assert.deepStrictEqual(Array.from(btns).map((b) => b.textContent), ["Open folder", "Delete frames"]);
  click(btns[1]); await sleep(20);
  assert.ok(visible("modal"));
  assert.ok(text("modalText").includes("It was exported"), text("modalText"));
  click($("modalCancel")); await sleep(20);
  assert.ok(!visible("modal"));
  // record more after the export -> warning mentions it
  tab("main"); d.edit(); listener("historyStateChanged", { documentID: 1 }); await sleep(600);
  tab("library"); await sleep(50);
  click($("btnRefresh")); await sleep(300);          // re-reading the folder must not split the open recording in two
  assert.ok(doc.querySelector(".lib-item").textContent.includes("Recorded more since the last export"));
  click(doc.querySelectorAll(".lib-item .btn")[1]); await sleep(20);
  assert.ok(text("modalText").includes("recorded more since then"), text("modalText"));
  click($("modalOk")); await sleep(300);
  assert.ok(doc.querySelector(".lib-item").textContent.includes("0 frames"));
  tab("main"); await sleep(100);
  assert.strictEqual(text("stFrames"), "0", "Record tab shows the frames are gone");
  assert.strictEqual(text("stDisk"), "0 KB");
  assert.ok($("btnExportOpen").classList.contains("disabled"), "nothing to export after deleting frames");
  await sleep(2500);                                  // any pending save of the recording has happened by now
  const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, fs.readdirSync(ROOT).find((n) => n.startsWith("Forest")), "recording.json"), "utf8"));
  assert.strictEqual(onDisk.frames.length, 0, "deleted frames don't come back in recording.json");

  // a second, never-exported recording gets the stronger warning
  const d2 = mkDoc(2, "Sketch.psd");
  app.documents.push(d2); app.activeDocument = d2; listener("open", {}); await sleep(1200);
  assert.strictEqual(text("btnExportOpen"), "Export video");
  assert.ok($("tabDot").classList.contains("idle"), "yellow on a document that isn't recording, even while another one is");
  click($("btnRecord")); await sleep(900);
  assert.ok(!$("tabDot").classList.contains("idle"), "green once this document records");
  tab("library"); await sleep(50);
  const sk = Array.from(doc.querySelectorAll(".lib-item")).find((e) => e.textContent.includes("Sketch"));
  assert.ok(sk.textContent.includes("NOT EXPORTED"), sk.textContent);
  click(sk.querySelectorAll(".btn")[1]); await sleep(20);
  assert.ok(text("modalText").includes("hasn't been exported yet"), text("modalText"));
  click($("modalCancel"));
  assert.ok(sk.querySelector(".lib-name .tags").textContent.includes("NOT EXPORTED"), "tags sit in their own right-hand group");

  // deleting frames doesn't move a recording to the top; with 0 frames it can be deleted entirely
  app.activeDocument = d; listener("select", {}); await sleep(400);
  d.edit(); listener("historyStateChanged", { documentID: 1 }); await sleep(700);
  tab("library"); await sleep(50);
  const names = () => Array.from(doc.querySelectorAll(".lib-item .nm")).map((e) => e.textContent);
  const skItem = () => Array.from(doc.querySelectorAll(".lib-item")).find((e) => e.textContent.includes("Sketch"));
  const skBtn = (label) => Array.from(skItem().querySelectorAll(".btn")).find((b) => b.textContent === label);
  assert.deepStrictEqual(names(), ["Forest", "Sketch"], "last recorded first");
  click(skBtn("Delete frames")); await sleep(20);
  click($("modalOk")); await sleep(300);
  assert.deepStrictEqual(names(), ["Forest", "Sketch"], "deleting frames doesn't move it to the top");
  assert.ok(!skBtn("Delete frames"), "no Delete frames with 0 frames");
  assert.ok(skBtn("Delete folder").classList.contains("disabled"), "Delete folder, but not while it's recording");
  app.activeDocument = d2; listener("select", {}); await sleep(400);
  tab("main"); click($("btnRecord")); await sleep(300);
  assert.strictEqual(text("btnRecordText"), "Paused");
  tab("library"); await sleep(50);
  assert.ok(!skBtn("Delete folder").classList.contains("disabled"));
  const skFolder = fs.readdirSync(ROOT).find((n) => n.startsWith("Sketch"));
  click(skBtn("Delete folder")); await sleep(20);
  assert.ok(text("modalText").includes("and its folder"), text("modalText"));
  click($("modalOk")); await sleep(400);
  assert.ok(!fs.existsSync(path.join(ROOT, skFolder)), "folder removed");
  assert.deepStrictEqual(names(), ["Forest"]);
  tab("main"); await sleep(100);
  assert.strictEqual(text("btnRecordText"), "Start recording", "the open document isn't using it anymore");
  await sleep(2500);
  assert.ok(!fs.existsSync(path.join(ROOT, skFolder)), "nothing saved it back");
  console.log("library ok");

  // auto record: new documents start recording on their own; a manual pause sticks
  tab("main"); await sleep(50);
  click($("chkAuto").querySelector(".chk")); await sleep(50);
  assert.strictEqual(saved().autoRecord, true);
  const d3 = mkDoc(3, "Auto.psd");
  app.documents.push(d3); app.activeDocument = d3; listener("open", {}); await sleep(2200);
  assert.strictEqual(text("btnRecordText"), "Recording", "auto-started");
  click($("btnRecord")); await sleep(1500);
  assert.strictEqual(text("btnRecordText"), "Paused", "manual pause is respected");
  app.activeDocument = d2; listener("select", {}); await sleep(1500);
  app.activeDocument = d3; listener("select", {}); await sleep(1500);
  assert.strictEqual(text("btnRecordText"), "Paused", "still paused after switching back");
  click($("chkAuto").querySelector(".chk")); await sleep(20);
  console.log("auto record ok");

  assert.strictEqual(errors.length, 0, "no unhandled errors");
  console.log("\nUI SMOKE TEST PASSED");
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
