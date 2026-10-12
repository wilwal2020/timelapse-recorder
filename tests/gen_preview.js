// Builds preview.html: the real panel + modules bundled with in-browser mocks,
// so the layout can be checked in a normal browser.
const fs = require("fs");
const path = require("path");
const SRC = path.join(__dirname, "..", "src");
const mods = ["settings.js", "store.js", "raster.js", "b64.js", "plan.js", "psutil.js", "diag.js", "recorder.js", "deflicker.js", "launcher.js", "exporter.js", "jpeg-decoder.js"];
let bundle = "const __src = {};\n";
for (const m of mods) {
  bundle += "__src['./" + m + "'] = function (module, exports, require) {\n" + fs.readFileSync(path.join(SRC, m), "utf8") + "\n};\n";
}
const mocks = `
// ---- in-memory storage ----
const FS = new Map(); // path -> Uint8Array | string | "DIR"
FS.set("C:/Timelapses", "DIR");
class Entry { constructor(p) { this.nativePath = p; this.name = p.split("/").pop(); }
  get isFolder() { return FS.get(this.nativePath) === "DIR"; } get isFile() { return FS.has(this.nativePath) && !this.isFolder; }
  async delete() { FS.delete(this.nativePath); }
  async moveTo(f, o) { const d = f.nativePath + "/" + ((o && o.newName) || this.name); FS.set(d, FS.get(this.nativePath)); FS.delete(this.nativePath); this.nativePath = d; } }
class File extends Entry { async read(o) { const v = FS.get(this.nativePath); return o && o.format === "binary" ? v.buffer : v; }
  async write(d, o) { FS.set(this.nativePath, o && o.format === "binary" ? new Uint8Array(d.slice(0)) : d); } }
class Folder extends Entry {
  async getEntries() { const pre = this.nativePath + "/"; return [...FS.keys()].filter(k => k.startsWith(pre) && !k.slice(pre.length).includes("/")).map(k => FS.get(k) === "DIR" ? new Folder(k) : new File(k)); }
  async getEntry(n) { const p = this.nativePath + "/" + n; if (!FS.has(p)) throw new Error("nf"); return FS.get(p) === "DIR" ? new Folder(p) : new File(p); }
  async createFile(n) { const p = this.nativePath + "/" + n; FS.set(p, ""); return new File(p); }
  async createFolder(n) { const p = this.nativePath + "/" + n; FS.set(p, "DIR"); return new Folder(p); } }
const uxpMock = { storage: { formats: { utf8: "utf8", binary: "binary" }, localFileSystem: {
  getFolder: async () => new Folder("C:/Timelapses"), createPersistentToken: async (e) => e.nativePath,
  getEntryForPersistentToken: async (t) => new Folder(t), createSessionToken: (e) => e.nativePath, getFileForOpening: async () => null, getFileForSaving: async () => null } },
  shell: { openPath: async () => "", openExternal: async () => "" } };
// ---- photoshop ----
let hid = 1; let listener = null;
const app = { documents: [], activeDocument: null };
function mkDoc(id, name, w, h) {
  const d = { id, name, title: name, path: "C:/art/" + name, xmp: "", width: w, height: h, layers: [{ name: "Sketch", visible: true }], strokes: 0,
    hist: [{ id: hid++, snapshot: false }], active: 0 };
  d.activeLayers = [d.layers[0]];
  Object.defineProperty(d, "historyStates", { get: () => d.hist });
  Object.defineProperty(d, "activeHistoryState", { get: () => d.hist[d.active] });
  d.edit = () => { d.strokes++; d.hist.push({ id: hid++, snapshot: false }); d.active = d.hist.length - 1; };
  return d;
}
function paint(d, w, h) {
  const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d");
  const grd = g.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, "#f3e7d3"); grd.addColorStop(1, "#e8d2b0"); g.fillStyle = grd; g.fillRect(0, 0, w, h);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cols = ["#2f4858", "#33658a", "#86bbd8", "#f6ae2d", "#f26419", "#6b4226"];
  for (let i = 0; i < d.strokes * 6; i++) { g.strokeStyle = cols[i % cols.length]; g.lineWidth = 3 + rnd() * 14; g.lineCap = "round";
    g.beginPath(); const x = rnd() * w, y = rnd() * h; g.moveTo(x, y); g.quadraticCurveTo(x + rnd() * 120 - 60, y + rnd() * 120 - 60, x + rnd() * 200 - 100, y + rnd() * 160 - 80); g.stroke(); }
  return g.getImageData(0, 0, w, h);
}
const psMock = { app,
  action: { addNotificationListener: (e, fn) => { listener = fn; },
    batchPlay: async (cmds) => cmds.map((c) => { const d = c._target && c._target[1] && app.documents.find(x => x.id === c._target[1]._id);
      if (c._obj === "get") return { XMPMetadataAsUTF8: d ? d.xmp : "" }; if (c._obj === "set") { d.xmp = c.to.XMPMetadataAsUTF8; } return {}; }) },
  core: { executeAsModal: async (fn) => fn({ hostControl: { suspendHistory: async () => 1, resumeHistory: async () => {} } }) },
  imaging: {
    getPixels: async (o) => { const d = app.documents.find(x => x.id === o.documentID); const w = o.targetSize.width, h = o.targetSize.height;
      const id = paint(d, w, h); const px = new Uint8Array(w * h * 3); for (let i = 0, j = 0; i < id.data.length; i += 4, j += 3) { px[j] = id.data[i]; px[j+1] = id.data[i+1]; px[j+2] = id.data[i+2]; }
      return { imageData: { width: w, height: h, components: 3, _px: px, getData: async () => px, dispose() {} } }; },
    encodeImageData: async ({ imageData, base64 }) => { const c = document.createElement("canvas"); c.width = imageData.width; c.height = imageData.height;
      const g = c.getContext("2d"); const id = g.createImageData(c.width, c.height); for (let i = 0, j = 0; j < imageData._px.length; i += 4, j += 3) { id.data[i] = imageData._px[j]; id.data[i+1] = imageData._px[j+1]; id.data[i+2] = imageData._px[j+2]; id.data[i+3] = 255; }
      g.putImageData(id, 0, 0); const url = c.toDataURL("image/jpeg", 0.9); const b64 = url.slice(url.indexOf(",") + 1);
      if (base64) return b64; const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; },
    createImageDataFromBuffer: async (buf, o) => ({ width: o.width, height: o.height, components: 3, _px: buf, getData: async () => buf, dispose() {} }) } };
// ---- tiny CommonJS ----
const __cache = {};
function require(name) {
  if (name === "photoshop") return psMock; if (name === "uxp") return uxpMock; if (name === "os") return { platform: () => "win32" };
  if (__cache[name]) return __cache[name].exports;
  const module = { exports: {} }; __cache[name] = module; __src[name](module, module.exports, require); return module.exports;
}
`;
const demo = `
(async () => {
  const d = mkDoc(1, "Forest study.psd", 3000, 2000);
  app.documents.push(d); app.activeDocument = d;
  await new Promise(r => setTimeout(r, 400));
  listener("open", {});
  await new Promise(r => setTimeout(r, 1200));
  if (location.hash === "#idle") return;
  document.getElementById("btnRecord").click();
  for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 500)); d.edit(); listener("historyStateChanged", { documentID: 1 }); }
  const tab = location.hash.slice(1);
  await new Promise(r => setTimeout(r, 800));
  const pill = (id) => document.getElementById(id).querySelector(".chk").click();
  if (tab === "export") document.getElementById("btnExportOpen").click();
  else if (tab === "adv") { document.getElementById("btnExportOpen").click(); document.getElementById("btnAdvanced").click(); pill("chkIntro"); pill("chkHold"); pill("chkDeflicker"); }
  else if (tab === "auto") { pill("chkAuto"); document.getElementById("btnPreview").click(); }
  else if (tab) document.querySelector('.tab[data-tab="' + tab + '"]').click();
  document.title = "ready";
})();
`;
let html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const main = fs.readFileSync(path.join(SRC, "main.js"), "utf8");
html = html.replace('<script src="main.js"></script>', () => "<script>\n" + mocks + bundle + "\n" + main + "\n" + demo + "\n</script>");
fs.writeFileSync(path.join(__dirname, "preview.html"), html);
console.log("wrote preview.html", html.length);
