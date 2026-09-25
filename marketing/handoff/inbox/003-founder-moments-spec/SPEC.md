# Spec 003 — Founding Circle badge, payout celebration, testimonial capture

Drafted by Muse 2026-09-24 (pasted into chat, filed by Claude). Claude's
amendments are marked **[Claude]**. This is a codebase build spec, not a
publishing job. When the build ships, Claude writes RESULT.md here.

## Goal
Make starting a circle and receiving a payout feel rewarding and shareable.
Three linked mechanics: a badge for circle starters, an in-app moment when a
member receives the pot, and a one-tap "share your story" at that moment that
feeds the content queue with real circle stories.

## 1. Founding Circle badge
- Name (proposed): "Founding Circle". `DECISION: badge name.`
- Earned when: a circle you started completes its first full payout round
  (earning beats granting at creation). `DECISION: on first completed round, or
  at circle activation?`
- Where it shows: **the member's own Circle Record only.** It is a member-owned
  proof, never a score, tier or rating; not next to names in member lists, not
  on the circle page, not visible to other members as a ranking signal. **[Claude]**
- v1: single badge, no tiers.
- **[Claude] Struck: "fee-free first round for starters / fee waiver flag".**
  The product has no platform fee on contributions, payouts or swaps, ever
  (CLAUDE.md invariant 3), so there is nothing to waive and no `fee_waivers`
  table. The equivalent starter reward that fits the model is Premium time:
  `DECISION: grant the starter N free months of Premium when the badge is
  earned? (N = 0, 1 or 3.)`

## 2. Payout celebration
- Trigger: the member's own successful payout claim (recipient-pull
  `claim_payout`). Fires once per payout (idempotency key = escrow id / claim tx).
- Experience: full-screen moment showing amount received, round number, circle
  name. Dignified, not casino.
- Two CTAs: "Share your story" (testimonial capture) and "Start your own circle".
- Shareable: a simple share card (circle name, round number, "It's my turn: I
  just received my circle payout") the user saves or shares manually. No
  auto-posting to socials, ever.
- Copy rule **[Claude]**: never state or imply a return, interest or yield. A
  payout is the member's own turn. Use "your turn" / "your payout"; never
  "winnings", "profits", "returns", "growth", "earned".
- `DECISION: does the celebration show the amount in the circle's currency
  only, or also a local-currency estimate?` (Estimates imply a rate we don't
  control; recommendation: circle currency only.)

## 3. Testimonial capture
- Fields: user, circle, quote (text), photo (optional), consent_marketing
  (explicit checkbox, must be true before any marketing use), created_at.
- Admin review queue: pending / approved / used. Consent withdrawn → unusable,
  excluded from the queue.
- Copy constraints: no audited, interest, returns, yield, earn, invest,
  guaranteed, savings account, deposit, blockchain, crypto, wallet.
- `DECISION: who approves stories, and where? (Proposed: the founder, in
  /admin, next to the compliance console.)`
- **[Claude]** Photos are PII-adjacent; store off-chain, never on the ledger,
  and only after consent. Quote text is the asset; photo optional.

## 4. Data model (adapt to codebase conventions)
- badges: id, user_address, badge_type ('founding_circle'), circle_id, awarded_at.
- testimonials: id, user_address, circle_id, quote, photo_url (nullable),
  consent_marketing, status (pending/approved/used/withdrawn), created_at.
- (no fee_waivers)

## 5. API surface
- Internal: on first-round completion → award badge; on payout claim → return
  the celebration payload.
- POST /api/testimonials (signed-in member; consent flag required).
- GET /api/admin/testimonials?status=pending (admin only).
- GET /api/me/badges.

## 6. Edge cases
- Circle dissolves before the first round completes: no badge.
- Starter leaves after the round completed: badge stays (proposed).
- Duplicate payout events: celebration fires once (idempotency key).

## 7. Non-goals for v1
Public leaderboard, badge tiers, auto-posting to socials, any fee logic.

## 8. Acceptance
- Start a circle → complete the first round → badge appears in the starter's
  own Circle Record and nowhere as a score or ranking.
- Payout → celebration with both CTAs; "Share your story" with consent → the
  story appears in the admin queue.
- `npm run check:copy` passes; celebration copy passes the no-return rule.

## 9. Build order (Claude)
1. Migrations (badges, testimonials). 2. Badge award on round completion +
Circle Record display. 3. Celebration payload + screen. 4. Share card.
5. Testimonial capture + admin queue. 6. Copy scan.

## DECISIONS for the founder (answer before build step 2)
DECISION: badge name ("Founding Circle"?).
DECISION: earn on first completed round (recommended) or at activation?
DECISION: starter reward = N free months of Premium (0 / 1 / 3)?
DECISION: celebration amount in circle currency only (recommended)?
DECISION: who approves testimonials, and where (/admin proposed)?
