#!/usr/bin/env python3
"""
build-circles-episode.py — render one "Circles of the World" episode Reel.

  VO (Gemini TTS, one clip per scene; each take QA'd by Whisper against the
  script and retaken if it drifts) -> word timings aligned to the SCRIPT's
  words -> scene timeline -> synthesized music bed -> mix (bed ducked under
  the voice, -14 LUFS) -> episode HTML from the series template ->
  frames (capture-animation.js, window.__seek) -> MP4 + cover.

Run with the Whisper venv's python (needs numpy + openai-whisper):

  $VENV/bin/python marketing/tools/build-circles-episode.py \
      --spec marketing/assets/circles-ep01-tontine.spec.json \
      [--engine gemini|say] [--retake 2,7] [--no-render] [--probe 1,4.5,-1]

--engine say  uses macOS `say` as a SCRATCH voice for layout and timing
              reviews. Its outputs are named ...-DRAFT-scratch-voice and are
              never copied into the handoff packet.
--retake N,M  forces new Gemini takes for those scenes (1-based).
--probe t,..  renders only those timestamps (seconds; -1 = cover) plus a
              contact sheet, for layout checks.

Deliverables (gemini engine) go to marketing/assets/export/<name>/ and are
copied into the handoff packet named by --packet (vo-01.mp3.., the MP4 and
the cover), per the packet's VO-SCRIPT.md and MOTION-BRIEF.md.
"""
from __future__ import annotations

import argparse
import difflib
import importlib.util
import json
import math
import re
import shutil
import subprocess
import sys
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SR = 48000
QA_MIN = 0.86          # char-level match between script and what Whisper heard
MAX_TAKES = 3


