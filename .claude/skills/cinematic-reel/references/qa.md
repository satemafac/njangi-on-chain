# QA: review checklists, encode, handoff

You cannot watch the film in real time, so review stills deliberately and
check the numbers. Everything here runs in a minute or two.

## Probe sheet (before any full render)

`build-circles-film.py --spec <spec> --probe auto` renders three stills per
scene plus the cover; tile them with `scripts/contact_sheet.py`. Then view
the sheet and a few frames at ~540 px wide. Check, in this order:

1. **Material read.** Gold is gold (yellow with gradients), not white and
   not black. Obsidian shows highlights. Nothing glows unless it should.
2. **Every key object is visible and centred**, nothing hidden behind
   another object, nothing cropped at the frame edge.
3. **Type**: crisp (no halo), no collisions with the hero, two-line
   headlines stay two lines, captions clear of objects.
4. **Instagram zones**: keep type out of the top ~180 px and below
   ~1560 px; keep anything important out of the right-hand ~120 px between
   ~1100-1650 px (the action buttons).
5. **One idea per frame**: if a still needs explaining, the shot is wrong.
6. **Cover** (last tile): inside the 3:4 profile-grid crop (y 240-1680).

## Motion (after the full render)

Pull frames from the MP4 across every transition and at the busiest beats:

```bash
PY=marketing/tools/.venv/bin/python
$PY .claude/skills/cinematic-reel/scripts/contact_sheet.py --video <film.mp4> \
  --times 1.0,<cut-0.2>,<cut+0.1>,<cut+0.5>,<dissolve mid>,... /tmp/transitions.jpg
```

Look for: the fade-up from black, the hard cut landing cleanly, masked type
mid-reveal (words half out of the mask), dissolves showing a true double
exposure, and the title card holding at the end.

## Encode and numbers

- `ffprobe`: 1080×1920, 30 fps, AAC 48 kHz stereo, duration = timeline total.
- Loudness: `ffmpeg -i film.mp4 -af ebur128=peak=true -f null -` → about
  -14 LUFS integrated, true peak ≤ -1.5 dB.
- Review copy CRF 20 (~40 MB for 78 s); check it against the master with
  `-lavfi "[0:v][1:v]psnr"` (expect > 40 dB; only the fine grain softens).
- Upload copy CRF 16 from the master (~215 MB): give Instagram's encoder the
  best input. Masters and upload copies are gitignored (GitHub rejects
  files over 100 MB); never commit them.

## Handoff to Muse (after the founder approves)

Update the packet's `RESULT.md` with: status, deliverables, any fact fixes
made to the script (and ask the founder to confirm them), and publish notes:
- Step 0: check the Reel is not already on the account.
- Upload `<name>-upload.mp4`, cover `<name>-cover.jpg`.
- Instagram **AI info** label ON (synthetic narrator).
- Caption from the script, checked against the copy rules; first comment
  with the /learn link; no location tag for diaspora posts.
- If the brand wants a licensed Instagram track instead of the Lyria score,
  upload `<name>-vo-only.mp4` and add the track in-app.
