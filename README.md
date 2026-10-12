# Timelapse Recorder

A Photoshop (UXP) panel that records a timelapse of your painting while you work. It saves a
frame after every real edit and exports an MP4. Showing or hiding layers is never recorded,
so comparing layers doesn't make the video flicker.

## The panel

Three tabs: **Record**, **Library** and **Settings**. A green dot on the Record tab means a
document is being recorded.

**Record tab**
- **Auto record** at the very top: automatically records whatever document you're on (a document
  you pause by hand stays paused)
- The record button: **Start recording**, then green **Recording** while it's active
  (click to pause), and grey **Paused** when paused (click to resume)
- **Export video** (**Export again** once the document has been exported) opens a small box with
  the length, **Advanced settings** and **Confirm**. While the box is open, the button reads
  **Cancel**. Confirm asks where to save the MP4.
- After an export: **Remember this folder**, **Play video** and **Show in folder**. Once a folder is
  remembered, the export box offers **Use remembered folder**, which saves straight there without
  asking (as "Name timelapse.mp4", "Name timelapse 2.mp4", …).
- Frames, work time and disk usage, with the document name underneath
- **Preview** (in the file name bar) shows or hides the latest frame
- **Reference layer** card: shows the selected layer and whether it's recorded, with a
  **Normal / Reference** switch. Reference adds `[ref]` to the selected layers' names: the layer
  works as a normal layer but won't show up in the timelapse. Normal removes the tag again. With
  several layers selected it shows how many are references ("1 of 3 not recorded").

