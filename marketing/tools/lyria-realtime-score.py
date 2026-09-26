#!/usr/bin/env python3
"""
lyria-realtime-score.py — score a Reel to picture with Lyria RealTime.

Lyria RealTime streams instrumental music and can be steered live. This
script reads the episode timeline, streams for the film's length, and swaps
the weighted prompts at each scene boundary (a little early, the model eases
between prompts over a few seconds), so the music follows the cut.

Run with a Python that has google-genai (Google's official SDK):
  $VENV/bin/python marketing/tools/lyria-realtime-score.py \
      --timeline marketing/assets/export/circles-ep01-tontine/timeline-gemini.json \
      --out marketing/assets/export/circles-ep01-tontine/score-rt1.wav [--seed 7]

Key: same lookup as gemini-tts.py (env, launchd, .env.local), never printed.
The output is 48 kHz stereo PCM. Verify "no vocals" with Whisper before use.
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import sys
import wave
from pathlib import Path

from google import genai
from google.genai import types

HERE = Path(__file__).resolve().parent
SR, CH, BYTES = 48000, 2, 2
LEAD = 1.8   # seconds early to send a cue; the model eases into it

# Circles of the World house style (MOTION-BRIEF: 60-80 BPM, cinematic heritage lane)
STYLE = "Cinematic heritage documentary score, instrumental, no vocals, warm and restrained, premium, spacious mix"
CUES = {
    "year":    ([("Somber low cello drone with sparse distant felt piano notes, D minor, quiet, weighty, historical", 1.0)], dict(density=0.18, brightness=0.3, mute_drums=True)),
    "rewrite": ([("Warm kora arpeggios enter with a gentle hopeful lift, felt piano, soft strings, turning toward major", 1.0)], dict(density=0.3, brightness=0.45, mute_drums=True)),
    "payin":   ([("Calm steady kora ostinato with a soft talking drum and shaker pulse, felt piano chords, clear and light", 1.0)], dict(density=0.42, brightness=0.5, mute_drums=False)),
    "plate":   ([("Tender kora melody with felt piano and warm sustained strings, intimate and human, West African heritage", 1.0)], dict(density=0.3, brightness=0.45, mute_drums=True)),
    "catch":   ([("Tense sustained low strings, slow distant heartbeat drum, sparse, a sense of distance and unease", 1.0)], dict(density=0.2, brightness=0.25, mute_drums=False)),
    "nobody":  ([("Confident warm resolution in D major, open uplifting strings, kora figure returns with a gentle talking drum pulse, assured", 1.0)], dict(density=0.45, brightness=0.55, mute_drums=False)),
    "title":   ([("Gentle ending, one sustained warm major chord on strings and felt piano, fading out", 1.0)], dict(density=0.12, brightness=0.4, mute_drums=True)),
}


def key() -> str:
    spec = importlib.util.spec_from_file_location("gemini_tts", HERE / "gemini-tts.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.api_key()


async def run(timeline: dict, out: Path, seed: int) -> None:
    total = timeline["total"] + 1.5
    cues = []
    for s in timeline["scenes"]:
        if s["visual"] in CUES:
            cues.append((max(0.0, s["t0"] - LEAD), s["visual"]))
    cues.sort()
    client = genai.Client(api_key=key(), http_options={"api_version": "v1alpha"})
    pcm = bytearray()
    async with client.aio.live.music.connect(model="models/lyria-realtime-exp") as session:
        def prompts(name):
            items = CUES[name][0]
            return [types.WeightedPrompt(text=STYLE, weight=0.6)] + [types.WeightedPrompt(text=t, weight=w) for t, w in items]

        def config(name):
            c = CUES[name][1]
            return types.LiveMusicGenerationConfig(bpm=70, scale=types.Scale.D_MAJOR_B_MINOR, temperature=1.0, guidance=4.5,
                                                   seed=seed, density=c["density"], brightness=c["brightness"], mute_drums=c["mute_drums"])
        first = cues[0][1]
        await session.set_weighted_prompts(prompts=prompts(first))
        await session.set_music_generation_config(config=config(first))
        await session.play()
        nxt = 1
        async for msg in session.receive():
            sc = getattr(msg, "server_content", None)
            if sc and sc.audio_chunks:
                for ch in sc.audio_chunks:
                    pcm.extend(ch.data)
            elapsed = len(pcm) / (SR * CH * BYTES)
            if nxt < len(cues) and elapsed >= cues[nxt][0]:
                name = cues[nxt][1]
                await session.set_weighted_prompts(prompts=prompts(name))
                await session.set_music_generation_config(config=config(name))
                print(f"  {elapsed:6.2f}s cue -> {name}", flush=True)
                nxt += 1
            if getattr(msg, "filtered_prompt", None):
                print(f"  prompt filtered: {msg.filtered_prompt}", flush=True)
            if elapsed >= total:
                break
        await session.stop()
    out.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out), "wb") as w:
        w.setnchannels(CH); w.setsampwidth(BYTES); w.setframerate(SR)
        w.writeframes(bytes(pcm))
    print(f"score -> {out}  ({len(pcm) / (SR * CH * BYTES):.2f}s)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeline", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    asyncio.run(run(json.loads(Path(a.timeline).read_text()), Path(a.out), a.seed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
