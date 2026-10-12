// Drives the real plugin modules against a mock Photoshop + UXP to test the
// recording/undo/visibility/export logic end to end.
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");
const jpegEncode = require("jpeg-js").encode;
const SRC = path.join(__dirname, "..", "src");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("  ", ...a);

/* ---------------- mock UXP storage (backed by a temp dir) ---------------- */
class Entry {
  constructor(p) { this.nativePath = p; this.name = path.basename(p); }
  get isFile() { return fs.existsSync(this.nativePath) && fs.statSync(this.nativePath).isFile(); }
  get isFolder() { return fs.existsSync(this.nativePath) && fs.statSync(this.nativePath).isDirectory(); }
  async delete() { if (this.isFolder) fs.rmdirSync(this.nativePath); else fs.unlinkSync(this.nativePath); }
  async moveTo(folder, opts) {
    const dest = path.join(folder.nativePath, (opts && opts.newName) || this.name);
    if (fs.existsSync(dest) && !(opts && opts.overwrite)) throw new Error("exists");
    fs.renameSync(this.nativePath, dest);
    this.nativePath = dest; this.name = path.basename(dest);
  }
}
class File extends Entry {
  async read(o) {
    const buf = fs.readFileSync(this.nativePath);
    if (o && o.format === "binary") return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    return buf.toString("utf8");
  }
  async write(data, o) {
    if (o && o.format === "binary") fs.writeFileSync(this.nativePath, Buffer.from(new Uint8Array(data)));
    else fs.writeFileSync(this.nativePath, data, "utf8");
  }
}
class Folder extends Entry {
  async getEntries() { return fs.readdirSync(this.nativePath).map((n) => wrap(path.join(this.nativePath, n))); }
  async getEntry(n) { const p = path.join(this.nativePath, n); if (!fs.existsSync(p)) throw new Error("not found " + n); return wrap(p); }
  async createFile(n, o) {
    const p = path.join(this.nativePath, n);
    if (fs.existsSync(p) && !(o && o.overwrite)) throw new Error("exists");
    fs.writeFileSync(p, ""); return new File(p);
  }
  async createFolder(n) { const p = path.join(this.nativePath, n); fs.mkdirSync(p); return new Folder(p); }
}
const wrap = (p) => (fs.statSync(p).isDirectory() ? new Folder(p) : new File(p));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tlr-sim-"));
const ROOT = path.join(TMP, "Timelapses"); fs.mkdirSync(ROOT);
const shellCalls = [];
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
// Imitates the flicker check's ffmpeg run: 32x32 greyscale thumbnail of every listed frame.
const thumbRuns = [];
function fakeThumbs(vbsPath) {
  const dir = path.dirname(vbsPath), work = path.join(dir, "_flicker");
  const bat = fs.readFileSync(path.join(dir, "check_flicker.bat"), "utf8");
  const list = fs.readFileSync(path.join(work, "list.txt"), "utf8").split("\n").filter((l) => l.startsWith("file ")).map((l) => l.slice(6, -1));
  const dec = require(path.join(SRC, "jpeg-decoder.js"));
  const out = Buffer.alloc(list.length * 1024);
  list.forEach((rel, k) => {
    const d = dec(fs.readFileSync(path.join(work, rel)), { useTArray: true, formatAsRGBA: false });
    for (let ty = 0; ty < 32; ty++) for (let tx = 0; tx < 32; tx++) {
      let s = 0, c = 0;
      for (let y = Math.floor(ty * d.height / 32); y < Math.max(Math.floor(ty * d.height / 32) + 1, Math.floor((ty + 1) * d.height / 32)); y++)
        for (let x = Math.floor(tx * d.width / 32); x < Math.max(Math.floor(tx * d.width / 32) + 1, Math.floor((tx + 1) * d.width / 32)); x++) {
          const i = (y * d.width + x) * 3; s += 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2]; c++;
        }
      out[k * 1024 + ty * 32 + tx] = Math.round(s / c);
    }
  });
  thumbRuns.push({ bat, frames: list.length });
  setTimeout(() => {
    fs.writeFileSync(path.join(work, "thumbs.raw"), out);
    fs.writeFileSync(path.join(work, "progress.txt"), "frame=" + list.length + "\nprogress=end\n");
    fs.writeFileSync(path.join(work, "done.txt"), "0\r\n");
  }, 200);
}
const PLUGIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tlr-plugin-"));
fs.mkdirSync(path.join(PLUGIN_DIR, "bin")); fs.writeFileSync(path.join(PLUGIN_DIR, "bin", "ffmpeg.exe"), "");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tlr-data-"));
// Does what the launcher's "Timelapse Recorder.vbs" does: takes the jobs, runs/opens their targets.
const jobsDone = [];
function startTarget(p) {
  if (p.endsWith("make_video.bat")) fakeFfmpeg(p);
  if (p.endsWith("check_flicker.bat")) fakeThumbs(p);
}
function runLauncher(script) {
  const jobs = path.join(path.dirname(script), "jobs");
  for (const n of fs.readdirSync(jobs).filter((n) => n.endsWith(".job")).sort()) {
    const [kind, target] = fs.readFileSync(path.join(jobs, n), "utf8").split("\n");
    fs.unlinkSync(path.join(jobs, n));
    jobsDone.push({ kind, target });
    if (kind === "run") startTarget(target);
  }
}

const uxpMock = {
  storage: {
    formats: { utf8: "utf8", binary: "binary" },
    localFileSystem: {
      getFolder: async () => new Folder(ROOT),
      createPersistentToken: async (e) => "tok:" + e.nativePath,
      getEntryForPersistentToken: async (t) => new Folder(t.slice(4)),
      createSessionToken: (e) => "sess:" + e.nativePath,
      getFileForOpening: async () => null,
      getPluginFolder: async () => new Folder(PLUGIN_DIR),
      getDataFolder: async () => new Folder(DATA_DIR)
    }
  },
  shell: { openPath: async (p) => { shellCalls.push(p); if (p.endsWith("Timelapse Recorder.vbs")) runLauncher(p); else startTarget(p); return ""; }, openExternal: async () => "" }
};