def sh(*cmd, capture=False) -> str:
    r = subprocess.run([str(c) for c in cmd], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0:
        sys.exit(f"command failed: {' '.join(str(c) for c in cmd)}\n{r.stderr[-2000:]}")
    return r.stdout + (r.stderr if capture else "")


def dur(p: Path) -> float:
    return float(sh("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p).strip())


def load_tts():
    spec = importlib.util.spec_from_file_location("gemini_tts", HERE / "gemini-tts.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------- voice
def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def vo_text(sc: dict) -> str:
    """The spoken text: ' | ' caption-break markers removed."""
    return " ".join(sc["vo"].replace("|", " ").split())


def vo_breaks(sc: dict) -> list[int] | None:
    """Word counts per caption phrase when the spec marks breaks with ' | '."""
    if "|" not in sc["vo"]:
        return None
    return [len(p.split()) for p in sc["vo"].split("|") if p.split()]


def norm_text(s: str) -> str:
    return " ".join(x for x in (norm(w) for w in s.split()) if x)


def process_clip(raw: Path, out: Path) -> None:
    """Trim leading/trailing silence, 48 kHz mono, tiny fade-in."""
    trim = ("silenceremove=start_periods=1:start_duration=0:start_threshold=-46dB,areverse,"
            "silenceremove=start_periods=1:start_duration=0:start_threshold=-46dB,areverse,"
            "afade=t=in:d=0.015")
    sh("ffmpeg", "-v", "error", "-y", "-i", raw, "-af", trim, "-ar", SR, "-ac", 1, "-c:a", "pcm_s16le", out)


def align(text: str, wwords: list[dict], clip_dur: float) -> tuple[list[dict], float]:
    """Script words with times taken from Whisper's words (difflib alignment)."""
    toks = text.split()
    nt = [norm(x) for x in toks]
    ww = [(w["word"].strip(), float(w["start"]), float(w["end"])) for w in wwords if norm(w["word"])]
    nw = [norm(w[0]) for w in ww]
    times: list[tuple[float, float] | None] = [None] * len(toks)
    sm = difflib.SequenceMatcher(None, nt, nw, autojunk=False)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            for k in range(i2 - i1):
                times[i1 + k] = (ww[j1 + k][1], ww[j1 + k][2])
        elif op == "replace":
            a, b = ww[j1][1], ww[j2 - 1][2]
            lens = [max(1, len(nt[i])) for i in range(i1, i2)]
            tot, acc = sum(lens), a
            for k, i in enumerate(range(i1, i2)):
                d = (b - a) * lens[k] / tot
                times[i] = (acc, acc + d)
                acc += d
    # words Whisper missed: spread them over the gap between their neighbours
    i = 0
    while i < len(toks):
        if times[i] is not None:
            i += 1
            continue
        j = i
        while j < len(toks) and times[j] is None:
            j += 1
        a = times[i - 1][1] if i > 0 else 0.0
        b = times[j][0] if j < len(toks) else clip_dur
        if b < a:
            b = a
        lens = [max(1, len(nt[k])) for k in range(i, j)]
        tot, acc = sum(lens), a
        for k in range(i, j):
            d = (b - a) * lens[k - i] / tot
            times[k] = (acc, acc + d)
            acc += d
        i = j
    out, last = [], 0.0
    for tok, (a, b) in zip(toks, times):
        a = max(a, last)                                    # keep monotonic
        out.append({"w": tok, "t": round(a, 3), "d": round(max(0.08, b - a), 3)})
        last = a
    score = difflib.SequenceMatcher(None, norm_text(text), norm_text(" ".join(w[0] for w in ww))).ratio()
    return out, score


def make_voice(spec: dict, engine: str, vo_dir: Path, retake: set[int]) -> list[dict]:
    """Return per-scene clip info: path, duration, aligned words, QA score."""
    import whisper  # the venv's openai-whisper
    vo_dir.mkdir(parents=True, exist_ok=True)
    v = spec["voice"]
    model = None
    tts = load_tts() if engine == "gemini" else None
    clips = []
    for n, sc in enumerate(spec["scenes"], start=1):
        clip = vo_dir / f"vo-{n:02d}.wav"
        meta = vo_dir / f"vo-{n:02d}.json"
        cached = clip.exists() and meta.exists() and n not in retake
        if cached:
            m = json.loads(meta.read_text())
            if m.get("text") == vo_text(sc):
                clips.append({**m, "path": clip})
                print(f"  vo-{n:02d} cached  {m['dur']:.2f}s  qa {m['qa']:.3f}")
                continue
        if model is None:
            print("  loading whisper (medium)...")
            model = whisper.load_model("medium")
        best = None
        for take in range(1, (MAX_TAKES if engine == "gemini" else 1) + 1):
            raw = vo_dir / f"vo-{n:02d}.take{take}.raw.wav"
            if engine == "gemini":
                tts.synthesize(vo_text(sc), raw, direction=v["direction"], delivery=sc.get("delivery", ""),
                               pronunciation=v.get("pronunciation", ""), model=v["model"], voice=v["voice"],
                               temperature=float(v.get("temperature", 1.0)))
            else:
                aiff = raw.with_suffix(".aiff")
                sh("say", "-v", "Daniel", "-r", "150", "-o", aiff, vo_text(sc))
                sh("ffmpeg", "-v", "error", "-y", "-i", aiff, raw)
                aiff.unlink()
            proc = vo_dir / f"vo-{n:02d}.take{take}.wav"
            process_clip(raw, proc)
            d = dur(proc)
            res = model.transcribe(str(proc), language="en", word_timestamps=True, fp16=False,
                                   condition_on_previous_text=False, initial_prompt=v.get("whisper_hint", ""))
            ww = [w for s in res["segments"] for w in s.get("words", [])]
            words, score = align(vo_text(sc), ww, d)
            heard = " ".join(w["word"].strip() for w in ww)
            wps = len(vo_text(sc).split()) / max(0.1, d)
            print(f"  vo-{n:02d} take {take}: {d:.2f}s  {wps:.2f} w/s  qa {score:.3f}  heard: {heard[:90]}")
            cand = {"text": vo_text(sc), "dur": round(d, 3), "qa": round(score, 4), "wps": round(wps, 2),
                    "heard": heard, "take": take, "words": words, "engine": engine}
            if best is None or score > best[0]["qa"]:
                best = (cand, proc)
            if score >= QA_MIN and 1.6 <= wps <= 3.6:
                break
        cand, proc = best
        shutil.copyfile(proc, clip)
        meta.write_text(json.dumps(cand, indent=2))
        if cand["qa"] < QA_MIN:
            print(f"  !! vo-{n:02d} best take is below QA ({cand['qa']:.3f}); listen before publishing")
        clips.append({**cand, "path": clip})
    return clips


# ---------------------------------------------------------------- captions
STOP = {"the", "a", "an", "of", "to", "in", "on", "and", "that", "has", "her", "its", "at", "by"}


def chunk_words(words: list[dict], maxw: int = 6) -> list[tuple[int, int]]:
    """Split into phrases of <= maxw words, preferring breaks after commas and
    never ending a phrase on a small word."""
    sents, cur = [], []
    for i, w in enumerate(words):
        cur.append(i)
        if w["w"][-1] in ".:;?!":
            sents.append(cur)
            cur = []
    if cur:
        sents.append(cur)
    out = []
    for s in sents:
        while len(s) > maxw:
            k = math.ceil(len(s) / maxw)
            ideal = len(s) / k
            best, best_cost = None, 1e9
            for size in range(2, min(maxw, len(s) - 1) + 1):
                w = words[s[size - 1]]["w"]
                cost = abs(size - ideal)
                if w.endswith(","):
                    cost -= 2.5
                if norm(w) in STOP:
                    cost += 3
                if len(s) - size < 2:
                    cost += 4
                if cost < best_cost:
                    best, best_cost = size, cost
            out.append((s[0], s[best - 1]))
            s = s[best:]
        out.append((s[0], s[-1]))
    return out


# ---------------------------------------------------------------- timeline
def build_timeline(spec: dict, clips: list[dict]) -> dict:
    scenes, t = [], 0.0
    for sc, c in zip(spec["scenes"], clips):
        t0 = t
        v0 = t0 + float(sc.get("lead", 0.4))
        v1 = v0 + c["dur"]
        t1 = v1 + float(sc.get("tail", 0.6))
        kw = {norm(k) for k in sc.get("keywords", [])}
        words = [{"w": w["w"], "t": round(v0 + w["t"], 3), "d": w["d"], "k": norm(w["w"]) in kw} for w in c["words"]]
        chunks = []
        if sc.get("captions", True):
            counts = vo_breaks(sc)
            if counts and sum(counts) == len(words):
                spans, k = [], 0
                for c in counts:
                    spans.append((k, k + c - 1))
                    k += c
            else:
                spans = chunk_words(words)
            for j, (i0, i1) in enumerate(spans):
                a = words[i0]["t"] - 0.1
                b = (words[spans[j + 1][0]]["t"] - 0.1) if j + 1 < len(spans) else min(v1 + 0.45, t1 - 0.05)
                chunks.append({"i0": i0, "i1": i1, "a": round(a, 3), "b": round(b, 3)})
        scenes.append({
            "id": sc["id"], "visual": sc["visual"], "cut": bool(sc.get("cut")), "big": bool(sc.get("big")),
            "headline": sc.get("headline", ""), "headline_at": sc.get("headline_at"),
            "captions": sc.get("captions", True),
            "t0": round(t0, 3), "t1": round(t1, 3), "v0": round(v0, 3), "v1": round(v1, 3),
            "words": words, "chunks": chunks,
        })
        t = t1
    return {"total": round(t, 3), "fps": spec.get("fps", 30), "params": spec["params"], "scenes": scenes}


# ---------------------------------------------------------------- music bed
def synth_bed(tl: dict, path: Path) -> None:
    """A quiet heritage-lane drone in D with a 70 BPM heartbeat on the
    mechanic and resolution beats. Synthesized here so nothing needs a
    licence; swap for a licensed track at publish if preferred."""
    import numpy as np
    total = tl["total"]
    n = int((total + 0.5) * SR)
    t = np.arange(n) / SR
    S = {s["visual"]: s for s in tl["scenes"]}
    g = lambda v, k, d=0.0: S[v][k] + d if v in S else total

    def env(points):
        xs, ys = zip(*sorted(points))
        return np.interp(t, xs, ys)

    def voice(f, e, detune=0.0016, harm=0.16):
        out = np.zeros(n)
        for k, dd in enumerate((-detune, 0.0, detune)):
            ph = 2 * np.pi * f * (1 + dd) * t + 0.5 * np.sin(2 * np.pi * (0.07 + 0.03 * k) * t + f)
            out += np.sin(ph) + harm * np.sin(2 * ph) + 0.05 * np.sin(3 * ph)
        return out / 3 * e

    end = total
    fade_end = [(end - 2.6, 1.0), (end, 0.0)]
    pad = np.zeros(n)
    # root + fifth: the whole film
    pad += voice(73.42, env([(0, 0), (2.5, .55)] + [(x, .55 * y) for x, y in fade_end]))
    pad += voice(110.0, env([(0, 0), (3.0, .38)] + [(x, .38 * y) for x, y in fade_end]))
    # the turn (rewrite) opens the chord: D3 + E3 (sus2, neither sad nor sweet)
    a, b = g("rewrite", "t0"), g("catch", "t0")
    pad += voice(146.83, env([(0, 0), (a, 0), (a + 2.5, .24), (b, .24), (b + 1.5, .16), (g("nobody", "t0"), .16), (g("nobody", "t0") + 2, .24)] + [(x, .24 * y) for x, y in fade_end]))
    pad += voice(164.81, env([(0, 0), (a, 0), (a + 2.5, .2), (b - 0.5, .2), (b + 1.0, 0), (end, 0)]))
    # Douala: warmth (B2, the sixth)
    m0, m1 = g("plate", "t0"), g("plate", "t1")
    pad += voice(123.47, env([(0, 0), (m0 - 0.5, 0), (m0 + 1.5, .2), (m1 - 0.5, .2), (m1 + 1.0, 0), (end, 0)]))
    # the catch: a quiet minor second rubs against D3
    c0, c1 = g("catch", "t0"), g("nobody", "t0")
    pad += voice(155.56, env([(0, 0), (c0, 0), (c0 + 2.0, .11), (c1 - 0.3, .11), (c1 + 0.6, 0), (end, 0)]), detune=0.003)
    # nobody holds the pot: the major third + upper octave arrive
    n0 = g("nobody", "v0", 1.5)
    for f, amp in ((185.0, .2), (220.0, .16), (293.66, .09)):
        pad += voice(f, env([(0, 0), (n0, 0), (n0 + 2.2, amp)] + [(x, amp * y) for x, y in fade_end]))

    # 70 BPM heartbeat: the mechanic (payin..round) and the resolution
    beat = np.zeros(n)
    period = 60 / 70
    windows = [(g("payin", "t0"), g("round", "t1") - 0.4), (g("nobody", "v0", 2.0), g("title", "t0", 2.5))]
    for w0, w1 in windows:
        k = 0
        while w0 + k * period < w1:
            s = int((w0 + k * period) * SR)
            L = int(0.6 * SR)
            tt = np.arange(min(L, n - s)) / SR
            f = 52 + 43 * np.exp(-tt / 0.045)
            thump = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / 0.2)
            beat[s:s + len(tt)] += 0.5 * thump * (0.75 if k % 2 else 1.0)
            k += 1
    mix = pad * 0.9 + beat * 0.55
    mix = np.tanh(mix * 1.1)                     # soft saturation, no clipping
    mix = mix / (np.max(np.abs(mix)) + 1e-9) * 0.6
    pcm = (mix * 32767).astype("<i2").tobytes()
    raw = path.with_suffix(".raw.wav")
    with wave.open(str(raw), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)
    # air + space, then a stereo image
    sh("ffmpeg", "-v", "error", "-y", "-i", raw, "-af",
       "highpass=f=32,lowpass=f=2400,aecho=0.85:0.6:230|410:0.22|0.12,"
       "pan=stereo|c0=c0|c1=c0,aresample=48000", path)
    raw.unlink()


# ---------------------------------------------------------------- mix
def loudnorm(src: Path, dst: Path, I: float, TP: float = -1.5, LRA: float = 11, pre: str = "") -> None:
    """Two-pass (linear) loudnorm."""
    chain = (pre + "," if pre else "")
    out = sh("ffmpeg", "-v", "info", "-hide_banner", "-y", "-i", src, "-af",
             f"{chain}loudnorm=I={I}:TP={TP}:LRA={LRA}:print_format=json", "-f", "null", "-", capture=True)
    js = json.loads(out[out.rindex("{"):out.rindex("}") + 1])
    f = (f"{chain}loudnorm=I={I}:TP={TP}:LRA={LRA}:measured_I={js['input_i']}:measured_TP={js['input_tp']}:"
         f"measured_LRA={js['input_lra']}:measured_thresh={js['input_thresh']}:offset={js['target_offset']}:linear=true")
    sh("ffmpeg", "-v", "error", "-y", "-i", src, "-af", f, "-ar", SR, dst)


def build_audio(tl: dict, clips: list[dict], out: Path, tag: str) -> tuple[Path, Path]:
    parts, cursor = [], 0.0
    lst = out / f"vo-concat-{tag}.txt"
    for s, c in zip(tl["scenes"], clips):
        gap = s["v0"] - cursor
        sil = out / f"sil-{s['id']}-{tag}.wav"
        sh("ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=mono", "-t", f"{max(0.0, gap):.4f}",
           "-c:a", "pcm_s16le", sil)
        parts += [sil, c["path"]]
        cursor = s["v0"] + dur(c["path"])
    tail = out / f"sil-tail-{tag}.wav"
    sh("ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=mono", "-t",
       f"{max(0.05, tl['total'] - cursor):.4f}", "-c:a", "pcm_s16le", tail)
    parts.append(tail)
    lst.write_text("".join(f"file '{p.resolve()}'\n" for p in parts))
    vo_raw = out / f"vo-track-{tag}.raw.wav"
    sh("ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c:a", "pcm_s16le", vo_raw)
    vo = out / f"vo-track-{tag}.wav"
    loudnorm(vo_raw, vo, I=-16, TP=-2, LRA=9, pre="highpass=f=70,acompressor=threshold=-20dB:ratio=2.5:attack=8:release=120:makeup=1.5")
    bed = out / "bed.wav"
    synth_bed(tl, bed)
    bed_n = out / "bed-norm.wav"
    loudnorm(bed, bed_n, I=-33, TP=-6, LRA=8)
    mix_raw = out / f"mix-{tag}.raw.wav"
    sh("ffmpeg", "-v", "error", "-y", "-i", vo, "-i", bed_n, "-filter_complex",
       "[0:a]pan=stereo|c0=c0|c1=c0,asplit=2[v][k];"
       "[1:a][k]sidechaincompress=threshold=0.035:ratio=4:attack=25:release=500:makeup=1[b];"
       "[v][b]amix=inputs=2:normalize=0:duration=first[m]",
       "-map", "[m]", "-t", f"{tl['total']:.3f}", "-ar", SR, mix_raw)
    master = out / f"master-{tag}.wav"
    loudnorm(mix_raw, master, I=-14, TP=-1.5, LRA=11)
    vo_only = out / f"vo-only-{tag}.wav"
    loudnorm(vo, vo_only, I=-14, TP=-1.5, LRA=11, pre="pan=stereo|c0=c0|c1=c0")
    for p in (vo_raw, mix_raw, lst, *[q for q in parts if q.name.startswith("sil-")]):
        Path(p).unlink(missing_ok=True)
    return master, vo_only


# ---------------------------------------------------------------- page + render
def capture(html: Path, outdir: Path, *, width: int, height: int, seconds: float | None = None,
            fps: int = 30, probe: str | None = None) -> None:
    cmd = ["node", HERE / "capture-animation.js", "--in", html, "--out", outdir, "--width", width, "--height", height]
    cmd += ["--probe", probe] if probe else ["--seconds", f"{seconds:.3f}", "--fps", fps]
    sh(*cmd)


def write_page(spec: dict, tl: dict, out: Path, master: Path, plate: Path) -> Path:
    tpl = (ROOT / "marketing" / "assets" / "circles-of-the-world.template.html").read_text()
    assets = ROOT / "marketing" / "assets"
    page = (tpl.replace("/*__TIMELINE__*/null", json.dumps(tl, separators=(",", ":")))
            .replace("__AUDIO__", str(master.relative_to(assets)))
            .replace("__PLATE__", str(plate.relative_to(assets))))
    dst = assets / f"{spec['name']}.html"
    dst.write_text(page)
    return dst


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--engine", choices=["gemini", "say"], default="gemini")
    ap.add_argument("--retake", default="")
    ap.add_argument("--no-render", action="store_true")
    ap.add_argument("--probe", default="")
    ap.add_argument("--packet", default="marketing/handoff/inbox/004-traditions-ep1-tontine")
    a = ap.parse_args()

    spec = json.loads(Path(a.spec).read_text())
    name, fps = spec["name"], int(spec.get("fps", 30))
    out = ROOT / "marketing" / "assets" / "export" / name
    out.mkdir(parents=True, exist_ok=True)
    retake = {int(x) for x in a.retake.split(",") if x.strip()}

    print(f"[1/5] voice ({a.engine})")
    clips = make_voice(spec, a.engine, out / f"vo-{a.engine}", retake)

    print("[2/5] timeline")
    tl = build_timeline(spec, clips)
    (out / f"timeline-{a.engine}.json").write_text(json.dumps(tl, indent=1))
    for s in tl["scenes"]:
        print(f"  {s['id']:<8} {s['t0']:6.2f} -> {s['t1']:6.2f}   vo {s['v0']:6.2f}-{s['v1']:6.2f}   "
              + " | ".join(" ".join(w['w'] for w in s['words'][c['i0']:c['i1'] + 1]) for c in s['chunks']))
    print(f"  total {tl['total']:.2f}s")

    print("[3/5] audio")
    master, vo_only = build_audio(tl, clips, out, a.engine)

    plate = out / "plate-douala.png"
    if not plate.exists():
        tmp = out / "plate-tmp"
        capture(ROOT / "marketing" / "assets" / spec["params"]["plate"], tmp, width=1296, height=2304, probe="0")
        shutil.move(str(tmp / "probe-0.00s.png"), plate)
        tmp.rmdir()
    html = write_page(spec, tl, out, master, plate)
    print(f"[4/5] page -> {html.relative_to(ROOT)}")

    if a.probe == "auto":
        pts = []
        for s in tl["scenes"]:
            pts += [s["t0"] + 1.2, (s["v0"] + s["v1"]) / 2, min(s["v1"] + 0.25, s["t1"] - 0.05)]
        a.probe = ",".join(f"{x:.2f}" for x in pts) + ",-1"
    if a.probe:
        pdir = out / "probe"
        if pdir.exists():
            shutil.rmtree(pdir)
        capture(html, pdir, width=1080, height=1920, probe=a.probe)
        sheet = out / f"probe-sheet-{a.engine}.jpg"
        files = sorted(pdir.glob("probe-*.png"), key=lambda p: float(p.stem[6:-1]))
        lst = pdir / "list.txt"
        lst.write_text("".join(f"file '{f}'\n" for f in files))
        cols = min(6, len(files))
        rows = math.ceil(len(files) / cols)
        sh("ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-vf",
           f"scale=360:-1,tile={cols}x{rows}:padding=6:color=0x222222", "-frames:v", 1, sheet)
        print(f"  probe sheet -> {sheet.relative_to(ROOT)}")
        return 0
    if a.no_render:
        return 0

    print(f"[5/5] render {math.ceil(tl['total'] * fps)} frames @ {fps}fps")
    frames = out / "frames"
    if frames.exists():
        shutil.rmtree(frames)
    capture(html, frames, width=1080, height=1920, seconds=tl["total"], fps=fps)
    suffix = "" if a.engine == "gemini" else "-DRAFT-scratch-voice"
    mp4 = out / f"{name}{suffix}.mp4"
    enc = ["-c:v", "libx264", "-profile:v", "high", "-level", "4.2", "-preset", "slow", "-crf", "17",
           "-pix_fmt", "yuv420p", "-r", fps]
    sh("ffmpeg", "-v", "error", "-y", "-framerate", fps, "-i", frames / "f%04d.png", "-i", master, *enc,
       "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", mp4)
    mp4_vo = out / f"{name}{suffix}-vo-only.mp4"
    sh("ffmpeg", "-v", "error", "-y", "-i", mp4, "-i", vo_only, "-map", "0:v", "-map", "1:a", "-c:v", "copy",
       "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", mp4_vo)
    shutil.rmtree(frames)
    cdir = out / "cover-tmp"
    capture(html, cdir, width=1080, height=1920, probe="-1")
    cover = out / f"{name}{suffix}-cover.jpg"
    sh("ffmpeg", "-v", "error", "-y", "-i", cdir / "probe--1.00s.png", "-q:v", 2, cover)
    shutil.rmtree(cdir)
    print(f"  mp4   -> {mp4.relative_to(ROOT)}  ({dur(mp4):.2f}s)")
    print(f"  mp4   -> {mp4_vo.relative_to(ROOT)} (voice only, for a licensed IG track)")
    print(f"  cover -> {cover.relative_to(ROOT)}")

    if a.engine == "gemini" and a.packet:
        pk = ROOT / a.packet
        pk.mkdir(parents=True, exist_ok=True)
        for n, c in enumerate(clips, start=1):
            sh("ffmpeg", "-v", "error", "-y", "-i", c["path"], "-ar", 44100, "-b:a", "192k", pk / f"vo-{n:02d}.mp3")
        for f in (mp4, mp4_vo, cover):
            shutil.copyfile(f, pk / f.name)
        print(f"  packet -> {pk.relative_to(ROOT)} (vo-01..{len(clips):02d}.mp3, mp4s, cover)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
