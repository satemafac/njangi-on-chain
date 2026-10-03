#!/usr/bin/env python3
"""
gemini-tts.py — voiceover lines for Njangi On-Chain Reels via Gemini TTS.

Reads GEMINI_API_KEY from the environment, falling back to the macOS launchd
environment (`launchctl getenv GEMINI_API_KEY`). Never prints, logs, or
echoes the key. Standard library only (REST, no SDK), like gen-image.py.

    python3 marketing/tools/gemini-tts.py \
        --text "In 1653, an Italian banker invented the tontine." \
        --delivery "somber, regal, slow" \
        --out scratch/vo-01.wav

Also importable: synthesize(text, out_path, ...) is what the episode builder
(build-circles-episode.py) calls, one clip per scene.

Notes for this project specifically:
  * One clip per scene. Separate clips keep word-timed captions exact.
  * The voice is synthetic. Instagram's "AI info" label applies to realistic
    synthetic audio, so switch it on at publish.
  * Every call costs money on the account that owns the key.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_MODEL = "gemini-3.8-flash-tts"
DEFAULT_VOICE = "Fola"


ROOT = Path(__file__).resolve().parent.parent.parent


def _from_env_file(path: Path, name: str) -> str:
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if line.startswith("export "):
                line = line[len("export "):]
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def api_key() -> str:
    """Environment, then launchd, then the repo's gitignored .env.local."""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key and sys.platform == "darwin":
        try:
            key = subprocess.run(["launchctl", "getenv", "GEMINI_API_KEY"],
                                 capture_output=True, text=True, timeout=5).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            key = ""
    if not key:
        key = _from_env_file(ROOT / ".env.local", "GEMINI_API_KEY")
    if not key:
        sys.exit("GEMINI_API_KEY is not set (checked the environment, launchctl and .env.local).\n"
                 "Add a line  GEMINI_API_KEY=...  to .env.local (gitignored; never NEXT_PUBLIC_),\n"
                 "or export it in your shell profile. Never paste it into a chat or a commit.")
    return key


def build_prompt(text: str, direction: str = "", delivery: str = "", pronunciation: str = "") -> str:
    """Director's notes first, transcript last, in the AI Studio TTS layout."""
    notes = ["Read only the transcript, exactly as written. Never read these notes aloud."]
    if direction:
        notes.append(f"Voice: {direction}")
    if delivery:
        notes.append(f"Delivery for this line: {delivery}")
    if pronunciation:
        notes.append(f"Pronunciation: {pronunciation}")
    return "## Director's notes:\n" + "\n".join(notes) + "\n\n## Transcript:\n" + text.strip() + "\n"


def _rate(mime: str) -> tuple[int, int]:
    """(sample_rate, bits) from e.g. 'audio/L16;codec=pcm;rate=24000'."""
    rate, bits = 24000, 16
    for part in mime.split(";"):
        part = part.strip()
        if part.lower().startswith("rate="):
            try:
                rate = int(part.split("=", 1)[1])
            except ValueError:
                pass
        elif part.lower().startswith("audio/l"):
            try:
                bits = int(part.split("L", 1)[1] if "L" in part else part.split("l", 1)[1])
            except ValueError:
                pass
    return rate, bits


def pcm_to_wav(pcm: bytes, rate: int, bits: int = 16, channels: int = 1) -> bytes:
    block = channels * bits // 8
    header = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(pcm), b"WAVE", b"fmt ", 16, 1,
                         channels, rate, rate * block, block, bits, b"data", len(pcm))
    return header + pcm


def synthesize(text: str, out_path: str | Path, *, direction: str = "", delivery: str = "",
               pronunciation: str = "", model: str = DEFAULT_MODEL, voice: str = DEFAULT_VOICE,
               temperature: float = 1.0, retries: int = 3) -> Path:
    """Render one line to a WAV file. Returns the path."""
    body = {
        "contents": [{"role": "user", "parts": [{"text": build_prompt(text, direction, delivery, pronunciation)}]}],
        "generationConfig": {
            "temperature": temperature,
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
    }
    req = urllib.request.Request(API.format(model=model), data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "x-goog-api-key": api_key()})
    last = ""
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                payload = json.loads(r.read())
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:400]
            last = f"HTTP {e.code}: {detail}"
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(4 * (attempt + 1))
                continue
            sys.exit(f"Gemini TTS failed: {last}")
        except urllib.error.URLError as e:
            last = str(e.reason)
            if attempt < retries - 1:
                time.sleep(4 * (attempt + 1))
                continue
            sys.exit(f"Gemini TTS failed: {last}")
    else:
        sys.exit(f"Gemini TTS failed: {last}")

    pcm, mime = bytearray(), ""
    for cand in payload.get("candidates", []):
        for part in (cand.get("content") or {}).get("parts", []):
            inline = part.get("inlineData")
            if inline and inline.get("data"):
                pcm.extend(base64.b64decode(inline["data"]))
                mime = inline.get("mimeType", mime)
    if not pcm:
        reason = json.dumps(payload.get("promptFeedback") or payload.get("candidates", [{}])[0].get("finishReason"))
        sys.exit(f"Gemini TTS returned no audio ({reason}).")

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    if mime.startswith("audio/wav") or mime.startswith("audio/x-wav"):
        out.write_bytes(bytes(pcm))
    else:
        rate, bits = _rate(mime)
        out.write_bytes(pcm_to_wav(bytes(pcm), rate, bits))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--direction", default="")
    ap.add_argument("--delivery", default="")
    ap.add_argument("--pronunciation", default="")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--voice", default=DEFAULT_VOICE)
    ap.add_argument("--temperature", type=float, default=1.0)
    a = ap.parse_args()
    p = synthesize(a.text, a.out, direction=a.direction, delivery=a.delivery, pronunciation=a.pronunciation,
                   model=a.model, voice=a.voice, temperature=a.temperature)
    print(f"wav -> {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