**Export settings** (for the document you're on)
- Length: **Auto** (every frame once, 5 s – 1 min) or 10 s – 5 min
- Show the finished drawing first (0.5–5 s)
- Flash before the final image
- Hold the final image (1–10 s)
- Slow down at the end
- Remove flicker: leaves out frames that flash in and out (a layer hidden for a moment, a stroke
  undone right away, a colour you tried for a second). A frame (or 2–3 in a row) is left out when it
  differs from the frames on both sides while those two match each other (the TimeSplice method at
  sensitivity 200). ffmpeg makes a 32×32 greyscale thumbnail of every frame for this; they're kept
  in `thumbs32.bin` in the recording folder, so after the first export only new frames are checked
  (the first check of ~5,000 frames takes about 30 s). The first and last frame are always kept.
- Work-time counter in a corner you choose
- Make the video with **ffmpeg (fast)**, the default, or **Photoshop (slower)**
- Bar colour for when the canvas size changed during recording

**Library**
- Every recording with frame count, disk usage, work time and last update
- Shows **EXPORTED** / **NOT EXPORTED**, and notes if you recorded more after the last export
- Delete frames always asks first, with a stronger warning if the recording was never exported.
- Once a recording has 0 frames, **Delete folder** removes the recording and its folder (after
  asking; not while it's recording). Exported videos are kept.
- Recordings are listed by when something was last recorded, so deleting frames or exporting
  doesn't reorder the list.
  Your videos and the work timer are kept.

**Settings**
- Frames folder (where recorded frames are kept; videos go wherever you choose when exporting)
- Quality: Low / Default / High (frames are never larger than your canvas)
- Remove frames with undo: undoing something removes those recorded frames
- Reference layers: the name tag, picked from a list (`[ref]`, `[reference]`, `(ref)`, `#ref`, `_ref`)
- Work timer: stops counting after 5 s – 1 min without activity

## How recording works
- A frame is saved shortly after each edit: brush strokes, fills, transforms, filters, text,
  layer changes. Rapid strokes are batched, so a frame is never taken mid-stroke; switching tools
  while a frame is waiting pushes it back a little.
- **With a reference layer showing**, every frame has to hide it for a moment, which briefly locks
  Photoshop (a stroke or shortcut right then would wait). So those frames wait for a longer pause:
  1 s without activity, or at most 6 s while you keep working. Hide the reference layer and frames
  are taken without locking anything. The plugin reads all layers in one request to Photoshop and
  switches them with one command, so the lock stays short even in documents with many layers.
- `timelapse-log.txt` in the recordings folder is a diagnostic log of what the recorder asks of
  Photoshop and how long each step takes (for tracking down slowdowns).
- **Non-edits are skipped:** showing/hiding layers, selecting layers, zooming, panning, switching
  tools and picking colours. After you toggle a layer, nothing is captured until your next real
  edit, so toggling on and off never makes a frame. Anything you paint while a layer is hidden is
  recorded as it looks.
- **Undo doesn't sneak visibility changes in either:** when an undo switches a layer on or off
  (Photoshop puts back the visibility the layers had at that step), frames saved for the undo
  keep that layer the way the video last showed it. Your next real edit is recorded as it looks.
  Toggles that Photoshop records as history steps ("Make Layer Visibility Changes Undoable") are
  recognised and skipped too.
- Frames where (almost) nothing visible changed are skipped automatically.
- Each open document has its own recording. The recording ID is stored in the file, so reopening
  the PSD (even renamed or moved) continues the same recording automatically.
- When the document gets a new name (Save As, or renamed while closed), the recording and its
  folder are renamed to match, e.g. `Untitled-2 (b26b3312)` becomes `Tree (b26b3312)`.
- Crops and canvas resizes are handled: at export, earlier frames are fitted into the final size.

## Installing

Double-click **`TimelapseRecorder.ccx`** to install it through Creative Cloud, then open
**Plugins → Timelapse Recorder** in Photoshop. Photoshop 2024 (25.0) or newer is required.

The first time you press **Start recording**, you choose a folder for the recordings.

## Where things are saved

```
<your recordings folder>/
  Portrait (1a2b3c4d)/
    recording.json         frame list, work time, export history
    frames/f_000001.jpg …  the captured frames
    make_video.bat         (only after an ffmpeg export)
```

Videos go wherever you choose when exporting. While exporting, a temporary `_render` folder is
created in the recording folder and removed afterwards.

## Exporting with ffmpeg

ffmpeg is included in the plugin (`bin/ffmpeg.exe`, added by `build.py` from the `ffmpeg/` folder)
and is the default. It encodes a 150-frame 1080p video in about 2 seconds. UXP plugins can't start
programs directly, so the plugin writes `make_video.bat` and has a small helper script run it
without a console window. ffmpeg writes its progress
to a file the panel reads, so the progress bar is real, and the panel knows when the video is done.
If something goes wrong, the error from ffmpeg is shown and the prepared frames are kept.

## Photoshop's permission prompt

Photoshop asks before a plugin opens a file or starts a program, and a remembered answer only
applies to the path it asked about. So everything the panel opens (starting ffmpeg, **Play video**,
**Show in folder**, **Open folder**) goes through one helper script that always sits at the same place,
`launcher/Timelapse Recorder.vbs` in the plugin's data folder. The panel leaves a small job file
next to it saying what to run or open, and the helper does it. Allow it once with **remember my choice**
and it won't ask again. (Windows only. On macOS files are opened directly.)

## Good to know

- With **Photoshop (slower)**, nearly all the time is Photoshop's Render Video, which works through
  every frame of the video (a short recording still makes at least a 5-second video, i.e. 150
  frames). It can't report progress, so the bar follows an estimate that learns from your previous
  exports. The message afterwards says how long each step took.
- Frames are copied as-is unless they need drawing on (timer overlay, the flash). With ffmpeg,
  frames from a different canvas size (a crop, imported frames) are scaled and letterboxed by
  ffmpeg while it encodes, which is fast. The plugin only redraws them itself with the Photoshop
  export, at roughly 0.3 s per frame.
- If Photoshop's automatic Render Video step ever fails, the error says so. The prepared frames
  stay in `_render`: open the first one with **File → Open** and tick **Image Sequence**, then use
  **File → Export → Render Video**. You can also switch the export to ffmpeg.
- Unsaved documents are linked to their recording once saved (the ID is written into the file).
- The work timer keeps counting until the idle limit has passed, then stops until your next action.

## Project layout

- `src/` — the plugin source
  - `manifest.json` — plugin metadata, panel entry point, permissions
  - `index.html` — panel layout and styles
  - `main.js` — panel UI
  - `recorder.js` — edit detection, capturing, undo tracking, work timer, reference layers
  - `exporter.js` — export pipeline (Photoshop Render Video / ffmpeg)
  - `deflicker.js` — finds flicker frames from 32×32 thumbnails
  - `launcher.js` — the one helper script everything is opened through (see the permission prompt)
  - `store.js` — recordings on disk
  - `psutil.js` — Photoshop helpers and the recording ID in XMP metadata
  - `plan.js` — which recorded frame goes into each video frame
  - `raster.js` — resizing, letterboxing, frame comparison, flash, the timer badge
  - `settings.js` — saved settings
  - `b64.js` — base64 helpers
  - `jpeg-decoder.js` — vendored JPEG decoder (jpeg-js, BSD-3 / Apache-2.0)
  - `icons/` — panel and plugin icons (generated by `make_icons.py`)
- `tests/` — offline tests that run the plugin against a simulated Photoshop, plus a check that
  runs the real ffmpeg scripts (`cd tests`, `npm install`, `npm test`)
- `ffmpeg/` — the ffmpeg build that gets bundled into the package (not part of `src/`)
- `build.py` / `build.ps1` — package `src/` into `TimelapseRecorder.ccx`

## Building

```
python build.py            # bump patch version (1.1.0 -> 1.1.1), then build
python build.py --no-bump  # rebuild without changing the version
python build.py --minor    # bump minor
python build.py --major    # bump major
```

Current version: **1.5.20** (set in `src/manifest.json`)
