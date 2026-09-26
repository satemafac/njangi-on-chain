#!/usr/bin/env bash
# One-time setup for the cinematic-reel pipeline. Safe to re-run.
# Installs the render deps into marketing/tools and a Python venv at
# marketing/tools/.venv (gitignored). Never prints secrets.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT/marketing/tools"

echo "· node deps (three, puppeteer-core, fonts)"
npm install --no-audit --no-fund >/dev/null
for p in three puppeteer-core @fontsource/inter-tight @fontsource/instrument-serif @fontsource/ibm-plex-mono; do
  [ -d "node_modules/$p" ] || { echo "  missing $p, installing"; npm install --no-audit --no-fund "$p" >/dev/null; }
done

echo "· python venv (openai-whisper with word timestamps, google-genai)"
PY="${PYTHON:-/opt/homebrew/bin/python3.10}"
[ -x .venv/bin/python ] || "$PY" -m venv --system-site-packages .venv
.venv/bin/pip install -q -U openai-whisper coverage google-genai
.venv/bin/python - <<'EOF'
import inspect, whisper, google.genai  # noqa: F401
assert "word_timestamps" in inspect.signature(whisper.transcribe).parameters, "whisper too old"
print("  venv ok")
EOF

echo "· checks"
if grep -q '^GEMINI_API_KEY=.\+' "$ROOT/.env.local" 2>/dev/null; then echo "  GEMINI_API_KEY: set in .env.local"
else echo "  GEMINI_API_KEY: MISSING. Add a line GEMINI_API_KEY=... to .env.local (gitignored, never NEXT_PUBLIC_)."; fi
[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && echo "  Chrome: ok" || echo "  Chrome: missing"
command -v ffmpeg >/dev/null && echo "  ffmpeg: ok" || echo "  ffmpeg: missing (brew install ffmpeg)"
echo "done. Use PY=marketing/tools/.venv/bin/python"
