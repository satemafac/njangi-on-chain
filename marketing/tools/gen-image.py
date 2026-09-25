#!/usr/bin/env python3
"""
gen-image.py — brand image generation for Njangi On-Chain marketing assets.

Reads OPENAI_API_KEY from the environment and never prints, logs, or echoes it.
Writes a PNG to the path you give it.

    python3 marketing/tools/gen-image.py \
        --prompt "..." \
        --out marketing/assets/og/blog-women-led.png \
        --size 1536x1024

Notes for this project specifically:
  * Image models render text badly. Never ask for words in the image —
    typographic assets are built as HTML (see marketing/assets/*.html).
  * Never generate people. On a product whose pitch is "check it yourself",
    synthetic faces read as fabricated members. Texture and abstraction only.
  * Every call costs money on the account that owns the key.
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.openai.com/v1/images/generations"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="gpt-image-1")
    ap.add_argument("--size", default="1024x1024",
                    help="1024x1024 | 1536x1024 (landscape) | 1024x1536 (portrait)")
    ap.add_argument("--quality", default="high", choices=["low", "medium", "high", "auto"])
    ap.add_argument("--n", type=int, default=1)
    args = ap.parse_args()

    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        print("OPENAI_API_KEY is not set in this shell.\n"
              "Export it in your shell profile so tooling can read it without it "
              "being pasted anywhere:\n"
              "  echo 'export OPENAI_API_KEY=\"sk-...\"' >> ~/.zshrc && source ~/.zshrc",
              file=sys.stderr)
        return 2

    payload = {
        "model": args.model,
        "prompt": args.prompt,
        "size": args.size,
        "n": args.n,
    }
    # dall-e-3 rejects the quality vocabulary gpt-image-1 uses.
    if args.model == "gpt-image-1":
        payload["quality"] = args.quality

    req = urllib.request.Request(
        API,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            body = json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:600]
        # Scrub the key if the server ever echoes the request back.
        print(f"HTTP {e.code}: {detail.replace(key, '[redacted]')}", file=sys.stderr)
        return 1
    except Exception as e:  # network, timeout
        print(f"request failed: {type(e).__name__}: {str(e).replace(key, '[redacted]')}",
              file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    written = []
    for i, item in enumerate(body.get("data", [])):
        b64 = item.get("b64_json")
        if not b64:
            url = item.get("url")
            if not url:
                continue
            with urllib.request.urlopen(url, timeout=300) as ir:
                raw = ir.read()
        else:
            raw = base64.b64decode(b64)
        out = args.out if i == 0 else f"{os.path.splitext(args.out)[0]}-{i+1}.png"
        with open(out, "wb") as f:
            f.write(raw)
        written.append(f"{out} ({len(raw)//1024} KB)")

    if not written:
        print("no image data returned", file=sys.stderr)
        return 1
    print("\n".join(written))
    return 0


if __name__ == "__main__":
    sys.exit(main())
