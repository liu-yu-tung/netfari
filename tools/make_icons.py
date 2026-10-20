# SPDX-License-Identifier: GPL-3.0-or-later
"""Draw the PNG icons with the standard library only (no Pillow)."""
import struct
import sys
import zlib
from pathlib import Path


def png(path, size, pixel):
    rows = b""
    for y in range(size):
        rows += b"\x00" + b"".join(bytes(pixel(x + 0.5, y + 0.5, size)) for x in range(size))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def in_round_rect(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def bars(x, y, s):
    """Two subtitle lines: a long one on top, a shorter one below."""
    h = 0.13 * s
    top = in_round_rect(x, y, 0.18 * s, 0.36 * s, 0.82 * s, 0.36 * s + h, h / 2)
    bottom = in_round_rect(x, y, 0.28 * s, 0.58 * s, 0.72 * s, 0.58 * s + h, h / 2)
    return top or bottom


def app_icon(x, y, s):
    if not in_round_rect(x, y, 0, 0, s, s, 0.22 * s):
        return (0, 0, 0, 0)
    if bars(x, y, s):
        return (255, 255, 255, 255)
    return (229, 9, 20, 255)


def toolbar_icon(x, y, s):
    return (110, 110, 115, 255) if bars(x, y, s) else (0, 0, 0, 0)


out = Path(sys.argv[1])
for n in (48, 96, 128):
    png(out / f"icon-{n}.png", n, app_icon)
for n in (16, 32):
    png(out / f"toolbar-{n}.png", n, toolbar_icon)
