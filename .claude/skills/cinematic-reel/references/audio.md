# Audio: voice, score, mix

## Voice (Gemini TTS)

- Tool: `marketing/tools/gemini-tts.py` (REST, stdlib). Model and voice come
  from `spec.voice` (Ep. 1: `gemini-3.8-flash-tts`, voice `Fola`, chosen by
  the founder), plus a house direction, a per-line `delivery` note and a
  pronunciation guide. The prompt puts director's notes first and the
  transcript last ("## Transcript:"), which keeps the model from reading the
  notes aloud.
- One clip per scene keeps captions exact. Each take is trimmed (-46 dB),
  resampled to 48 kHz, transcribed by Whisper medium with a vocabulary hint
  (names only, never the full script, or the QA would be meaningless), and
  scored against the script. Below `QA_MIN` (0.86) or outside 1.6-3.6
  words/s → retake (max 3), best take kept.
- Key lookup: `GEMINI_API_KEY` env → `launchctl getenv` → `.env.local`.
  `launchctl getenv` exits 0 even when unset: test for a non-empty value.
  Never print the key, never put it in a `NEXT_PUBLIC_` var.
- The free tier covers TTS.

## Score (Lyria RealTime)

- `lyria-3.5`, `lyria-3-pro-preview`, `lyria-3-clip-preview` answer
  `generateContent` but have **zero free-tier quota** (HTTP 429, "limit: 0").
  `marketing/tools/gemini-music.py` is ready for them if billing is enabled.
- `lyria-realtime-exp` works on the free tier through google-genai's live
  API (`client.aio.live.music.connect`, api_version v1alpha). The script
  streams for the film's length and swaps weighted prompts + config at each
  scene start minus `LEAD` (1.8 s). Chunks arrive in ~2 s blocks, so cues
  land on 2 s boundaries.
- House cues (edit `CUES` per film, keyed by scene `visual`): BPM 70, D
  major / B minor, a shared style prompt (instrumental, heritage, no
  vocals) at weight 0.6 plus a scene prompt; `density`, `brightness`,
  `mute_drums` per scene (drums only on mechanic and resolution beats).
- Measured behaviour: the timbre changes ~1.0 s after a cue (median), so
  the mix trims 0.8 s off the head of the score (`SCORE_SHIFT`).
- QA with `scripts/score_qa.py`: reject any take where Whisper finds speech;
  expect brightness to move with the story (Ep. 1: 1653 ≈1.1 kHz, the turn
  ≈3.2 kHz, mechanics ≈3.8 kHz, Douala ≈2.4 kHz, the catch ≈1.5 kHz, the
  brand beat ≈4.2 kHz). Lyria output carries a SynthID watermark.

## Mix (in `build-circles-film.py`)

1. Score: trim `SCORE_SHIFT`, 1.6 s fade-in, 3.2 s fade-out ending at the
   film's last frame, two-pass loudnorm to **-23 LUFS**.
2. Voice track (already -16 LUFS, high-pass 70 Hz, gentle 2.5:1 compression)
   is the sidechain: `sidechaincompress=threshold=0.04:ratio=3.5:attack=40:
   release=650` on the score. The slow release keeps it from pumping
   between phrases.
3. Sum, then two-pass loudnorm to **-14 LUFS, true peak -1.5 dB** (Instagram
   normalises around -14). Ep. 1 measured -13.9 LUFS, -1.9 dBTP, LRA 3.7.
4. Also export a voice-only master at -14 LUFS for a licensed Instagram
   track at publish.

Two-pass loudnorm matters: single-pass (dynamic) mode audibly rides the
level on short material.
