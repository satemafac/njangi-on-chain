# RESULT 008 · Content around Tayo Oviosu's Sui Live talk (Claude)

Status: **DRAFTED.** Nothing is posted or scheduled. All four drafts are in
[`DRAFTS.md`](DRAFTS.md); Muse prepares previews and Stalanic approves.

| # | Deliverable | Size |
|---|---|---|
| 1 | LinkedIn post, company page | 1,744 characters, no hashtags |
| 2 | Instagram carousel, 7 slides, plus caption | caption 609 characters, 4 hashtags |
| 3 | Reel script, about 40 s, plus caption | 103 words of voiceover; caption 374 characters |
| 4 | Three comment angles (A, B, C) | 163 to 220 characters each |

**The through-line:**
- Tayo says financial freedom is "move, transact, save".
- Communities across Africa have run the "save" part together for
  generations, in a circle: esusu in Lagos, njangi in Cameroon, susu in
  Ghana.
- The circle is infrastructure too. Its one weak point is that somebody has
  to hold the pot. We kept the circle and changed that one thing.

## How the seven tie-in angles were used

| Angle | Used? | Where, and why |
|---|---|---|
| 1. Move, transact, save | **Yes, the spine** | All four pieces. His third pillar is "save or invest". We quote only "move, transact, save", his own summary, so the banned word never appears. |
| 2. The trust parallel | **Yes** | LinkedIn and the Reel. His line "We did not set out to build an app. We set out to build an infrastructure." becomes our point: the circle is infrastructure too. |
| 3. A tax on friction | **Yes, refined** | LinkedIn, plus the Reel's closer. We dropped "on-chain removes the single point of trust failure". Our copy guard bans absolute risk claims ("no single point of failure", "eliminates fraud"), and on-chain does not stop a member from missing a payment. What we say is true and specific: nobody holds the pot, and every member sees the same ledger. The Reel closes on our live site's own line, "The same circle, less friction". |
| 4. Currency erosion | **No** | Circles do settle in USDC by default (verified below). But tying that to the Lagos teacher's lost savings says, in effect, our product protects people from devaluation. That is a financial promise, and it sits right next to the yield product he pitched. If Stalanic wants this angle, counsel should see the words first. |
| 5. The demographic wave | **Yes** | Carousel slides 4 and 5, the LinkedIn close, comment B. |
| 6. Same rails | **Partly** | LinkedIn says "We build on Sui too". We dropped "we move trust", which is vague and reads as a pairing with Paga that does not exist. Nothing implies a partnership with Paga or Sui. |
| 7. The hospital story | **No** | It is his friend's emergency, and borrowing it to sell our product reads as exploitative. A rotating circle also pays on a fixed schedule, so we cannot suggest it supplies emergency money, and "the payout hand has saved lives" cannot be verified. |

## Product facts, checked against the repo

| Claim in the drafts | Evidence |
|---|---|
| Nobody holds the pot, not the organiser and not us; contributions sit where no company can reach them | CLAUDE.md invariant 1 (no operator or admin function can direct user funds). Per-round escrow in `move/sources/njangi_cycle_escrow.move`. |
| Only the member whose turn it is can collect the payout | `njangi_cycle_escrow.move:752`, `:768` and `:833`: `assert!(sender == recipient, E_NOT_RECIPIENT)`. `finalize_and_redeem` is "only callable by the scheduled recipient themselves". |
| Every member sees the same ledger | Live site feature "Everyone sees the same ledger" (`src/lib/i18n.ts`, `landing.feature.sharedVisibility`). |
| "The same circle, less friction" | Live site feature title (`landing.feature.culturalContinuity.title`). |
| We are live on testnet today | Live site: "The product is live for testnet exploration today" (`landing.launch.body`). Mainnet is not live, so no draft says "real money" or "live". |
| We build on Sui | Move package in `move/`, deployed on Sui testnet. |
| Esusu in Lagos; Yoruba communities ran it long before any colonial bank reached the region | Our glossary, `src/content/rosca-terms.ts` (esusu: "recorded among the Yoruba of what is now south-western Nigeria long before any colonial banking system reached the region"). |
| Njangi in Cameroon, where our name comes from | Ep. 1's approved caption. |
| Susu in Ghana | Ep. 2 fact-check (Twi meaning, Ghanaian national press). |

Not used, on purpose:
- **Ajo.** Our glossary defines ajo as the daily collector model, "not a
  rotation", so calling it a rotating circle would contradict our own site.
  This also bears on Ep. 3's pending fact-check.
- **zkLogin.** It never comes up.
- **Fees.** Following the brief, there is no fee claim of any kind.

## Facts from the talk

- **Talk details** (verified from the YouTube page on 2026-10-01): title "Sui
  Live: From Lagos to the World: The Future of African Payments", channel
  Sui, published 7 May 2026, length 15:38. The description says "Recorded
  live at Faena Forum on May 7, 2026", with Tayo Oviosu as "Founder & Group
  CEO, Paga".
