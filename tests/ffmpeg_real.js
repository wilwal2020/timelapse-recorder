// Runs the real launcher .vbs -> .bat -> ffmpeg chains on this PC (Windows only;
// needs ../ffmpeg/bin/ffmpeg.exe): the video encode, and the flicker check's
// thumbnails. Checks the output, the progress file and the exit-code file the
// panel waits for.
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync, spawn } = require("child_process");
const assert = require("assert");

const FFMPEG = path.join(__dirname, "..", "ffmpeg", "bin", "ffmpeg.exe");
if (process.platform !== "win32" || !fs.existsSync(FFMPEG)) { console.log("skipped (needs Windows and ffmpeg/bin/ffmpeg.exe)"); process.exit(0); }

const origLoad = Module._load;
Module._load = function (req) {
  if (req === "photoshop") return { core: {}, imaging: {}, action: {}, app: { documents: [] } };
  if (req === "uxp") return { storage: { localFileSystem: {}, formats: {} }, shell: {} };
  return origLoad.apply(this, arguments);
};
global.localStorage = { getItem: () => null, setItem() {} };
const { batScript, jobBat, thumbArgs } = require(path.join(__dirname, "..", "src", "exporter.js"))._scripts;
const launcher = require(path.join(__dirname, "..", "src", "launcher.js"));
const deflicker = require(path.join(__dirname, "..", "src", "deflicker.js"));

const ff = (...args) => execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args]);

// The launcher folder as the plugin sets it up in its data folder
const LAUNCH = fs.mkdtempSync(path.join(os.tmpdir(), "tlr launcher ø "));
const SCRIPT = path.join(LAUNCH, launcher._names.SCRIPT), JOBS = path.join(LAUNCH, launcher._names.JOBS);
fs.writeFileSync(SCRIPT, launcher._vbs);
fs.mkdirSync(JOBS);

// Leaves a "run <name>.bat" job, starts the launcher script (hidden) and waits for <workDir>/done.txt.
function runJob(rec, name, workDir) {
  const t0 = Date.now();
  fs.writeFileSync(path.join(JOBS, String(t0) + ".job"), "run\n" + path.join(rec, name + ".bat") + "\n", "utf8");
  spawn("wscript.exe", [SCRIPT], { detached: true, stdio: "ignore" }).unref();
  let sawProgress = false;
  return new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      const prog = path.join(workDir, "progress.txt");
      if (fs.existsSync(prog) && /frame=\d+/.test(fs.readFileSync(prog, "utf8"))) sawProgress = true;
      const done = path.join(workDir, "done.txt");
      if (fs.existsSync(done) && fs.readFileSync(done, "utf8").trim() !== "") {
        clearInterval(iv);
        const log = fs.existsSync(path.join(workDir, "ffmpeg_log.txt")) ? fs.readFileSync(path.join(workDir, "ffmpeg_log.txt"), "utf8").trim() : "";
        resolve({ code: fs.readFileSync(done, "utf8").trim(), log, sawProgress, ms: Date.now() - t0 });
      }
      if (Date.now() - t0 > 60000) { clearInterval(iv); reject(new Error(name + ": ffmpeg never finished")); }
    }, 200);
  });
}

(async () => {
  // a recording folder with spaces, brackets and non-ASCII letters, like real ones can have
  const rec = fs.mkdtempSync(path.join(os.tmpdir(), "tlr real æøå (1a2b3c4d) "));

  // ---- the video
  const render = path.join(rec, "_render");
  fs.mkdirSync(render);
  // mixed canvas sizes, like a recording with imported frames or a crop; ffmpeg fits them all to the last size
  for (const [size, count, start] of [["1257x1649", 60, 1], ["1023x1342", 20, 61], ["1462x1920", 70, 81]]) {
    ff("-f", "lavfi", "-i", "testsrc2=size=" + size + ":rate=30", "-frames:v", String(count), "-q:v", "3", "-start_number", String(start), path.join(render, "frame_%06d.jpg"));
  }
  const out = path.join(rec, "My timelapse ø.mp4");
  fs.writeFileSync(path.join(rec, "make_video.bat"), batScript(out, 30, FFMPEG, 1462, 1920, [0, 0, 0]));
  const v = await runJob(rec, "make_video", render);
  assert.deepStrictEqual(fs.readdirSync(JOBS), [], "the launcher took the job");
  assert.strictEqual(v.code, "0", "exit code (log: " + v.log + ")");
  assert.ok(v.sawProgress, "progress file was written");
  assert.ok(/frame=150/.test(fs.readFileSync(path.join(render, "progress.txt"), "utf8")), "progress reached the last frame");
  const size = fs.statSync(out).size;
  assert.ok(size > 100000, "video written");
  ff("-i", out, "-f", "null", "-");                               // throws if the video doesn't decode
  let info = "";
  try { execFileSync(FFMPEG, ["-hide_banner", "-i", out], { stdio: ["ignore", "ignore", "pipe"] }); }
  catch (e) { info = String(e.stderr); }                         // ffmpeg -i with no output exits 1 after printing the info
  assert.ok(/1462x1920/.test(info), "every frame fitted to 1462x1920: " + info);
  assert.ok(/yuv420p\(tv/.test(info), "standard video colour range: " + info);
  console.log("REAL FFMPEG CHAIN OK: " + (size / 1048576).toFixed(1) + " MB in " + (v.ms / 1000).toFixed(1) + " s, no console window");

  // ---- the flicker check: greys getting slowly darker, one red frame flashing in between,
  // mixed canvas sizes and a gap in the frame numbers
  const frames = path.join(rec, "frames"), work = path.join(rec, "_flicker");
  fs.mkdirSync(frames); fs.mkdirSync(work);
  const seq = [[1, "0xf0f0f0", "1200x1600"], [2, "0xe6e6e6", "1200x1600"], [3, "0xdcdcdc", "1200x1600"], [5, "0xd02020", "1200x1600"],
               [6, "0xd2d2d2", "900x1200"], [7, "0xc8c8c8", "900x1200"], [9, "0xbebebe", "1462x1920"], [10, "0xb4b4b4", "1462x1920"]];
  for (const [n, color, sz] of seq) ff("-f", "lavfi", "-i", "color=c=" + color + ":s=" + sz, "-frames:v", "1", "-q:v", "3", path.join(frames, "f_" + String(n).padStart(6, "0") + ".jpg"));
  fs.writeFileSync(path.join(work, "list.txt"), "ffconcat version 1.0\n" + seq.map(([n]) => "file '../frames/f_" + String(n).padStart(6, "0") + ".jpg'").join("\n") + "\n");
  fs.writeFileSync(path.join(rec, "check_flicker.bat"), jobBat(FFMPEG, "_flicker", thumbArgs("\\")));
  const t = await runJob(rec, "check_flicker", work);
  assert.strictEqual(t.code, "0", "exit code (log: " + t.log + ")");
  const raw = fs.readFileSync(path.join(work, "thumbs.raw"));
  assert.strictEqual(raw.length, seq.length * 1024, "one 32x32 thumbnail per frame");
  const thumbs = seq.map((s, i) => raw.subarray(i * 1024, (i + 1) * 1024));
  assert.deepStrictEqual(deflicker.findFlicker(thumbs), [3], "the red frame (and only that one) is flicker");
  console.log("REAL FLICKER CHECK OK: " + seq.length + " frames in " + (t.ms / 1000).toFixed(1) + " s");

  fs.rmSync(rec, { recursive: true, force: true });
  fs.rmSync(LAUNCH, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
