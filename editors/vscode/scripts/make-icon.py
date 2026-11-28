#!/usr/bin/env python3
# [xihanzu-NR]
"""Draw the extension icon.

A one-off, kept in the repo because "the icon is a PNG nobody can edit" is how
an extension ends up with a logo that does not look like its language. Pure
stdlib: no Pillow, no download.
"""

import math
import struct
import zlib

SIZE = 128
BG = (26, 16, 43)
GOLD = (233, 190, 106)
PINK = (240, 168, 208)


def clamp(value):
    return max(0, min(255, int(round(value))))


def blend(base, top, alpha):
    return (
        clamp(base[0] + (top[0] - base[0]) * alpha),
        clamp(base[1] + (top[1] - base[1]) * alpha),
        clamp(base[2] + (top[2] - base[2]) * alpha),
    )


def rounded_alpha(x, y, radius=22):
    """1 inside the rounded square, 0 outside, with a one-pixel soft edge."""
    cx = min(max(x, radius), SIZE - 1 - radius)
    cy = min(max(y, radius), SIZE - 1 - radius)
    distance = math.hypot(x - cx, y - cy)
    if distance <= radius - 1:
        return 1.0
    if distance >= radius + 1:
        return 0.0
    return radius + 1 - distance


def main():
    pixels = [[(0, 0, 0, 0) for _ in range(SIZE)] for _ in range(SIZE)]

    for y in range(SIZE):
        for x in range(SIZE):
            alpha = rounded_alpha(x, y)
            if alpha <= 0:
                continue
            # A vertical gradient, so the tile has some depth.
            shade = 1.0 - 0.35 * (y / SIZE)
            colour = blend((0, 0, 0), BG, shade)
            pixels[y][x] = (colour[0], colour[1], colour[2], clamp(255 * alpha))

    # Two serpents: a sine wave in pink over a counter-phase wave in gold, which
    # is the "two heads" idea without pretending to be a literal hydra.
    for x in range(18, SIZE - 18):
        t = (x - 18) / (SIZE - 36)
        for phase, colour in ((0.0, PINK), (math.pi, GOLD)):
            centre = SIZE / 2 + 26 * math.sin(t * math.pi * 2 + phase)
            for offset in (-2, -1, 0, 1, 2):
                y = int(round(centre)) + offset
                if not 0 <= y < SIZE:
                    continue
                weight = 1.0 - abs(offset) / 3.0
                r, g, b, a = pixels[y][x]
                if a == 0:
                    continue
                r, g, b = blend((r, g, b), colour, 0.85 * weight)
                pixels[y][x] = (r, g, b, a)

    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for r, g, b, a in row:
            raw.extend((clamp(r), clamp(g), clamp(b), clamp(a)))

    def chunk(kind, data):
        return (
            struct.pack('>I', len(data))
            + kind
            + data
            + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')

    target = __file__.replace('scripts/make-icon.py', 'icon.png')
    with open(target, 'wb') as handle:
        handle.write(png)
    print(target, len(png), 'bytes')


if __name__ == '__main__':
    main()
