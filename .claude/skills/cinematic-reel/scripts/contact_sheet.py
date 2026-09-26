#!/usr/bin/env python3
"""
contact_sheet.py — tile frames into one image for an art-director review.

  # probe PNGs written by render-webgl.js (probe-<t>s.png), in time order
  python3 contact_sheet.py <probe-dir> <out.jpg> [--cols 9] [--width 300]

  # frames pulled from a finished MP4 at given times (transitions, beats)
  python3 contact_sheet.py --video film.mp4 --times 11.9,12.25,34.35 <out.jpg>

The cover probe (probe--1.00s.png) is placed last.
"""
from __future__ import annotations

import argparse
import math
import subprocess
import sys
import tempfile
from pathlib import Path


def sh(*a):
    r = subprocess.run([str(x) for x in a], capture_output=True, text=True)
    if r.returncode:
        sys.exit(r.stderr[-1500:])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", nargs="?")
    ap.add_argument("out")
    ap.add_argument("--video")
    ap.add_argument("--times", default="")
    ap.add_argument("--cols", type=int, default=9)
    ap.add_argument("--width", type=int, default=300)
    a = ap.parse_args()
    tmp = Path(tempfile.mkdtemp())
    if a.video:
        files = []
        for t in [float(x) for x in a.times.split(",") if x]:
            f = tmp / f"t-{t:08.2f}.png"
            sh("ffmpeg", "-v", "error", "-y", "-ss", t, "-i", a.video, "-frames:v", 1, f)
            files.append(f)
    else:
        src = Path(a.src)
        probes = list(src.glob("probe-*.png"))
        key = lambda p: float(p.stem[len("probe-"):-1])
        files = sorted([p for p in probes if key(p) >= 0], key=key) + [p for p in probes if key(p) < 0]
    if not files:
        sys.exit("no frames found")
    lst = tmp / "list.txt"
    lst.write_text("".join(f"file '{Path(f).resolve()}'\n" for f in files))  # concat resolves relative to the list file
    cols = min(a.cols, len(files))
    rows = math.ceil(len(files) / cols)
    sh("ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-vf",
       f"scale={a.width}:-1,tile={cols}x{rows}:padding=4:color=0x333333", "-frames:v", 1, a.out)
    print(f"{len(files)} frames -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