/* ---------------- mock Photoshop ---------------- */
let nextHistId = 100;
class MockDoc {
  constructor(id, name, w, h) {
    this.id = id; this.name = name; this.title = name; this.path = ""; this.xmp = "";
    this.width = w; this.height = h;
    this.paint = new Uint8Array(w * h * 3).fill(255);
    this.layers = [];
    this.hist = [{ id: nextHistId++, name: "Open", snapshot: true, paint: this.paint.slice(), w, h },
                 { id: nextHistId++, name: "Open", snapshot: false, paint: this.paint.slice(), w, h }];
    this.active = 1;
    this.visUndoable = false;
    this.visInHistory = false;   // undo puts back the layer visibility a step had
  }
  get historyStates() { return this.hist.map((h) => ({ id: h.id, name: h.name, snapshot: h.snapshot })); }
  get activeHistoryState() { const h = this.hist[this.active]; return { id: h.id, name: h.name, snapshot: h.snapshot }; }
  composite() {
    const out = this.paint.slice();
    const walk = (layers) => {
      for (const l of layers) {
        if (!l.visible) continue;
        if (l.layers) { walk(l.layers); continue; }
        for (let y = l.rect[1]; y < l.rect[3]; y++) for (let x = l.rect[0]; x < l.rect[2]; x++) {
          const i = (y * this.width + x) * 3; out[i] = l.color[0]; out[i + 1] = l.color[1]; out[i + 2] = l.color[2];
        }
      }
    };
    walk(this.layers);
    return out;
  }
  // an edit: paint `count` pixels starting at offset, push a history state
  edit(count, offset, color) {
    const c = color || [20, 40, 200];
    for (let k = 0; k < count; k++) { const i = ((offset + k) % (this.width * this.height)) * 3; this.paint[i] = c[0]; this.paint[i + 1] = c[1]; this.paint[i + 2] = c[2]; }
    this.hist = this.hist.slice(0, this.active + 1);
    this.hist.push({ id: nextHistId++, name: "Brush Tool", snapshot: false, paint: this.paint.slice(), w: this.width, h: this.height, vis: this.layers.map((l) => l._vis) });
    this.active = this.hist.length - 1;
  }
  undo() { this.active--; this.restore(); }
  redo() { this.active++; this.restore(); }
  restore() {
    const h = this.hist[this.active]; this.paint = h.paint.slice(); this.width = h.w; this.height = h.h;
    if (this.visInHistory && h.vis) this.layers.forEach((l, i) => { l._vis = h.vis[i]; });
  }
  crop(w, h) {
    const np = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (y * this.width + x) * 3, d = (y * w + x) * 3; np[d] = this.paint[s]; np[d + 1] = this.paint[s + 1]; np[d + 2] = this.paint[s + 2]; }
    this.paint = np; this.width = w; this.height = h;
    this.hist = this.hist.slice(0, this.active + 1);
    this.hist.push({ id: nextHistId++, name: "Crop", snapshot: false, paint: np.slice(), w, h });
    this.active = this.hist.length - 1;
  }
  closeWithoutSaving() { const i = app.documents.indexOf(this); if (i >= 0) app.documents.splice(i, 1); if (app.activeDocument === this) app.activeDocument = app.documents[0] || null; }
}
let nextLayerId = 1;
function layer(name, rect, color) {
  const l = { id: nextLayerId++, name, rect, color, _vis: true };
  Object.defineProperty(l, "visible", { get() { return l._vis; }, set(v) { stats.visSets++; l._vis = v; } });
  return l;
}
const stats = { getPixels: 0, modal: 0, suspend: 0, resume: [], encodes: 0 };
stats.visSets = 0;
stats.multiGets = 0; stats.hideCmds = [];
stats.direct = 0; stats.directFails = 0;
let inModal = 0;                // inside executeAsModal right now
let pixelsNeedModal = 0;        // the next N getPixels calls outside a modal scope fail with a "modal" error

// Photoshop's multiGet answer for every layer: bottom layer first, a hidden
// "layerSectionEnd" marker below each group's contents, the group itself above them.
// (The mock's own layer arrays run top first, like the DOM.)
let multiGetWorks = true;
function amLayerList(layers) {
  const out = [];
  const walk = (ls) => {
    for (let i = ls.length - 1; i >= 0; i--) {
      const l = ls[i];
      if (l.layers) {
        out.push({ layerID: l.id + 100000, name: "</Layer group>", visible: true, layerSection: { _enum: "layerSectionType", _value: "layerSectionEnd" } });
        walk(l.layers);
        out.push({ layerID: l.id, name: l.name, visible: l._vis, layerSection: { _enum: "layerSectionType", _value: "layerSectionStart" } });
      } else out.push({ layerID: l.id, name: l.name, visible: l._vis, layerSection: { _enum: "layerSectionType", _value: "layerSectionContent" } });
    }
  };
  walk(layers);
  return out;
}
function findLayer(layers, id) {
  for (const l of layers) {
    if (l.id === id) return l;
    const k = l.layers && findLayer(l.layers, id);
    if (k) return k;
  }
  return null;
}
function group(name, kids) {
  const g = layer(name, [0, 0, 0, 0], [0, 0, 0]);
  g.layers = kids;
  return g;
}

const app = { documents: [], activeDocument: null };
let listener = null;
const psOps = { opened: null, exported: null };
function makeImageData(pixels, w, h) {
  return { width: w, height: h, components: 3, componentSize: 8, _px: pixels, getData: async () => pixels, dispose() { this.disposed = true; } };
}
function jpegOf(img) {
  const rgba = Buffer.alloc(img.width * img.height * 4);
  for (let i = 0, o = 0; i < img._px.length; i += 3, o += 4) { rgba[o] = img._px[i]; rgba[o + 1] = img._px[i + 1]; rgba[o + 2] = img._px[i + 2]; rgba[o + 3] = 255; }
  return jpegEncode({ data: rgba, width: img.width, height: img.height }, 92).data;
}
const psMock = {
  app,
  action: {
    addNotificationListener: (events, fn) => { listener = fn; },
    batchPlay: (cmds, opts) => { const r = cmds.map((c) => {
      if (c._obj === "multiGet") {
        stats.multiGets++;
        assert.ok(opts && opts.synchronousExecution, "the layer list is asked for synchronously");
        if (!multiGetWorks) return { _obj: "error", message: "multiGet not supported" };
        const d = app.documents.find((x) => x.id === c._target._ref[0]._id);
        return { list: amLayerList(d.layers) };
      }
      if (c._obj === "get" && c._target[0]._property === "hasBackgroundLayer") return { hasBackgroundLayer: false };
      if (c._obj === "hide" || c._obj === "show") {
        const d = app.documents.find((x) => x.id === c.null[1]._id);
        const l = d && findLayer(d.layers, c.null[0]._id);
        if (!l) return { _obj: "error", message: "no such layer" };
        if (c._obj === "hide") stats.hideCmds.push(c.null[0]._id);
        l.visible = c._obj === "show";
        return {};
      }
      if (c._obj === "get" && c._target[0]._property === "XMPMetadataAsUTF8") {
        const d = app.documents.find((x) => x.id === c._target[1]._id);
        return { XMPMetadataAsUTF8: d ? d.xmp : "" };
      }
      if (c._obj === "set" && c._target[0]._property === "XMPMetadataAsUTF8") {
        const d = app.documents.find((x) => x.id === c._target[1]._id);
        d.xmp = c.to.XMPMetadataAsUTF8; return {};
      }
      if (c._obj === "open") {
        assert.strictEqual(c.sequence, true);
        const first = c.null._path.slice(5);
        psOps.opened = { first, frames: fs.readdirSync(path.dirname(first)).length, fps: c.frameRate };
        const d = new MockDoc(999, "frame_000001.jpg", 10, 10);
        app.documents.push(d); app.activeDocument = d;
        return {};
      }
      if (c._obj === "export") {
        const dir = c.using.directory._path.slice(5);
        fs.writeFileSync(path.join(dir, c.using.name), "fake mp4");
        psOps.exported = c.using; return {};
      }
      return { _obj: "error", message: "unknown command " + c._obj };
    }); return opts && opts.synchronousExecution ? r : Promise.resolve(r); }
  },
  core: {
    executeAsModal: async (fn) => {
      stats.modal++;
      inModal++;
      try { return await fn({
        hostControl: {
          suspendHistory: async () => { stats.suspend++; return 7; },
          resumeHistory: async (id, commit) => { stats.resume.push(commit); }
        },
        reportProgress() {}
      }); } finally { inModal--; }
    }
  },
  imaging: {
    getPixels: async (o) => {
      stats.getPixels++;
      if (!inModal && pixelsNeedModal > 0) { pixelsNeedModal--; stats.directFails++; throw new Error("This function requires a modal scope (executeAsModal)"); }
      if (!inModal) stats.direct++;
      const d = app.documents.find((x) => x.id === o.documentID);
      assert.ok(o.targetSize.width % 2 === 0 && o.targetSize.height % 2 === 0, "even target");
      assert.strictEqual(o.applyAlpha, true);
      const full = d.composite();
      const tw = o.targetSize.width, th = o.targetSize.height;
      const px = new Uint8Array(tw * th * 3);
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const sx = Math.floor(x * d.width / tw), sy = Math.floor(y * d.height / th);
        const s = (sy * d.width + sx) * 3, t = (y * tw + x) * 3;
        px[t] = full[s]; px[t + 1] = full[s + 1]; px[t + 2] = full[s + 2];
      }
      return { imageData: makeImageData(px, tw, th), sourceBounds: {}, level: 0 };
    },
    encodeImageData: async ({ imageData, base64 }) => {
      stats.encodes++;
      const jpg = jpegOf(imageData);
      return base64 ? jpg.toString("base64") : Array.from(jpg);
    },
    createImageDataFromBuffer: async (buf, o) => {
      assert.strictEqual(buf.length, o.width * o.height * o.components);
      return makeImageData(buf, o.width, o.height);
    }
  }
};

