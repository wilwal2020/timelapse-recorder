#!/usr/bin/env python3
"""Adopt frames from another timelapse tool into a Timelapse Recorder recording.

Put the other tool's frames (numbered JPEGs such as 000001.jpg) in the
recording's frames/ folder, then run:

    python import_frames.py "<recording folder>"           # dry run: shows what would happen
    python import_frames.py "<recording folder>" --apply   # do it

The imported frames go first (in number order), followed by the frames the
plugin itself recorded. Files are renamed to f_000001.jpg ..., and
recording.json gets an entry per frame (size, capture time from the file date,
estimated work time). A backup of recording.json and a rename log are written
first. Close Photoshop before applying: the plugin keeps the recording in memory.
"""
import json
import os
import re
import struct
import sys
import time

IDLE_SEC = 30          # same rule as the plugin's work timer: gaps longer than this don't count


def jpeg_size(path):
    """(width, height) from a JPEG's SOF header."""
    with open(path, "rb") as f:
        data = f.read(262144)
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        seg_len = struct.unpack(">H", data[i + 2:i + 4])[0]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        i += 2 + seg_len
    raise ValueError("no JPEG size found in " + path)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    root = sys.argv[1]
    apply = "--apply" in sys.argv
    frames_dir = os.path.join(root, "frames")
    meta_path = os.path.join(root, "recording.json")
    meta = json.load(open(meta_path, encoding="utf-8"))

    names = os.listdir(frames_dir)
    imported = sorted((n for n in names if re.fullmatch(r"\d+\.jpe?g", n, re.I)), key=lambda n: int(re.match(r"\d+", n).group()))
    own = sorted(meta.get("frames", []), key=lambda f: f["n"])
    own_files = {f["n"]: "f_%06d.jpg" % f["n"] for f in own}
    missing = [fn for fn in own_files.values() if fn not in names]
    if missing:
        sys.exit("recording.json lists frames that aren't on disk: %s" % missing[:5])
    if not imported:
        sys.exit("no numbered frames (like 000001.jpg) to import in " + frames_dir)

    # imported frames: size, capture time, estimated work time
    entries, work, prev_t = [], 0, None
    sizes = {}
    for k, name in enumerate(imported, start=1):
        p = os.path.join(frames_dir, name)
        st = os.stat(p)
        t = int(st.st_mtime * 1000)
        if prev_t is not None:
            work += max(0, min(t - prev_t, IDLE_SEC * 1000))
        prev_t = t
        w, h = jpeg_size(p)
        sizes[(w, h)] = sizes.get((w, h), 0) + 1
        entries.append({"n": k, "t": t, "w": work, "x": w, "y": h, "b": st.st_size, "s": "import", "h": 0, "u": 0, "_from": name})
    imported_work = work

    # the plugin's own frames follow, renumbered, with the imported work time added
    offset = len(imported)
    moved = []
    for f in own:
        g = dict(f)
        g["_from"] = own_files[f["n"]]
        g["n"] = offset + len(moved) + 1
        g["w"] = f.get("w", 0) + imported_work
        moved.append(g)
    all_frames = entries + moved

    print("Recording:        %s" % meta.get("name"))
    print("Imported frames:  %d (%s .. %s)" % (len(imported), imported[0], imported[-1]))
    print("  sizes:          %s" % ", ".join("%dx%d: %d" % (w, h, c) for (w, h), c in sorted(sizes.items(), key=lambda kv: -kv[1])))
    print("  captured:       %s .. %s" % (time.strftime("%Y-%m-%d %H:%M", time.localtime(entries[0]["t"] / 1000)),
                                           time.strftime("%Y-%m-%d %H:%M", time.localtime(entries[-1]["t"] / 1000))))
    print("  est. work time: %d h %02d min (gaps over %d s not counted)" % (imported_work // 3600000, imported_work // 60000 % 60, IDLE_SEC))
    print("Plugin's frames:  %d, now numbered %s" % (len(moved), ", ".join(str(g["n"]) for g in moved) or "-"))
    print("Total frames:     %d" % len(all_frames))
    print("Work time:        %d min -> %d min" % (meta.get("workMs", 0) // 60000, (meta.get("workMs", 0) + imported_work) // 60000))
    if not apply:
        print("\nDry run only. Close Photoshop, then run again with --apply.")
        return

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(root, "recording.backup-%s.json" % stamp)
    with open(backup, "w", encoding="utf-8") as fh:
        json.dump(meta, fh)
    log_path = os.path.join(root, "import-renames-%s.txt" % stamp)
    log = open(log_path, "w", encoding="utf-8")

    # two passes via temporary names, so nothing is overwritten mid-way (f_000017 vs imported #17)
    temp = []
    for g in all_frames:
        src = os.path.join(frames_dir, g["_from"])
        tmp = os.path.join(frames_dir, "_import_tmp_%06d.jpg" % g["n"])
        os.rename(src, tmp)
        temp.append((tmp, g))
    for tmp, g in temp:
        final = "f_%06d.jpg" % g["n"]
        os.rename(tmp, os.path.join(frames_dir, final))
        log.write("%s -> %s\n" % (g["_from"], final))
        del g["_from"]
    log.close()

    meta["frames"] = all_frames
    meta["workMs"] = meta.get("workMs", 0) + imported_work
    meta["bytes"] = sum(g["b"] for g in all_frames)
    meta["nextIndex"] = len(all_frames) + 1
    meta["updated"] = int(time.time() * 1000)
    tmp_meta = meta_path + ".tmp"
    with open(tmp_meta, "w", encoding="utf-8") as fh:
        json.dump(meta, fh)
    os.replace(tmp_meta, meta_path)
    print("\nDone. Backup: %s\nRename log: %s" % (os.path.basename(backup), os.path.basename(log_path)))


if __name__ == "__main__":
    main()
