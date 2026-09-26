#!/usr/bin/env python3
"""
build-circles-film.py — one command for a "Circles of the World" episode film.

  1. voice + timeline  build-circles-episode.py --engine gemini --no-render
                       (Gemini TTS, one clip per scene, Whisper-QA'd; timeline JSON)
  2. score             lyria-realtime-score.py (Lyria RealTime, cued to the cuts)
  3. mix               score aligned to picture, ducked under the voice, -14 LUFS
  4. picture           render-webgl.js + assets/circles/film.html (3D, GPU,
                       motion blur / depth of field by sub-frame accumulation)
  5. deliver           film.mp4, film-vo-only.mp4 (for a licensed IG track),
                       cover.jpg, vo-01..NN.mp3 -> the handoff packet

Run with a Python that has numpy + openai-whisper + google-genai:
  $VENV/bin/python marketing/tools/build-circles-film.py \
      --spec marketing/assets/circles-ep01-tontine.spec.json \
      [--rescore] [--samples 16] [--probe auto]

Steps 1 and 2 are cached (delete the files or pass --rescore to redo them).
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
MKT = ROOT / "marketing"
SCORE_SHIFT = 0.8   # Lyria answers a cue ~1 s late; pull the score earlier by this much


def run(*cmd, capture=False, cwd=None):
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, cwd=cwd)
    if r.returncode != 0:
        sys.exit(f"failed: {' '.join(str(c) for c in cmd)}\n{r.stdout[-1500:]}\n{r.stderr[-2500:]}")
    return r.stdout + (r.stderr if capture else "")


def loudnorm(src: Path, dst: Path, I: float, TP: float = -1.5, LRA: float = 11, pre: str = "") -> None:
    chain = (pre + ",") if pre else ""
    out = run("ffmpeg", "-hide_banner", "-y", "-i", src, "-af", f"{chain}loudnorm=I={I}:TP={TP}:LRA={LRA}:print_format=json",
              "-f", "null", "-", capture=True)
    js = json.loads(out[out.rindex("{"):out.rindex("}") + 1])
    f = (f"{chain}loudnorm=I={I}:TP={TP}:LRA={LRA}:measured_I={js['input_i']}:measured_TP={js['input_tp']}:"
         f"measured_LRA={js['input_lra']}:measured_thresh={js['input_thresh']}:offset={js['target_offset']}:linear=true")
    run("ffmpeg", "-v", "error", "-y", "-i", src, "-af", f, "-ar", "48000", dst)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--rescore", action="store_true")
    ap.add_argument("--samples", type=int, default=16)
    ap.add_argument("--probe", default="")
    ap.add_argument("--packet", default=None, help="default: spec['packet']")
    ap.add_argument("--page", default=None, help="film page under marketing/, default: spec['film_page'] or assets/circles/film.html")
    a = ap.parse_args()
    spec = json.loads(Path(a.spec).read_text())
    name = spec["name"]
    out = MKT / "assets" / "export" / name
    py = sys.executable

    print("[1/5] voice + timeline")
    run(py, HERE / "build-circles-episode.py", "--spec", a.spec, "--engine", "gemini", "--no-render")
    tl_path = out / "timeline-gemini.json"
    tl = json.loads(tl_path.read_text())
    total = tl["total"]

    print("[2/5] score (Lyria RealTime)")
    score = out / "score-rt.wav"
    if a.rescore or not score.exists():
        run(py, HERE / "lyria-realtime-score.py", "--timeline", tl_path, "--out", score)

    print("[3/5] mix")
    snorm = out / "score-norm.wav"
    loudnorm(score, snorm, I=-23, TP=-3, LRA=10,
             pre=f"atrim=start={SCORE_SHIFT},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1.6,afade=t=out:st={total - 3.2}:d=3.2,atrim=end={total}")
    raw = out / "mix-film.raw.wav"
    run("ffmpeg", "-v", "error", "-y", "-i", out / "vo-track-gemini.wav", "-i", snorm, "-filter_complex",
        "[0:a]pan=stereo|c0=c0|c1=c0,asplit=2[v][k];[1:a]aformat=channel_layouts=stereo[s];"
        "[s][k]sidechaincompress=threshold=0.04:ratio=3.5:attack=40:release=650:makeup=1[d];"
        "[v][d]amix=inputs=2:normalize=0:duration=first[m]", "-map", "[m]", "-t", f"{total}", "-ar", "48000", raw)
    master = out / "master-film.wav"
    loudnorm(raw, master, I=-14, TP=-1.5, LRA=11)
    raw.unlink(missing_ok=True)

    page = f"{a.page or spec.get('film_page', 'assets/circles/film.html')}?tl=/{tl_path.relative_to(MKT)}"
    if a.probe:
        pts = a.probe
        if pts == "auto":
            pts = ",".join(f"{x:.2f}" for s in tl["scenes"] for x in (s["t0"] + 1.0, (s["v0"] + s["v1"]) / 2, s["v1"])) + ",-1"
        run("node", HERE / "render-webgl.js", "--page", page, "--probe", pts, "--probe-dir", out / "probe-film", "--samples", a.samples)
        print(f"probes -> {(out / 'probe-film').relative_to(ROOT)}")
        return 0

    print(f"[4/5] picture ({round(total * 30)} frames, {a.samples} samples each)")
    film = out / f"{name}.mp4"
    run("node", HERE / "render-webgl.js", "--page", page, "--seconds", f"{total}", "--fps", "30",
        "--samples", a.samples, "--audio", master, "--out", film)
    film_vo = out / f"{name}-vo-only.mp4"
    loudnorm(out / "vo-track-gemini.wav", out / "vo-only-film.wav", I=-14, TP=-1.5, LRA=11, pre="pan=stereo|c0=c0|c1=c0")
    run("ffmpeg", "-v", "error", "-y", "-i", film, "-i", out / "vo-only-film.wav", "-map", "0:v", "-map", "1:a", "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", film_vo)
    cdir = out / "cover-film"
    run("node", HERE / "render-webgl.js", "--page", page, "--probe", "-1", "--probe-dir", cdir, "--samples", "32")
    cover = out / f"{name}-cover.jpg"
    run("ffmpeg", "-v", "error", "-y", "-i", cdir / "probe--1.00s.png", "-q:v", "2", cover)
    shutil.rmtree(cdir)

    print("[5/5] deliver")
    packet = a.packet or spec.get("packet")
    if not packet:
        print("  no packet configured (spec['packet'] or --packet); deliverables stay in the export folder")
        return 0
    pk = ROOT / packet
    pk.mkdir(parents=True, exist_ok=True)
    for i in range(1, len(spec["scenes"]) + 1):
        src = out / "vo-gemini" / f"vo-{i:02d}.wav"
        run("ffmpeg", "-v", "error", "-y", "-i", src, "-ar", "44100", "-b:a", "192k", pk / f"vo-{i:02d}.mp3")
    for f in (film, film_vo, cover):
        shutil.copyfile(f, pk / f.name)
    print(f"  {film.relative_to(ROOT)}\n  {film_vo.relative_to(ROOT)}\n  {cover.relative_to(ROOT)}\n  packet -> {packet}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
