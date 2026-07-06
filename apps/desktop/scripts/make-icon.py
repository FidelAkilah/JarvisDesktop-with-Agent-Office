#!/usr/bin/env python3
"""Generates the JARVIS app icon (arc reactor on dark glass) as PNG + .icns.
Pure stdlib — run: python3 scripts/make-icon.py"""

import math
import os
import struct
import subprocess
import zlib

S = 1024
CX = CY = S / 2


def clamp(v):
    return max(0, min(255, int(v)))


def write_png(path, pixels):
    def chunk(typ, data):
        c = struct.pack('>I', len(data)) + typ + data
        return c + struct.pack('>I', zlib.crc32(typ + data) & 0xFFFFFFFF)

    raw = b''.join(b'\x00' + bytes(row) for row in pixels)
    png = (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', S, S, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw, 6))
        + chunk(b'IEND', b'')
    )
    open(path, 'wb').write(png)


CYAN = (70, 232, 255)
WHITE = (216, 247, 255)
BG = (7, 16, 25)

rows = []
corner = 180.0  # macOS-style rounded square
for y in range(S):
    row = bytearray()
    for x in range(S):
        # rounded-rect mask
        qx = max(abs(x - CX) - (CX - corner), 0)
        qy = max(abs(y - CY) - (CY - corner), 0)
        dcorner = math.hypot(qx, qy)
        if dcorner > corner:
            row += bytes((0, 0, 0, 0))
            continue

        r = math.hypot(x - CX, y - CY)
        # base: dark glass with a faint radial lift
        base = 1.0 - min(r / 700, 1.0) * 0.35
        cr, cg, cb = (BG[0] * base + 6, BG[1] * base + 10, BG[2] * base + 14)

        glow = 0.0
        # three rings
        for R, w, a in ((330, 16, 1.0), (255, 7, 0.55), (415, 6, 0.5)):
            d = abs(r - R)
            glow += math.exp(-((d / (w * 1.9)) ** 2)) * a
        # tick marks on the outer ring
        ang = math.atan2(y - CY, x - CX)
        tick = (abs(((ang * 36 / math.pi) % 2) - 1) < 0.16) and 440 < r < 480
        if tick:
            glow += 0.6
        # core
        if r < 150:
            core = 1.0 - (r / 150) ** 2
            cr += (WHITE[0] - cr) * core
            cg += (WHITE[1] - cg) * core
            cb += (WHITE[2] - cb) * core
            glow += core * 0.4
        glow = min(glow, 1.0)
        cr += (CYAN[0] - cr) * glow
        cg += (CYAN[1] - cg) * glow
        cb += (CYAN[2] - cb) * glow

        # soft edge highlight on the rounded rect
        if dcorner > corner - 6:
            cr += (CYAN[0] - cr) * 0.25
            cg += (CYAN[1] - cg) * 0.25
            cb += (CYAN[2] - cb) * 0.25

        row += bytes((clamp(cr), clamp(cg), clamp(cb), 255))
    rows.append(row)

here = os.path.dirname(os.path.abspath(__file__))
build = os.path.join(here, '..', 'build')
os.makedirs(build, exist_ok=True)
png = os.path.join(build, 'icon.png')
write_png(png, rows)
print('icon.png written')

iconset = os.path.join(build, 'icon.iconset')
os.makedirs(iconset, exist_ok=True)
for size in (16, 32, 64, 128, 256, 512):
    for scale in (1, 2):
        px = size * scale
        name = f'icon_{size}x{size}' + ('@2x' if scale == 2 else '') + '.png'
        subprocess.run(
            ['sips', '-z', str(px), str(px), png, '--out', os.path.join(iconset, name)],
            capture_output=True, check=True,
        )
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(build, 'icon.icns')], check=True)
print('icon.icns written')
