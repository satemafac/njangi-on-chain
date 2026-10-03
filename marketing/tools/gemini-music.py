#!/usr/bin/env python3
"""
gemini-music.py — an instrumental score for a Reel via Google's Lyria (Gemini API).

Same key handling as gemini-tts.py: GEMINI_API_KEY from the environment,
launchd, or the gitignored .env.local; never printed.

    python3 marketing/tools/gemini-music.py \
        --prompt-file marketing/assets/circles-ep01-score.txt \
        --out marketing/assets/export/circles-ep01-tontine/score-take1 \
        [--model lyria-3.5]

Writes <out>.<ext> in whatever audio format the model returns (and any text
it returns, e.g. a description, to <out>.txt).

Notes for this project specifically:
  * Series rule (MOTION-BRIEF): 60-80 BPM, cinematic heritage lane, VO-led,
    same family every episode. Keep the prompt file per episode in git so the
    family stays consistent.
  * Always ask for instrumental / no vocals, then verify: run Whisper over the
    result; any transcribed words mean the take has vocals.
  * Every call costs money on the account that owns the key.
"""
from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import mimetypes
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


def _key() -> str:
    spec = importlib.util.spec_from_file_location("gemini_tts", HERE / "gemini-tts.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.api_key()


def generate(prompt: str, out: Path, model: str = "lyria-3.5", modalities=("AUDIO",)) -> list[Path]:
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"responseModalities": list(modalities)}}
    req = urllib.request.Request(API.format(model=model), data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "x-goog-api-key": _key()})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                payload = json.loads(r.read())
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:600]
            if e.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(6 * (attempt + 1))
                continue
            sys.exit(f"Lyria failed: HTTP {e.code}: {detail}")
    written: list[Path] = []
    texts: list[str] = []
    n = 0
    for cand in payload.get("candidates", []):
        for part in (cand.get("content") or {}).get("parts", []):
            inline = part.get("inlineData")
            if inline and inline.get("data"):
                mime = inline.get("mimeType", "audio/wav")
                ext = mimetypes.guess_extension(mime.split(";")[0]) or ".bin"
                if ext == ".bin" and "wav" in mime:
                    ext = ".wav"
                f = out.with_name(out.name + (f"-{n}" if n else "") + ext)
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_bytes(base64.b64decode(inline["data"]))
                written.append(f)
                n += 1
                print(f"audio ({mime}) -> {f}")
            elif part.get("text"):
                texts.append(part["text"])
    if texts:
        t = out.with_suffix(".txt")
        t.write_text("\n".join(texts))
        print(f"text -> {t}")
    if not written:
        sys.exit(f"Lyria returned no audio: {json.dumps(payload)[:600]}")
    return written


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt-file", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="lyria-3.5")
    ap.add_argument("--with-text", action="store_true", help="also request TEXT modality")
    a = ap.parse_args()
    prompt = Path(a.prompt_file).read_text()
    generate(prompt, Path(a.out), a.model, ("AUDIO", "TEXT") if a.with_text else ("AUDIO",))
    return 0


if __name__ == "__main__":
    sys.exit(main())
