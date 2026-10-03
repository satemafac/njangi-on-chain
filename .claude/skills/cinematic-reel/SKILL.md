---
name: cinematic-reel
description: Build iPhone-ad-quality 3D brand films and Instagram Reels for Njangi On-Chain — a real-time WebGL (three.js) film rendered on the Mac's GPU with physically based gold, studio light, a glossy reflective floor, true motion blur and depth of field, Apple-style masked type, a Gemini TTS voiceover and a Lyria score cued to picture. Use this whenever the user wants a new "Circles of the World" episode (Susu, Ajo/Esusu, Paluwagan, Chama, Stokvel, Hui, Tanda…), an animated / motion-graphics video, a Reel, Short or TikTok for the brand, an "Apple-style", "iPhone ad", "premium", "cinematic" or "expensive-looking" product video, or says a video's animation quality is not good enough — even if they never say 3D. Prefer it over the generic video skill for anything Njangi publishes.
---

# Cinematic Reel

This is the house pipeline that produced *Circles of the World, Ep. 1: The
Tontine*, the film the founder called "incredible" after rejecting a flat 2D
version. It turns a script into a finished, publish-ready Reel:

```
spec.json ─▶ Gemini TTS voice (Whisper-QA'd) ─▶ word-timed timeline
                                                  │
     Lyria RealTime score, cued to the cuts ◀─────┤
                                                  ▼
     three.js film page (assets/circles/film.js) rendered on the GPU
     (16 sub-frames per frame: motion blur + depth of field + soft shadows)
                                                  ▼
     mix at -14 LUFS ─▶ film.mp4 · vo-only.mp4 · upload.mp4 · cover.jpg ─▶ Muse packet
```

Everything is deterministic in time: the same spec renders the same film.

## The quality bar (why it looks expensive)

These rules come from the Apple product-video framework the founder asked
us to meet. Each one is a decision, not a default, so keep to them:

- **Design first.** Probe stills (a contact sheet of every beat) come before
  any full render. A beautiful still that moves well beats a busy one.
- **Three colours, one house look.** Ink `#0a0a0c`, gold, ivory. Same
  studio, same floor, same type in every episode, so the series is
  recognisable from any frame.
- **One idea per shot**, the key object centred, room to breathe. The
  headline says the idea in ≤ 6 words; the picture shows the same idea.
- **Materials and light carry the premium feel**, not effects: polished gold,
  obsidian, a glossy floor with soft reflections, big soft light sources.
- **Eased, overlapping motion.** No linear moves, no robotic stops: camera
  keys use continuous-velocity curves; type rises out of a mask per word.
