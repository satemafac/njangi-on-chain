# Claude ↔ Muse handoff

Two agents, one queue. Claude (this repo) does strategy, copy, assets, and the
compliance scan. Muse (Meta's Mac agent, `/Applications/Muse.app`) does the
execution inside Meta surfaces: Instagram posting, Reels with audio, comments,
DMs, and reading analytics back. Neither can call the other directly (Muse has
no CLI, no MCP, no prompt deep link), so the bridge is this folder.

## Protocol

1. Claude writes a **job packet** to `inbox/NNN-<slug>/`:
   - `JOB.md` — what to do, in the order to do it, with the exact text to paste
     and the exact settings. Everything Muse needs is in the packet; it should
     not have to open the repo.
   - the assets (`.mp4`, `.jpg`), copied into the packet so paths are simple.
   - `MUSE-PROMPT.txt` — the one message the founder pastes into Muse.
2. The founder pastes `MUSE-PROMPT.txt` into Muse (desktop app or
   hatch.meta.ai) and approves Muse's actions as they come up. Publishing is
   always a human approval; that is Muse's rule and ours.
3. Muse writes `RESULT.md` into the same packet folder: what it posted, the
   post URL, the timestamp, and anything it could not do.
4. Claude reads `RESULT.md`, **posts the first comment itself** (Muse's
   Instagram tooling can read comments but cannot write them; Claude posts
   through the logged-in Chrome), moves the packet to `done/`, and updates
   `docs/social-content-queue.md`.

## How Muse reaches these files (verified 2026-09-24, in Muse's own words)

Muse runs on its own Linux VM; `/Volumes/...` does not exist there. Its
paired-device channel exposes the Mac's filesystem (`files.list`, `files.read`,
`files.write`, and `files.upload`, which pulls a Mac file up to 50 MB onto the
VM). That needs **Full Disk Access for the Muse Mac app** (Muse → Settings →
File system access). Its publisher refuses `/tmp` paths, so it stages assets
in its own workspace. Keep every packet asset under 50 MB.

## Talking to Muse directly

Claude can type into Muse and read its replies through macOS Accessibility
(`marketing/tools/ax.py`, whitelisted in `.claude/settings.json`). The
composer is not exposed as a text field; the working sequence is
`click --path <composer>` → paste from the clipboard (`key --code 9 --cmd`) →
`key --code 36`. Confirm the send by finding the text in the chat log, and
detect "still generating" by the composer's title ending in "Stop".

## Rules Muse must follow (they are in every JOB.md too)

- Step 0 of every publish job: check the post does not already exist on the
  account. (Job 001 was already live; Muse caught it, Claude had not.)

- Paste captions **verbatim**. No rewording, no added hashtags, no emoji.
- Never say audited, interest, returns, yield, earn, invest, guaranteed,
  savings account, deposit, blockchain, crypto, wallet in anything it writes.
- No location tag unless the packet names one.
- AI label only when the packet says so.
- If something in the packet is impossible, stop and write it in RESULT.md
  rather than improvising.

## Why this shape

Muse's filesystem tool reads any folder the Mac allows; its Instagram
connector is Meta-native, so video with sound and Reels with library audio
work there when they don't from a browser. Claude's harness can't upload
video to Instagram reliably and can't press Muse's buttons. Each does the half
it is good at.
