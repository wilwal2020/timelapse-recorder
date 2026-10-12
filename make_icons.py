#!/usr/bin/env python3
"""Draw the plugin's PNG icons into src/icons/ (standard library only).

Panel icon: a record ring with a dot. Plugin icon: a red record button with
clock hands on a dark rounded tile.
"""
import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "src", "icons")
SS = 4  # supersampling per axis


def write_png(path, w, h, rgba):
    raw = b"".join(b"\x00" + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))

    def chunk(kind, data):
        c = zlib.crc32(kind + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", c)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def seg_dist(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    l2 = dx * dx + dy * dy
    t = 0 if l2 == 0 else max(0, min(1, ((px - x1) * dx + (py - y1) * dy) / l2))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def render(size, shapes):
    """shapes: list of (inside(x, y) -> bool, (r, g, b, a)) painted in order; coords in 0..1."""
    rgba = [0] * (size * size * 4)
    for y in range(size):
        for x in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    u = (x + (sx + 0.5) / SS) / size
                    v = (y + (sy + 0.5) / SS) / size
                    col = (0, 0, 0, 0)
                    for inside, c in shapes:
                        if inside(u, v):
                            a = c[3] / 255
                            base_a = col[3] / 255
                            out_a = a + base_a * (1 - a)
                            if out_a > 0:
                                col = tuple(
                                    (c[i] * a + col[i] * base_a * (1 - a)) / out_a for i in range(3)
                                ) + (out_a * 255,)
                    for i in range(3):
                        acc[i] += col[i] * col[3] / 255
                    acc[3] += col[3]
            n = SS * SS
            a = acc[3] / n
            o = (y * size + x) * 4
            if a > 0:
                for i in range(3):
                    rgba[o + i] = int(round(acc[i] / n / (a / 255)))
            rgba[o + 3] = int(round(a))
    return rgba


def circle(cx, cy, r):
    return lambda u, v: (u - cx) ** 2 + (v - cy) ** 2 <= r * r


def ring(cx, cy, r, w):
    return lambda u, v: abs(math.hypot(u - cx, v - cy) - r) <= w / 2


def stroke(x1, y1, x2, y2, w):
    return lambda u, v: seg_dist(u, v, x1, y1, x2, y2) <= w / 2


def rounded_rect(r):
    def inside(u, v):
        cx = min(max(u, r), 1 - r)
        cy = min(max(v, r), 1 - r)
        return (u - cx) ** 2 + (v - cy) ** 2 <= r * r
    return inside


def panel_icon(color):
    return [
        (ring(0.5, 0.5, 0.36, 0.1), color),
        (circle(0.5, 0.5, 0.17), color),
    ]


def plugin_icon():
    white = (255, 255, 255, 255)
    return [
        (rounded_rect(0.2), (43, 43, 43, 255)),
        (circle(0.5, 0.5, 0.32), (229, 72, 77, 255)),
        (stroke(0.5, 0.5, 0.5, 0.29, 0.07), white),
        (stroke(0.5, 0.5, 0.65, 0.59, 0.07), white),
        (circle(0.5, 0.5, 0.045), white),
    ]


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        ("panel_dark.png", 23, panel_icon((215, 215, 215, 255))),
        ("panel_dark@2x.png", 46, panel_icon((215, 215, 215, 255))),
        ("panel_light.png", 23, panel_icon((70, 70, 70, 255))),
        ("panel_light@2x.png", 46, panel_icon((70, 70, 70, 255))),
        ("plugin.png", 48, plugin_icon()),
        ("plugin@2x.png", 96, plugin_icon()),
    ]
    for name, size, shapes in jobs:
        write_png(os.path.join(OUT, name), size, size, render(size, shapes))
        print("wrote", name)


if __name__ == "__main__":
    main()