const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "photoshop") return psMock;
  if (req === "uxp") return uxpMock;
  return origLoad.apply(this, arguments);
};
const ls = new Map();
global.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) };

const settings = require(path.join(SRC, "settings.js"));
const store = require(path.join(SRC, "store.js"));
const recorder = require(path.join(SRC, "recorder.js"));
const exporter = require(path.join(SRC, "exporter.js"));
const psutil = require(path.join(SRC, "psutil.js"));
const plan = require(path.join(SRC, "plan.js"));

const fire = (name, desc) => listener(name, desc || {});
const messages = [];
function frames(rec) { return rec.meta.frames; }
function live(rec) { return rec.meta.frames.filter((f) => !f.u); }

(async () => {
  // ---- XMP helpers
  {
    assert.strictEqual(psutil.extractId(""), null);
    const x1 = psutil.injectId("", "abc");
    assert.strictEqual(psutil.extractId(x1), "abc");
    const adobe = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Adobe Photoshop"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    const x2 = psutil.injectId(adobe, "id-1");
    assert.strictEqual(psutil.extractId(x2), "id-1");
    assert.ok(x2.indexOf("CreatorTool") > 0);
    // re-serialised as an element with another prefix
    const elem = adobe.replace("</rdf:RDF>", '<rdf:Description rdf:about="" xmlns:ns1="http://ns.timelapse-recorder.local/1.0/"><ns1:RecordingID>id-2</ns1:RecordingID></rdf:Description></rdf:RDF>');
    assert.strictEqual(psutil.extractId(elem), "id-2");
    assert.strictEqual(psutil.extractId(psutil.injectId(elem, "id-3")), "id-3");
    assert.strictEqual((psutil.injectId(elem, "id-3").match(/RecordingID/g) || []).length, 2); // replaced, not duplicated (open+close tag)
    console.log("xmp ok");
  }

  settings.set("rootToken", "tok:" + ROOT);
  await store.init();
  // the timings below were written for these (the document has a reference layer showing, so the locked ones apply)
  const baseTiming = { settleMs: 350, maxWaitMs: 2500, lockedSettleMs: 350, lockedMaxWaitMs: 2500 };
  Object.assign(recorder._timing, baseTiming);
  recorder.init({ onChange() {}, onMessage(m) { messages.push(m); } });

  // ---- open a document, start recording
  const doc = new MockDoc(1, "Portrait.psd", 64, 48);
  doc.layers = [layer("Background paint", [0, 0, 4, 4], [250, 250, 250]), layer("Sketch [ref]", [10, 10, 30, 30], [255, 0, 0]), layer("Lines", [40, 5, 50, 15], [0, 0, 0])];
  app.documents.push(doc); app.activeDocument = doc;
  fire("open"); await sleep(300);
  assert.strictEqual(recorder.activeState().session, null);

  await recorder.toggleActive();
  await sleep(600);
  let rec = store.list()[0];
  assert.ok(rec, "recording created");
  assert.strictEqual(psutil.extractId(doc.xmp), rec.id, "XMP carries recording id");
  assert.strictEqual(frames(rec).length, 1, "initial frame");
  assert.ok(stats.suspend >= 1 && stats.resume.every((c) => c === false), "ref layer hidden inside suspended+rolled-back history");
  assert.strictEqual(doc.layers[1].visible, true, "ref layer restored");
  // the saved frame must not contain the red [ref] layer
  {
    const jpg = fs.readFileSync(path.join(rec.folder.nativePath, "frames", "f_000001.jpg"));
    const dec = require(path.join(SRC, "jpeg-decoder.js"))(jpg, { useTArray: true, formatAsRGBA: false });
    const i = (20 * 64 + 20) * 3;
    assert.ok(dec.data[i] > 200 && dec.data[i + 1] > 200, "ref layer not in frame (got " + dec.data.slice(i, i + 3) + ")");
  }
  console.log("start + [ref] exclusion ok");

  // ---- an edit -> one frame after the settle delay
  doc.edit(30, 500); fire("historyStateChanged", { documentID: 1 });
  await sleep(150);
  assert.strictEqual(frames(rec).length, 1, "not before settle delay");
  await sleep(400);
  assert.strictEqual(frames(rec).length, 2, "frame after edit");

  // ---- rapid edits coalesce
  for (let k = 0; k < 4; k++) { doc.edit(20, 800 + k * 40); fire("historyStateChanged", { documentID: 1 }); await sleep(100); }
  await sleep(500);
  assert.strictEqual(frames(rec).length, 3, "rapid edits -> one frame");
  console.log("edit capture ok");

  // ---- visibility toggles: never a frame
  const lines = doc.layers[2];
  for (let k = 0; k < 5; k++) {
    lines.visible = !lines.visible; fire(lines.visible ? "show" : "hide");
    await sleep(120);
  }
  await sleep(600);
  assert.strictEqual(frames(rec).length, 3, "toggles don't record");
  // lines is now hidden (5 toggles). Paint while hidden -> recorded as it looks
  assert.strictEqual(lines.visible, false);
  doc.edit(25, 1500); fire("historyStateChanged", { documentID: 1 });
  await sleep(600);
  assert.strictEqual(frames(rec).length, 4, "edit while hidden records");
  lines.visible = true; fire("show"); await sleep(600);
  assert.strictEqual(frames(rec).length, 4, "showing again doesn't record");
  console.log("visibility ok");

  // ---- "Make Layer Visibility Changes Undoable": toggle creates a history state
  doc.visUndoable = true;
  lines.visible = false;
  doc.hist = doc.hist.slice(0, doc.active + 1); doc.hist.push({ id: nextHistId++, name: "Hide Layer", snapshot: false, paint: doc.paint.slice(), w: doc.width, h: doc.height }); doc.active = doc.hist.length - 1;
  fire("historyStateChanged", { documentID: 1 }); await sleep(5); fire("hide");      // history first, then hide
  await sleep(600);
  assert.strictEqual(frames(rec).length, 4, "undoable toggle (history first) not recorded");
  lines.visible = true; fire("show"); await sleep(5);                                  // hide first, then history
  doc.hist.push({ id: nextHistId++, name: "Show Layer", snapshot: false, paint: doc.paint.slice(), w: doc.width, h: doc.height }); doc.active = doc.hist.length - 1;
  fire("historyStateChanged", { documentID: 1 });
  await sleep(600);
  assert.strictEqual(frames(rec).length, 4, "undoable toggle (event first) not recorded");
  console.log("undoable-visibility ok");

  // ---- near-identical skipping (first an edit so the last frame shows the current visibility)
  doc.edit(30, 1800); fire("historyStateChanged", { documentID: 1 }); await sleep(600);
  assert.strictEqual(frames(rec).length, 5, "edit after showing layer records");
  doc.edit(2, 2000); fire("historyStateChanged", { documentID: 1 }); await sleep(600);
  assert.strictEqual(frames(rec).length, 5, "2 px change skipped");
  doc.edit(3, 2100); fire("historyStateChanged", { documentID: 1 }); await sleep(600);
  assert.strictEqual(frames(rec).length, 6, "accumulated change recorded");
  // a history state that changes nothing (e.g. a selection) -> identical -> skipped
  doc.hist.push({ id: nextHistId++, name: "Rectangular Marquee", snapshot: false, paint: doc.paint.slice(), w: doc.width, h: doc.height }); doc.active = doc.hist.length - 1;
  fire("historyStateChanged", { documentID: 1 }); await sleep(600);
  assert.strictEqual(frames(rec).length, 6, "identical frame skipped");
  console.log("similar-skip ok");

  // ---- undo-aware
  doc.edit(40, 2500, [0, 200, 0]); fire("historyStateChanged", { documentID: 1 }); await sleep(600);
  assert.strictEqual(frames(rec).length, 7);
  doc.undo(); fire("historyStateChanged", { documentID: 1 }); await sleep(600);
  assert.strictEqual(frames(rec).length, 7, "undo adds no frame");
  assert.strictEqual(frames(rec)[6].u, 1, "undone frame flagged");
  doc.redo(); fire("historyStateChanged", { documentID: 1 }); await sleep(600);
  assert.strictEqual(frames(rec)[6].u, 0, "redo restores");
  doc.undo(); fire("historyStateChanged", { documentID: 1 }); await sleep(100);
  doc.edit(40, 2500, [0, 200, 0]); fire("historyStateChanged", { documentID: 1 }); await sleep(600);   // same stroke again
  assert.strictEqual(frames(rec).length, 8, "redoing the same stroke after undo is recorded (not skipped as identical)");
  assert.strictEqual(frames(rec)[6].u, 1, "discarded state stays hidden");
  assert.strictEqual(recorder.liveFrameCount(rec), 7);
  console.log("undo ok");

  // ---- Save As with a new name: the recording and its folder follow
  {
    const oldFolder = rec.folder.nativePath;
    const nFrames = frames(rec).length;
    doc.name = doc.title = "Portrait final.psd"; doc.path = "C:\\art\\Portrait final.psd";
    fire("save"); await sleep(900);
    assert.strictEqual(path.basename(rec.folder.nativePath), "Portrait final (" + rec.id.slice(0, 8) + ")", "folder renamed");
    assert.ok(!fs.existsSync(oldFolder), "old folder gone");
    assert.strictEqual(rec.meta.name, "Portrait final");
    assert.strictEqual(fs.readdirSync(path.join(rec.folder.nativePath, "frames")).length, nFrames, "frames moved along");
    const saved = JSON.parse(fs.readFileSync(path.join(rec.folder.nativePath, "recording.json"), "utf8"));
    assert.strictEqual(saved.name, "Portrait final");
    doc.edit(40, 2700, [90, 0, 90]); fire("historyStateChanged", { documentID: 1 }); await sleep(600);
    const last = frames(rec)[frames(rec).length - 1];
    assert.ok(fs.existsSync(path.join(rec.folder.nativePath, "frames", "f_" + String(last.n).padStart(6, "0") + ".jpg")), "new frames go to the renamed folder");
    frames(rec).pop(); rec.meta.nextIndex--;                 // keep the frame counts below as they were
    fs.unlinkSync(path.join(rec.folder.nativePath, "frames", "f_" + String(last.n).padStart(6, "0") + ".jpg"));
    // saving again under the same name changes nothing
    fire("save"); await sleep(700);
    assert.strictEqual(path.basename(rec.folder.nativePath), "Portrait final (" + rec.id.slice(0, 8) + ")");
    console.log("rename ok");
  }

  // ---- crop mid-recording (frame size changes)
  doc.crop(48, 40); fire("historyStateChanged", { documentID: 1 }); await sleep(600);
  assert.strictEqual(frames(rec).length, 9);
  assert.strictEqual(frames(rec)[8].x, 48);
  console.log("crop ok");

  // ---- work timer
  const w1 = recorder.activeState().session.workMs;
  assert.ok(w1 > 5000 && w1 < 60000, "work time counted: " + w1);
  settings.set("idleSec", 60);

  // ---- pause / resume
  await recorder.toggleActive();                    // pause
  assert.strictEqual(recorder.activeState().session.recording, false);
  doc.edit(30, 3000); fire("historyStateChanged", { documentID: 1 }); await sleep(600);
  assert.strictEqual(frames(rec).length, 9, "paused: nothing recorded");
  await recorder.toggleActive();                    // resume -> immediate frame of current state
  await sleep(300);
  assert.strictEqual(frames(rec).length, 10, "resume captures current state");
  console.log("pause/resume ok");

  // ---- close and reopen: same recording continues
  await store.saveNow(rec);
  doc.closeWithoutSaving(); fire("close"); await sleep(1300);
  assert.strictEqual(recorder.activeState().session, null);
  let saved = JSON.parse(fs.readFileSync(path.join(rec.folder.nativePath, "recording.json"), "utf8"));
  assert.strictEqual(saved.state, "recording");
  assert.strictEqual(saved.frames.length, 10);
  const reopened = new MockDoc(2, "Portrait.psd", 48, 40);
  reopened.xmp = doc.xmp; reopened.paint = doc.paint.slice(); reopened.layers = doc.layers;
  app.documents.push(reopened); app.activeDocument = reopened;
  fire("open"); await sleep(600);
  const ses = recorder.activeState().session;
  assert.ok(ses && ses.recording, "auto-resumed on reopen");
  assert.strictEqual(frames(rec).length, 10, "no frame just for reopening");
  reopened.edit(50, 100, [200, 100, 0]); fire("historyStateChanged", { documentID: 2 }); await sleep(600);
  assert.strictEqual(frames(rec).length, 11, "continues same recording");
  // an old-session history id colliding with a new one must not touch old frames
  reopened.undo(); fire("historyStateChanged", { documentID: 2 }); await sleep(300);
  assert.strictEqual(frames(rec)[10].u, 1);
  assert.strictEqual(frames(rec).slice(0, 10).filter((f) => f.u).length, 1, "old frames untouched by new-session undo");
  reopened.redo(); fire("historyStateChanged", { documentID: 2 }); await sleep(300);
  console.log("reopen ok");

  // ---- duplicate document (same XMP id) gets its own recording
  const dup = new MockDoc(3, "Portrait copy", 32, 32);
  dup.xmp = reopened.xmp;
  app.documents.push(dup); app.activeDocument = dup;
  fire("select"); await sleep(400);
  assert.strictEqual(recorder.activeState().session, null, "duplicate not attached");
  await recorder.toggleActive(); await sleep(400);
  assert.strictEqual(store.list().length, 2, "duplicate got a new recording");
  assert.notStrictEqual(psutil.extractId(dup.xmp), rec.id);
  await recorder.toggleActive();   // pause dup
  app.activeDocument = reopened; fire("select"); await sleep(300);
  console.log("duplicate ok");

  // ---- reference layer toggle
  reopened.activeLayers = [reopened.layers[2]];
  assert.deepStrictEqual(recorder.referenceState(), { count: 1, tagged: false, some: 0, name: "Lines" });
  await recorder.toggleReference(); await sleep(50);
  assert.strictEqual(reopened.layers[2].name, "Lines [ref]");
  assert.deepStrictEqual(recorder.referenceState(), { count: 1, tagged: true, some: 1, name: "Lines" });
  await recorder.toggleReference(); await sleep(50);
  assert.strictEqual(reopened.layers[2].name, "Lines");
  console.log("reference toggle ok");

  // ---- export plan + estimate (30 fps)
  const st = settings.get();
  const target = (n) => new File(path.join(TMP, n));
  settings.set("lengthSec", 2); settings.set("introOn", true); settings.set("introSec", 0.5); settings.set("flashOn", true);
  settings.set("holdOn", true); settings.set("holdSec", 1); settings.set("timerOverlay", false); settings.set("encoder", "photoshop");
  const est = exporter.estimate(rec, st);
  assert.strictEqual(est.total, 15 + 60 + 18 + 30);
  assert.strictEqual(est.width, 48); assert.strictEqual(est.height, 40);
  assert.ok(est.resized);
  const pf = plan.planExport(live(rec).length, { fps: 30, lengthSec: 2, introSec: 0.5, flash: true, holdSec: 1 });
  const whites = []; for (let k = 0; k < pf.total; k++) whites.push(pf.at(k).white);
  assert.strictEqual(whites.slice(75, 93).join(","), [1 / 3, 2 / 3, 1].concat(Array.from({ length: 15 }, (_, i) => 1 - (i + 1) / 15)).join(","));
  assert.strictEqual(pf.at(92).part, "flash"); assert.strictEqual(pf.at(93).part, "hold");

  // ---- export via Photoshop (mock) into a picked file
  const out1 = target("My video.mp4");
  const res = await exporter.run(rec, settings.get(), out1, { progress() {}, cancelled: () => false });
  assert.strictEqual(res.mode, "photoshop");
  assert.strictEqual(res.file, out1.nativePath);
  assert.strictEqual(fs.readFileSync(out1.nativePath, "utf8"), "fake mp4", "video copied to picked file");
  assert.ok(!fs.existsSync(path.join(rec.folder.nativePath, "_render_video.mp4")), "temp video removed");
  assert.strictEqual(psOps.opened.frames, 123, "sequence had every planned frame");
  assert.strictEqual(psOps.opened.fps, 30);
  assert.ok(!fs.existsSync(path.join(rec.folder.nativePath, "_render")), "_render cleaned up");
  assert.ok(!app.documents.find((d) => d.id === 999), "sequence doc closed");
  assert.strictEqual(rec.meta.exports.length, 1);
  assert.strictEqual(rec.meta.exports[0].path, out1.nativePath);
  console.log("photoshop export ok:", res.message);

  // ---- export via ffmpeg with timer overlay + flash (frames get redrawn)
  // ---- ffmpeg without overlay/flash: frames of another canvas size are passed through, ffmpeg scales them
  settings.set("encoder", "ffmpeg"); settings.set("timerOverlay", false); settings.set("flashOn", false); settings.set("introOn", false); settings.set("holdOn", false);
  const resOut = await exporter.run(rec, settings.get(), target("scaled.mp4"), { progress() {}, cancelled: () => false });
  const runS = ffRuns[ffRuns.length - 1];
  assert.ok(runS.bat.includes('-vf "scale=48:40:force_original_aspect_ratio=decrease') && runS.bat.includes("color=0x000000"), runS.bat);
  const sizes = new Set(fs.readdirSync(runS.snap).map((n) => { const d = require(path.join(SRC, "jpeg-decoder.js"))(fs.readFileSync(path.join(runS.snap, n)), { useTArray: true, formatAsRGBA: false }); return d.width + "x" + d.height; }));
  assert.ok(sizes.has("64x48") && sizes.has("48x40"), "frames kept their own size for ffmpeg to scale: " + Array.from(sizes));
  console.log("ffmpeg scaling ok:", resOut.message);
  settings.set("introOn", true); settings.set("holdOn", true); settings.set("flashOn", true);

  settings.set("encoder", "ffmpeg"); settings.set("timerOverlay", true); settings.set("slowEnd", true); settings.set("lengthSec", "auto");
  const out2 = target("second.mp4");
  const progress2 = [];
  const res2 = await exporter.run(rec, settings.get(), out2, { progress: (f, t) => progress2.push([f, t]), cancelled: () => false });
  assert.strictEqual(res2.mode, "ffmpeg");
  assert.strictEqual(res2.file, out2.nativePath);
  assert.strictEqual(fs.readFileSync(out2.nativePath, "utf8"), "ffmpeg mp4", "video written where the user asked");
  if (process.platform === "win32") {
    // every start goes through the one launcher script, so Photoshop's remembered permission applies
    const launcherPath = path.join(DATA_DIR, "launcher", "Timelapse Recorder.vbs");
    assert.ok(shellCalls.length >= 2 && shellCalls.every((p) => p === launcherPath), "only the launcher is opened: " + shellCalls.join(", "));
    assert.strictEqual(fs.readFileSync(launcherPath, "utf8"), require(path.join(SRC, "launcher.js"))._vbs);
    const last = jobsDone[jobsDone.length - 1];
    assert.ok(last.kind === "run" && last.target === path.join(rec.folder.nativePath, "make_video.bat"), "runs make_video.bat hidden: " + JSON.stringify(last));
    assert.deepStrictEqual(fs.readdirSync(path.join(DATA_DIR, "launcher", "jobs")), [], "no jobs left behind");
  } else {
    assert.ok(shellCalls[shellCalls.length - 1].endsWith("make_video.bat"), "opens the .bat directly off Windows");
  }
  const run2 = ffRuns[ffRuns.length - 1];
  assert.ok(run2.bat.includes(path.join(PLUGIN_DIR, "bin", "ffmpeg.exe")), "uses the bundled ffmpeg");
  assert.ok(run2.bat.includes("_render\\frame_%%06d.jpg") && run2.bat.includes("-framerate 30") && run2.bat.includes("-progress") && run2.bat.includes(out2.nativePath));
  assert.ok(progress2.some(([f, t]) => /ffmpeg\u2026 \d+%/.test(t) && f > 0.3 && f < 1), "real ffmpeg progress shown");
  for (let i = 1; i < progress2.length; i++) assert.ok(progress2[i][0] >= progress2[i - 1][0] - 1e-9, "bar never goes backwards");
  assert.ok(!fs.existsSync(path.join(rec.folder.nativePath, "_render")), "_render cleaned up");
  assert.ok(!fs.existsSync(path.join(rec.folder.nativePath, "make_video.bat")), "scripts cleaned up");
  assert.ok(!fs.existsSync(path.join(rec.folder.nativePath, "make_video.vbs")), "no per-recording .vbs any more");
  assert.ok(/ffmpeg \d/.test(res2.message), res2.message);
  const p2 = plan.planExport(live(rec).length, { fps: 30, lengthSec: "auto", introSec: 0.5, flash: true, holdSec: 1, slowEnd: true });
  const rendered = fs.readdirSync(run2.snap).sort();
  assert.strictEqual(run2.frames, p2.total, "rendered " + run2.frames + " of " + p2.total);
  const dec = (i) => require(path.join(SRC, "jpeg-decoder.js"))(fs.readFileSync(path.join(run2.snap, rendered[i])), { useTArray: true, formatAsRGBA: false });
  const f1 = dec(0);
  assert.strictEqual(f1.width, 48); assert.strictEqual(f1.height, 40);
  const peak = dec(15 + p2.main.length + 2);            // flash at full white
  assert.ok(peak.data.every((v) => v > 240), "flash peak is white");
  assert.strictEqual(rec.meta.exports.length, 3);
  console.log("ffmpeg export ok:", res2.message);

  // ---- ffmpeg failing reports its error and keeps the frames
  ffFail = true;
  await assert.rejects(exporter.run(rec, settings.get(), target("fail.mp4"), { progress() {}, cancelled: () => false }),
    (e) => /ffmpeg stopped with an error: Unknown encoder/.test(e.message) && !!e.folderPath);
  assert.ok(fs.existsSync(path.join(rec.folder.nativePath, "_render")), "frames kept after a failure");
  ffFail = false;
  assert.strictEqual(rec.meta.exports.length, 3, "failed export not recorded");
  console.log("ffmpeg failure ok");

  // ---- cancel cleans up
  settings.set("encoder", "photoshop");
  let calls = 0;
  await assert.rejects(exporter.run(rec, settings.get(), target("x.mp4"), { progress() {}, cancelled: () => ++calls > 3 }), (e) => e.cancelled === true);
  assert.ok(!fs.existsSync(path.join(rec.folder.nativePath, "_render")), "cancel removes _render");
  assert.strictEqual(rec.meta.exports.length, 3, "cancelled export not recorded");
  console.log("cancel ok");

  // ---- clear frames
  await store.clearFrames(rec);
  recorder.afterClear(rec.id);
  assert.strictEqual(fs.readdirSync(path.join(rec.folder.nativePath, "frames")).length, 0);
  assert.strictEqual(rec.meta.frames.length, 0);
  assert.strictEqual(rec.meta.exports.length, 3, "export history kept");
  reopened.edit(10, 50); fire("historyStateChanged", { documentID: 2 }); await sleep(600);
  assert.strictEqual(rec.meta.frames.length, 1, "records again after clear");
  console.log("clear ok");

  // ---- undo that switches a layer on/off (Photoshop puts back the visibility a step had)
  settings.set("hideUndone", false);                 // undo steps are recorded
  reopened.visInHistory = true;
  const ln = reopened.layers[2];
  const px = (n, x, y) => {
    const d = require(path.join(SRC, "jpeg-decoder.js"))(fs.readFileSync(path.join(rec.folder.nativePath, "frames", "f_" + String(n).padStart(6, "0") + ".jpg")), { useTArray: true, formatAsRGBA: false });
    const i = (y * d.width + x) * 3; return [d.data[i], d.data[i + 1], d.data[i + 2]];
  };
  const lastPx = (x, y) => px(frames(rec)[frames(rec).length - 1].n, x, y);
  const dark = (p) => p[0] < 60 && p[1] < 60 && p[2] < 60;
  assert.strictEqual(ln.visible, true);
  reopened.edit(20, 30 * 48 + 2); fire("historyStateChanged", { documentID: 2 }); await sleep(600);
  let n0 = frames(rec).length;
  ln.visible = false; fire("hide"); await sleep(600);
  assert.strictEqual(frames(rec).length, n0, "hiding doesn't record");
  reopened.edit(20, 32 * 48 + 2); fire("historyStateChanged", { documentID: 2 }); await sleep(600);
  assert.strictEqual(frames(rec).length, n0 + 1, "edit while hidden records");
  assert.ok(!dark(lastPx(44, 10)), "recorded as it looks (Lines hidden)");
  const visSets = stats.visSets, resumes = stats.resume.length;
  reopened.undo(); fire("historyStateChanged", { documentID: 2 }); await sleep(600);
  assert.strictEqual(ln.visible, true, "the undo switched Lines back on");
  assert.strictEqual(frames(rec).length, n0 + 2, "undo recorded");
  assert.ok(!dark(lastPx(44, 10)), "undo frame keeps Lines hidden");
  assert.ok(dark(lastPx(2, 32)) === false && lastPx(2, 32)[2] > 200, "undo frame shows the stroke undone");
  assert.strictEqual(ln.visible, true, "Lines put back after the capture");
  assert.ok(stats.visSets > visSets && stats.resume.length > resumes && stats.resume.slice(resumes).every((c) => c === false), "switched inside rolled-back history");
  reopened.redo(); fire("historyStateChanged", { documentID: 2 }); await sleep(600);
  assert.strictEqual(ln.visible, false, "redo hides Lines again");
  assert.ok(!dark(lastPx(44, 10)), "redo frame: still hidden");
  reopened.undo(); fire("historyStateChanged", { documentID: 2 }); await sleep(600);
  n0 = frames(rec).length;
  reopened.edit(20, 34 * 48 + 2); fire("historyStateChanged", { documentID: 2 }); await sleep(600);
  assert.strictEqual(frames(rec).length, n0 + 1);
  assert.ok(dark(lastPx(44, 10)), "next real edit is recorded as it looks (Lines visible)");
  // an undoable toggle whose show/hide event never arrives: the history state alone is recognised
  n0 = frames(rec).length;
  ln._vis = false;
  reopened.hist.push({ id: nextHistId++, name: "Hide Layer", snapshot: false, paint: reopened.paint.slice(), w: reopened.width, h: reopened.height, vis: reopened.layers.map((l) => l._vis) });
  reopened.active = reopened.hist.length - 1;
  fire("historyStateChanged", { documentID: 2 }); await sleep(600);
  assert.strictEqual(frames(rec).length, n0, "toggle as a history state (no event) not recorded");
  reopened.undo(); fire("historyStateChanged", { documentID: 2 }); await sleep(600);
  assert.strictEqual(ln.visible, true);
  assert.strictEqual(frames(rec).length, n0, "undoing the toggle: nothing new to record");
  settings.set("hideUndone", true);
  console.log("undo visibility ok");

  // ---- a frame waits for a quiet moment: activity (e.g. switching tools) pushes it back, up to the limit
  {
    Object.assign(recorder._timing, { settleMs: 400, maxWaitMs: 1500, lockedSettleMs: 400, lockedMaxWaitMs: 1500 });
    app.activeDocument = reopened; fire("select"); await sleep(300);
    const n0 = frames(rec).length;
    reopened.edit(30, 1000, [10, 90, 160]); fire("historyStateChanged", { documentID: 2 });
    await sleep(300); fire("select");                          // switching tools 0.3 s after the stroke
    await sleep(250);
    assert.strictEqual(frames(rec).length, n0, "no frame while you're switching tools");
    await sleep(400);
    assert.strictEqual(frames(rec).length, n0 + 1, "frame once it's quiet");
    // busy without a pause: still a frame by the limit
    reopened.edit(30, 1200, [160, 90, 10]); fire("historyStateChanged", { documentID: 2 });
    const t0 = Date.now();
    while (frames(rec).length === n0 + 1 && Date.now() - t0 < 3000) { fire("set"); await sleep(150); }
    const waited = Date.now() - t0;
    assert.strictEqual(frames(rec).length, n0 + 2, "frame taken anyway");
    assert.ok(waited >= 1400 && waited < 2200, "after about the limit: " + waited + " ms");
    Object.assign(recorder._timing, baseTiming);
    console.log("quiet-moment capture ok");
  }

  // ---- reference layers: one layer list per step, the switch in one call, a longer pause before the locked grab
  {
    const gd = new MockDoc(8, "Groups.psd", 64, 48);
    // top first, like the DOM: a reference inside a visible group, a hidden group with a tagged layer
    // (doesn't count), a tagged group (only the group gets hidden), a plain layer at the bottom
    gd.layers = [
      group("Inks", [layer("Lines", [0, 0, 10, 10], [0, 0, 0]), layer("Photo [ref]", [20, 20, 40, 40], [255, 0, 0])]),
      group("Old", [layer("Old sketch [ref]", [0, 30, 10, 40], [0, 255, 0])]),
      group("Refs [ref]", [layer("Pose", [44, 0, 60, 10], [0, 0, 255]), layer("Hands", [44, 20, 60, 30], [0, 0, 255])]),
      layer("Paint", [60, 40, 64, 48], [240, 240, 240])   // (the mock paints later layers on top, so this one stays small)
    ];
    gd.layers[1]._vis = false;
    app.documents.push(gd);
    const strip = (items) => items.map((l) => ({ id: l.id, name: l.name, visible: l.visible, parent: l.parent }));
    const fast = psutil.layerList(gd), slow = psutil.layerListDom(gd);
    assert.ok(fast, "the one-call layer list is understood");
    assert.deepStrictEqual(strip(fast), strip(slow), "the one-call list matches walking the DOM");
    assert.strictEqual(fast.length, 9);

    app.activeDocument = gd;
    fire("open"); await sleep(300);
    Object.assign(recorder._timing, { settleMs: 300, maxWaitMs: 2500, lockedSettleMs: 900, lockedMaxWaitMs: 4000 });
    const hides = stats.hideCmds.length, gets = stats.multiGets, modals = stats.modal;
    await recorder.toggleActive(); await sleep(600);
    const grec = store.list().find((h) => h.meta.name === "Groups");
    assert.strictEqual(frames(grec).length, 1, "first frame");
    const photo = gd.layers[0].layers[1], refs = gd.layers[2];
    assert.deepStrictEqual(stats.hideCmds.slice(hides).sort((a, b) => a - b), [photo.id, refs.id].sort((a, b) => a - b),
      "hides the reference layer and the tagged group, not what's inside it or the hidden group's layer");
    assert.ok(photo.visible && refs.visible && !gd.layers[1].visible, "everything put back");
    assert.ok(stats.multiGets > gets, "layers read in one call");
    const red = (p) => p[0] > 200 && p[1] < 80, blue = (p) => p[2] > 200 && p[0] < 80;
    const pxOf = (n, x, y) => { const d = require(path.join(SRC, "jpeg-decoder.js"))(fs.readFileSync(path.join(grec.folder.nativePath, "frames", "f_" + String(n).padStart(6, "0") + ".jpg")), { useTArray: true, formatAsRGBA: false }); const i = (y * d.width + x) * 3; return [d.data[i], d.data[i + 1], d.data[i + 2]]; };
    assert.ok(!red(pxOf(1, 30, 30)) && !blue(pxOf(1, 50, 5)), "no reference layers in the frame");

    // a stroke with a reference layer showing: no frame at the normal pause, one after the longer pause
    gd.edit(30, 64 * 45); fire("historyStateChanged", { documentID: 8 });
    await sleep(500);
    assert.strictEqual(frames(grec).length, 1, "waits longer while a reference layer is showing");
    await sleep(700);
    assert.strictEqual(frames(grec).length, 2, "frame after the longer pause");
    // our own hide/show of the reference layers doesn't count as you toggling layers
    gd.edit(30, 64 * 46); fire("historyStateChanged", { documentID: 8 });
    const n1 = stats.hideCmds.length;
    await sleep(1200);
    for (const id of [photo.id, refs.id]) { fire("hide", { null: [{ _ref: "layer", _id: id }, { _ref: "document", _id: 8 }] }); fire("show", { null: [{ _ref: "layer", _id: id }, { _ref: "document", _id: 8 }] }); }
    assert.ok(stats.hideCmds.length > n1, "it grabbed with the layers hidden");
    gd.edit(30, 64 * 47); fire("historyStateChanged", { documentID: 8 });
    await sleep(1200);
    assert.strictEqual(frames(grec).length, 4, "the late show/hide events didn't block the next frame");

    // reference layers hidden by you: back to the normal pause and no locking
    photo.visible = false; fire("hide"); await sleep(50);
    refs.visible = false; fire("hide"); await sleep(300);   // (an edit right on a toggle counts as the toggle)
    const m0 = stats.modal;
    gd.edit(30, 64 * 44); fire("historyStateChanged", { documentID: 8 });
    await sleep(500);
    assert.strictEqual(frames(grec).length, 5, "normal pause when no reference layer is showing");
    assert.strictEqual(stats.modal, m0, "no lock when nothing has to be hidden");

    // a Photoshop where the one-call list doesn't work: the DOM walk gives the same result
    multiGetWorks = false;
    photo.visible = true; fire("show"); await sleep(300);
    const h2 = stats.hideCmds.length;
    gd.edit(30, 64 * 43); fire("historyStateChanged", { documentID: 8 });
    await sleep(1200);
    assert.strictEqual(frames(grec).length, 6);
    assert.deepStrictEqual(stats.hideCmds.slice(h2), [photo.id], "same reference layer hidden without multiGet");
    multiGetWorks = true;
    assert.ok(stats.modal > modals);

    // getPixels refusing once (Photoshop or another plugin busy in a modal state): that frame is
    // grabbed inside a modal scope, but the next ones go back to not locking Photoshop
    photo.visible = false; fire("hide"); await sleep(300);
    Object.assign(recorder._timing, { settleMs: 300, maxWaitMs: 2500, lockedSettleMs: 300, lockedMaxWaitMs: 2500 });
    const step = async (offset) => { gd.edit(30, offset); fire("historyStateChanged", { documentID: 8 }); await sleep(500); };
    let f0 = frames(grec).length, m1 = stats.modal;
    pixelsNeedModal = 1;
    await step(64 * 42);
    assert.strictEqual(frames(grec).length, f0 + 1, "the frame is still saved");
    assert.strictEqual(stats.modal, m1 + 1, "that one grab was locked");
    const d1 = stats.direct;
    await step(64 * 41);
    assert.strictEqual(frames(grec).length, f0 + 2);
    assert.strictEqual(stats.modal, m1 + 1, "the next grab doesn't lock Photoshop");
    assert.strictEqual(stats.direct, d1 + 1, "...it's made directly");
    // refusing every time: after 3 in a row it stops trying the direct way for a while
    pixelsNeedModal = 1000;
    for (const off of [64 * 40, 64 * 39, 64 * 38]) await step(off);
    const fails = stats.directFails;
    await step(64 * 37);
    assert.strictEqual(stats.directFails, fails, "no more failing direct calls once it's known to need the lock");
    assert.strictEqual(frames(grec).length, f0 + 6, "every frame saved meanwhile");
    pixelsNeedModal = 0;
    Object.assign(recorder._timing, baseTiming);
    console.log("reference layers ok");
  }

  // ---- Remove flicker: a big fill that's painted away again right after is left out
  {
    const fd = new MockDoc(7, "Flicker.psd", 64, 48);
    app.documents.push(fd); app.activeDocument = fd;
    fire("open"); await sleep(300);
    await recorder.toggleActive(); await sleep(600);
    const frec = store.list().find((h) => h.meta.name === "Flicker");
    const step = async (fn) => { fn(); fire("historyStateChanged", { documentID: 7 }); await sleep(600); };
    await step(() => fd.edit(200, 0, [30, 30, 30]));                     // some lines
    await step(() => fd.edit(64 * 30, 64 * 10, [220, 30, 30]));          // a big red fill...
    await step(() => fd.edit(64 * 30, 64 * 10, [255, 255, 255]));        // ...painted away again
    await step(() => fd.edit(150, 64 * 44, [30, 30, 120]));              // more lines
    await step(() => fd.edit(150, 64 * 46, [30, 120, 30]));
    assert.strictEqual(frames(frec).length, 6, "every step recorded");
    settings.set("encoder", "ffmpeg"); settings.set("deflicker", true); settings.set("lengthSec", "auto");
    settings.set("introOn", false); settings.set("holdOn", false); settings.set("flashOn", false); settings.set("slowEnd", false); settings.set("timerOverlay", false);
    const e1 = exporter.estimate(frec, settings.get());
    assert.strictEqual(e1.uncheckedFrames, 6, "nothing checked yet");
    const progress = [];
    const r1 = await exporter.run(frec, settings.get(), new File(path.join(TMP, "flicker.mp4")), { progress: (f, t) => progress.push([f, t]), cancelled: () => false });
    assert.strictEqual(thumbRuns.length, 1, "ffmpeg made the thumbnails");
    assert.ok(thumbRuns[0].bat.includes("-lowres 3 -f concat") && thumbRuns[0].bat.includes("_flicker\\thumbs.raw"), thumbRuns[0].bat);
    assert.ok(/flicker check [\d.]+ s \(1 frame left out\)/.test(r1.message), r1.message);
    const used = fs.readdirSync(ffRuns[ffRuns.length - 1].snap).length;
    const pl = plan.planExport(5, { fps: 30, lengthSec: "auto", introSec: 0, flash: false, holdSec: 0, slowEnd: false });
    assert.strictEqual(used, pl.total, "video planned from the 5 frames left");
    assert.ok(progress.some(([f, t]) => /Checking for flicker/.test(t)), "progress shows the check");
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i][0] >= progress[i - 1][0] - 1e-9, "bar never goes backwards");
    assert.strictEqual(fs.statSync(path.join(frec.folder.nativePath, "thumbs32.bin")).size, 6 * 1028, "thumbnails cached");
    assert.ok(!fs.existsSync(path.join(frec.folder.nativePath, "_flicker")) && !fs.existsSync(path.join(frec.folder.nativePath, "check_flicker.bat")), "temp files removed");
    assert.strictEqual(exporter.estimate(frec, settings.get()).uncheckedFrames, 0);
    // second export: only new frames are checked
    await step(() => fd.edit(150, 64 * 20, [120, 30, 30]));
    await exporter.run(frec, settings.get(), new File(path.join(TMP, "flicker2.mp4")), { progress() {}, cancelled: () => false });
    assert.strictEqual(thumbRuns.length, 2);
    assert.strictEqual(thumbRuns[1].frames, 1, "only the new frame was checked");
    await exporter.run(frec, settings.get(), new File(path.join(TMP, "flicker3.mp4")), { progress() {}, cancelled: () => false });
    assert.strictEqual(thumbRuns.length, 2, "nothing new: no ffmpeg run for the check");
    // switched off: every frame goes in
    settings.set("deflicker", false);
    await exporter.run(frec, settings.get(), new File(path.join(TMP, "flicker4.mp4")), { progress() {}, cancelled: () => false });
    assert.strictEqual(fs.readdirSync(ffRuns[ffRuns.length - 1].snap).length, plan.planExport(7, { fps: 30, lengthSec: "auto", introSec: 0, flash: false, holdSec: 0, slowEnd: false }).total);
    // deleting frames drops the cache too
    await store.clearFrames(frec);
    assert.ok(!fs.existsSync(path.join(frec.folder.nativePath, "thumbs32.bin")), "cache removed with the frames");
    console.log("deflicker ok:", r1.message);
  }

  console.log("\nALL SIMULATION TESTS PASSED  (getPixels", stats.getPixels, "modal", stats.modal, "encodes", stats.encodes + ")");
  console.log("messages:", messages);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