- **Dynamic transitions.** Dissolves or continuous camera moves between
  shots. A hard cut only when the message needs one (1653 → "Africa rewrote
  it." was the one).
- **Adaptive rhythm.** Slow and cinematic on heritage beats, a touch quicker
  on mechanics, a confident lift on the brand beat.
- **Music 60-80 BPM, heritage lane, VO-led. No SFX unless one clearly earns
  its place.**

Project rules that also apply (they are compliance and trust issues, not
taste):
- Never generate people. A synthetic face or hand reads as a fabricated
  member on a product whose pitch is "check it yourself". Use objects,
  materials, textiles, light.
- Copy follows `npm run check:copy` vocabulary (no interest / returns / yield /
  savings account…). Brand copy never says blockchain, crypto, Sui, web3 or
  wallet. No em dashes. First-person plural.
- Fact-check history. In Ep. 1 the draft said "1653. Italy." (de Tonti was
  Italian but proposed the tontine in France) and implied African rotating
  circles came after the French word (they are far older). Fix and flag.
- The narrator is synthetic, so the Reel needs Instagram's **AI info** label.
- Nothing publishes without the founder's approval; Muse publishes.

## Setup (once per machine)

```bash
bash .claude/skills/cinematic-reel/scripts/setup.sh
```

It installs three.js, puppeteer-core and the fonts into `marketing/tools`,
creates `marketing/tools/.venv` (openai-whisper with word timestamps +
google-genai), and reports whether `GEMINI_API_KEY` is in `.env.local`
(gitignored; never `NEXT_PUBLIC_`; never paste it into chat). Requires
Google Chrome, ffmpeg, Node, and Homebrew `python3.10`.

Below, `PY=marketing/tools/.venv/bin/python`.

## Workflow

### 1. Script → spec

A spec is one JSON file per film: `marketing/assets/<name>.spec.json`.
Copy `circles-ep01-tontine.spec.json` and edit. Per scene: `visual` (which
shot draws it), `headline` (`*gold*` markup, `\n` for a break), `vo`
(the exact spoken line; ` | ` marks caption breaks and is stripped before
TTS), `delivery` (a note to the voice), `lead`/`tail` (seconds of picture
before/after the line), `keywords`, optional `cut: true` (hard cut in),
`headline_at` (a word that triggers the headline), `captions: false`.
Also set `film_page` and `packet`, and optionally a `score` block
(`cues` per scene `visual`, `shift` in seconds) to colour the music for
this episode (Ep. 2 gave the Trinidad scene steelpan).

Keep scenes to one idea. If the voiceover runs long, trim holds, never the
voiceover.

### 2. Voice

```bash
$PY marketing/tools/build-circles-episode.py --spec <spec> --engine gemini --no-render
```

Each line is generated with Gemini TTS (voice in `spec.voice`), trimmed,
transcribed by Whisper and compared with the script; takes that drift are
redone (up to 3). Read the printed table: `qa` near 1.0 is right; "10,000"
for "ten thousand" and "Lincoln Bio" for "link in bio" are Whisper spelling,
not misreads. Redo single lines with `--retake 2,7`. Output: word-timed
`timeline-gemini.json` that drives every beat of the film.

### 3. Design first: probe stills

```bash
$PY marketing/tools/build-circles-film.py --spec <spec> --probe auto
$PY .claude/skills/cinematic-reel/scripts/contact_sheet.py \
    marketing/assets/export/<name>/probe-film /tmp/sheet.jpg
```

Three frames per scene plus the cover in ~1 minute. Read the sheet like an
art director (checklist in `references/qa.md`): does gold read as gold (not
white, not black)? Is every key object visible and centred? Does any type
collide with the picture or sit in Instagram's UI zones? Iterate on the film
page until every still is right, then render.

A new episode = copy `assets/circles/film.js` + `film.html` to
`film-<ep>.js/.html`, keep every `ENGINE` and `SERIES` section, rewrite the
`EPISODE` sections. How the engine works and how to add a shot:
`references/engine.md`. Numbers that worked and mistakes already made:
`references/calibration.md` (read it before touching light or bloom).

### 4. Score

```bash
$PY marketing/tools/lyria-realtime-score.py \
    --timeline marketing/assets/export/<name>/timeline-gemini.json \
    --out marketing/assets/export/<name>/score-rt.wav
$PY .claude/skills/cinematic-reel/scripts/score_qa.py \
    marketing/assets/export/<name>/score-rt.wav marketing/assets/export/<name>/timeline-gemini.json
```

Lyria RealTime is the only Lyria model on the free tier (`lyria-3.x` need a
paid plan). Series cues live in `CUES` inside the script, keyed by scene
`visual`; pass `--spec` and the spec's `score.cues` override them per episode.
Accept a take when QA shows no vocals and the brightness follows the story;
if a take fails, rerun with another `--seed`. Set `score.shift` to the
measured median lag.
Details and the mix chain: `references/audio.md`.

### 5. Render and deliver

```bash
$PY marketing/tools/build-circles-film.py --spec <spec>
```

Voice and score are cached, the mix is rebuilt, then ~2,400 frames render
at ~4.7 frames/s on an M1 Pro (≈ 8-9 minutes at 16 samples). Writes to
`marketing/assets/export/<name>/`: `<name>.mp4` (review copy),
`<name>-vo-only.mp4`, `<name>-cover.jpg`, `vo-NN.mp3`, and copies them to the
spec's packet. Make the upload copy after review (see `references/qa.md`).
Run long renders in the background and wait for completion.

### 6. Verify, then hand off

Check the finished MP4, not the page: transition frames, cover inside the
3:4 grid crop, loudness, encode quality (`references/qa.md`). Then update the
packet's `RESULT.md` (what changed, facts fixed, AI label, first comment,
no location tag for diaspora posts) and send the founder the MP4.

## Files

| Path | Role |
|---|---|
| `marketing/tools/build-circles-film.py` | one-command orchestrator (steps 2-5) |
| `marketing/tools/build-circles-episode.py` | voice + Whisper QA + timeline (also the old 2D renderer) |
| `marketing/tools/gemini-tts.py` | Gemini TTS over REST |
| `marketing/tools/lyria-realtime-score.py` | score to picture |
| `marketing/tools/gemini-music.py` | Lyria 3.x (needs a paid plan) |
| `marketing/tools/render-webgl.js` | GPU frame renderer → ffmpeg |
| `marketing/assets/circles/film.{html,js}` | the film engine + Ep. 1 |
| `references/engine.md` | engine architecture, adding shots and type |
| `references/calibration.md` | light, bloom, materials, known traps |
| `references/audio.md` | voice, score, mix |
| `references/qa.md` | review checklists, encode, publish handoff |
