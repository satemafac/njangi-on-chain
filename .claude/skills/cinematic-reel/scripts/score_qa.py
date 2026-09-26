#!/usr/bin/env python3
"""
score_qa.py — objective checks on a generated score (you cannot listen to it).

  marketing/tools/.venv/bin/python score_qa.py <score.wav> <timeline.json> [--shift 0.8]

Reports:
  * vocals    Whisper over the score; any speech segment means the take has a
              voice or lyrics -> reject it.
  * peak / RMS per 2 s, so you can see the dynamics follow the scenes.
  * brightness (spectral centroid) per scene: it should move with the story
    (dark on heritage/tension beats, brighter on the lift / brand beat).
  * lag: where the timbre actually changes vs each cut. Lyria RealTime
    answers a cue ~1 s late; the mix pulls the score earlier by --shift.
"""
from __future__ import annotations

import argparse
import json
import wave

import numpy as np


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("score")
    ap.add_argument("timeline")
    ap.add_argument("--shift", type=float, default=0.8)
    a = ap.parse_args()
    tl = json.load(open(a.timeline))
    w = wave.open(a.score)
    sr = w.getframerate()
    x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").reshape(-1, w.getnchannels()).astype(np.float32) / 32768
    m = x.mean(axis=1)
    print(f"length {len(m) / sr:.1f}s  peak {20 * np.log10(np.abs(x).max() + 1e-9):.1f} dBFS")
    rms = [20 * np.log10(np.sqrt(np.mean(m[i * sr:(i + 2) * sr] ** 2)) + 1e-9) for i in range(0, int(len(m) / sr) - 1, 2)]
    print("RMS dB /2s: " + " ".join(f"{i * 2}:{v:.0f}" for i, v in enumerate(rms)))

    def centroid(seg):
        f = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
        fr = np.fft.rfftfreq(len(seg), 1 / sr)
        return (f * fr).sum() / (f.sum() + 1e-9)

    print("brightness per scene (spectral centroid):")
    for s in tl["scenes"]:
        seg = m[int((s["t0"] + a.shift) * sr):int((s["t1"] + a.shift) * sr)]
        if len(seg) > sr:
            print(f"  {s['visual']:9s} {centroid(seg):6.0f} Hz")

    hop, win = int(0.25 * sr), int(1.0 * sr)
    cs = np.array([centroid(m[i:i + win]) for i in range(0, len(m) - win, hop)])
    tt = np.arange(len(cs)) * 0.25 + 0.5
    d = np.abs(np.gradient(np.convolve(np.log(cs + 1e-9), np.ones(8) / 8, mode="same")))
    lags = []
    for s in tl["scenes"][1:]:
        sel = (tt > s["t0"] - 1) & (tt < s["t0"] + 6)
        j = int(np.argmax(d * sel))
        lags.append(tt[j] - s["t0"])
        print(f"  cut {s['visual']:9s} {s['t0']:6.2f}s  change ~{tt[j]:6.2f}s  lag {tt[j] - s['t0']:+.2f}s")
    print(f"median lag {np.median(lags):+.2f}s (mix shift in use: {a.shift}s)")

    import whisper  # noqa: E402
    res = whisper.load_model("base").transcribe(a.score, language="en", fp16=False, no_speech_threshold=0.5,
                                                condition_on_previous_text=False)
    speech = [s["text"].strip() for s in res["segments"] if s.get("no_speech_prob", 1) < 0.5]
    print("vocals: " + ("NONE (ok)" if not speech else f"FOUND {speech[:5]} -> reject this take"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