- **Numbers used, each credited to Tayo:** 6 weeks a year paying bills in
  cash; $1 trillion+ a year in African mobile money; 60% under 25; 2.5
  billion by 2050 and one in four people on Earth; 40% of the world's young
  people by 2050; Paga's 17 years. They are his statements and we credit
  them to him. Only the population figures match well-known UN projections;
  the rest were not independently checked.
- **Not used:**
  - 57% of African adults without a bank account: the figure depends on
    whether mobile money counts, and we did not reconcile it with the World
    Bank's survey.
  - 6.4% transfer fees: fees are off-limits for us.
  - Crypto adoption and the "high-yield" accounts: banned vocabulary.
- **Quotes** are short and verbatim from TRANSCRIPT.md.
- **No footage, audio or images of Tayo** are used anywhere.

## Decisions for Stalanic

1. **DECIDED 2026-10-01: keep Sui in** (Stalanic). **The word "Sui" in our copy.** Our positioning rule
   (`.agents/product-marketing.md`) keeps "Sui", "crypto", "wallet" and
   "blockchain" out of marketing copy, so the chain is never the headline.
   This job is about a Sui event, so:
   - Sui appears as the event's name in the credits and captions.
   - On LinkedIn only, it appears in one sentence of ours: "We build on Sui
     too". DRAFTS.md has the one-line swap that removes it.
   - The Instagram pieces never use Sui to describe our product.
2. **Mentions.** On LinkedIn, mention Paga and Tayo Oviosu as chips, and Sui
   optionally (use the official `sui-foundation` page; impostor pages
   exist). On Instagram, credit them by name and @-mention only if their
   official handles are confirmed.
3. **BUILT 2026-10-01 (see "The Reel" below), awaiting Stalanic's review.** **The Reel needs a build and an AI-label call.** It is a script, not a
   video. Built with our `cinematic-reel` pipeline (3D, Gemini voice, Lyria
   score) it has the same AI-label question as Circles of the World.
4. **Timing.** These are topical, not series posts, so keep Friday and
   Saturday for Circles of the World. A sensible order: LinkedIn on a
   weekday morning (8:30 AM ET worked before), the carousel a day or two
   later, then the Reel once built.

## The Reel (built 2026-10-01, Claude)

**Status:** built, awaiting Stalanic's review. Nothing is posted or
scheduled.

| File | Use |
|---|---|
| `reel-008-move-transact-save.mp4` | The Reel. Review copy: 20.3 MB, 45.2 s, 1080x1920, 30 fps. Visually lossless (CRF 20) and well under Muse's 50 MB pull. |
| `reel-008-move-transact-save-cover.jpg` | Cover: "Move. Transact. Save.", the gold star mark, "Nobody holds the pot." (inside the 3:4 grid crop). |
| `reel-008-move-transact-save-vo-only.mp4` | Voice only, if a licensed Instagram track replaces the score. |
| `vo-01.mp3` … `vo-07.mp3` | The Gemini TTS lines, one per beat. |

The CRF 16 upload copy (117 MB) stays in
`marketing/assets/export/reel-008-move-transact-save/`. It is gitignored
and too large for Muse's channel.

**What it shows** (script as built: DRAFTS.md section 3):
1. A generic phone lies dark on the studio floor while a strip light glides
   across its glass: "Africa's original savings app has no app."
2. A name card for Tayo Oviosu over dark water.
3. On "move" a gold line races to the horizon. On "transact" a second
   comes back across it. On "save" both gather into the circle.
4. Esusu (LAGOS), Njangi (CAMEROON), Susu (GHANA), each with a ring of
   light.
5. The series mechanic.
6. The catch, with every thread running through one holder.
7. "Nobody holds the pot", every member tied to every other.
8. The brand card.

No people. No footage or audio of Tayo: he is credited in on-screen text
only.

**Checks:**
- **Voice.** Every line passed Whisper QA (0.99 to 1.00). A first take
  sounded like "move, transact, *safe*", so it was retaken until Whisper
  heard "save".
- **Score.** No vocals. Brightness follows the story: quiet under the
  hook, darkest in the catch, brightest on "nobody holds the pot".
- **Loudness.** -14.0 LUFS integrated, true peak -2.0 dBFS.
- **Picture.** Frames reviewed at every transition.

**Publish notes (Muse, after Stalanic approves):**
- **Step 0:** check the Reel is not already on the account.
- **Upload:** the video and cover above.
- **Caption:** DRAFTS.md section 3, "Reel caption".
- **AI label:** the narrator and score are AI-generated, so this is the
  same call as the series.
- **Tags:** no location tag. Credit Tayo and Paga by name, and @-mention
  only if their official handles are confirmed.
- **Slot:** keep Friday and Saturday for Circles of the World.
- **First comment (Claude):** the full talk,
  https://www.youtube.com/watch?v=IQ851ZlNoh4

