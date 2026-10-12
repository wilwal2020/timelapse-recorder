"use strict";
/*
 * Opening files and starting ffmpeg without a permission prompt every time.
 *
 * Photoshop asks before a plugin opens anything (shell.openPath), and a
 * remembered answer is tied to the path it asked about. Exports used to open
 * fresh scripts in each recording folder, and Play video / Show in folder a
 * different file or folder every time, so it kept asking. Now everything goes
 * through one helper script that always sits at the same place:
 *
 *   <plugin data folder>/launcher/
 *     Timelapse Recorder.vbs   does the jobs below, then deletes them
 *     jobs/<time>-<n>.job      "run" + a .bat (started hidden),
 *                              "open" + a file or folder
 *
 * Allowing that script once (with "remember my choice") covers every later
 * export, Play video and Show in folder. Windows only; elsewhere, and if the
 * helper can't be set up, paths are opened directly as before.
 */

const { storage, shell } = require("uxp");
const { localFileSystem: lfs } = storage;
const store = require("./store.js");

const DIR = "launcher";
const SCRIPT = "Timelapse Recorder.vbs";
const JOBS = "jobs";
// Shown in Photoshop's prompt. Kept the same for every job, like the path.
const WHY = "Timelapse Recorder's helper: starts ffmpeg to make your videos and opens videos and folders for you.";

const VBS = [
  "' Timelapse Recorder helper: does the jobs the panel leaves in the jobs folder.",
  "Option Explicit",
  "Dim fso, jobs, f, names, p, taken, lines",
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  'jobs = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "jobs")',
  "If Not fso.FolderExists(jobs) Then WScript.Quit",
  "names = Array()",
  "For Each f In fso.GetFolder(jobs).Files",
  '  If LCase(fso.GetExtensionName(f.Name)) = "job" Then',
  "    ReDim Preserve names(UBound(names) + 1)",
  "    names(UBound(names)) = f.Path",
  "  End If",
  "Next",
  "For Each p In names",
  "  ' claim the job first, so two copies of this script never both do it",
  '  taken = p & ".taken"',
  "  On Error Resume Next",
  "  fso.MoveFile p, taken",
  "  If Err.Number = 0 Then",
  "    On Error GoTo 0",
  '    lines = Split(Replace(ReadUtf8(taken), vbCr, ""), vbLf)',
  "    On Error Resume Next",
  "    fso.DeleteFile taken, True",
  "    On Error GoTo 0",
  "    If UBound(lines) >= 1 Then DoJob lines(0), lines(1)",
  "  End If",
  "  On Error GoTo 0",
  "Next",
  "",
  "Sub DoJob(kind, target)",
  "  If target = \"\" Then Exit Sub",
  '  If kind = "run" And LCase(fso.GetExtensionName(target)) = "bat" Then',
  "    ' hidden; the extra quotes keep cmd from mangling paths with spaces or brackets",
  '    CreateObject("WScript.Shell").Run "cmd /c """"" & target & """""", 0, False',
  '  ElseIf kind = "open" Then',
  '    CreateObject("Shell.Application").ShellExecute target, "", "", "open", 1',
  "  End If",
  "End Sub",
  "",
  "Function ReadUtf8(path)",
  "  Dim s",
  '  ReadUtf8 = ""',
  "  On Error Resume Next",
  '  Set s = CreateObject("ADODB.Stream")',
  "  s.Type = 2",
  '  s.Charset = "utf-8"',
  "  s.Open",
  "  s.LoadFromFile path",
  "  ReadUtf8 = s.ReadText(-1)",
  "  s.Close",
  "End Function"
].join("\r\n") + "\r\n";

function isWindows() {
  try { return require("os").platform() === "win32"; } catch (e) { /* fall through */ }
  try { return /win/i.test(navigator.platform); } catch (e) { return true; }
}

let ready = null;   // Promise of { script, jobs } (or null when the helper can't be used)

async function setUp() {
  if (!isWindows()) return null;
  const dir = await store.ensureFolder(await lfs.getDataFolder(), DIR);
  const jobs = await store.ensureFolder(dir, JOBS);
  // jobs left over from an earlier session (e.g. a prompt that was declined) must not run later
  for (const e of await jobs.getEntries()) { try { await e.delete(); } catch (err) { /* in use */ } }
  let script = await store.tryGet(dir, SCRIPT);
  let current = null;
  if (script) { try { current = await script.read({ format: storage.formats.utf8 }); } catch (e) { current = null; } }
  // rewritten only when it changed, so the helper stays exactly the file that was allowed
  if (current !== VBS) script = await store.writeText(dir, SCRIPT, VBS);
  return { script, jobs };
}

function helper() {
  if (!ready) ready = setUp().catch((e) => { console.warn("Timelapse: launcher unavailable", e); return null; });
  return ready;
}

let seq = 0;
function jobName() {
  const t = String(Date.now()).padStart(15, "0");
  return t + "-" + String(++seq).padStart(4, "0") + ".job";
}

async function openDirect(path, why) {
  try { return (await shell.openPath(path, why)) || ""; }
  catch (e) { return (e && e.message) || String(e); }
}

// Leaves a job for the helper and starts it. Returns "" or an error text.
async function job(kind, path) {
  const h = await helper();
  if (!h) return null;
  let file;
  try { file = await store.writeText(h.jobs, jobName(), kind + "\n" + path + "\n"); }
  catch (e) { return null; }
  const err = await openDirect(h.script.nativePath, WHY);
  if (err) { try { await file.delete(); } catch (e) { /* the helper may have taken it */ } }
  return err;
}

// Runs a .bat without a console window. "" when it was started, otherwise why not.
async function runBat(path) {
  const err = await job("run", path);
  return err === null ? "the helper script couldn't be set up" : err;
}

// Opens a file with its app, or a folder in Explorer. "" or an error text.
async function open(path, why) {
  const err = await job("open", path);
  return err === null ? openDirect(path, why) : err;
}

module.exports = { runBat, open, _vbs: VBS, _names: { DIR, SCRIPT, JOBS } };
