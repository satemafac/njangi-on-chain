# RESULT — Spec 003 (Claude, 2026-09-25)

Status: BUILT, all five decisions applied. Not yet committed or deployed;
migrations run on the next `npm run migrate:postgres` (tables also
lazy-create on first use).

## Decisions as implemented
1. Badge name "Founding Circle" — `badge_type = 'founding_circle'`,
   displayed as "Founding Circle" / "Cercle fondateur".
2. Earned on the first completed round — hourly cron
   `/api/cron/founding-badges` reads `njangi_circles::CyclePaused` and awards
   the circle's `admin` (never reassigned on chain, so admin == starter) when
   `cycle_completed` equals the circle's first on-platform cycle: 1 for a
   native circle, `starting_cycle` for a migrated one
   (`CircleMigrationActivated`). Idempotent via UNIQUE constraints; the cursor
   and lease reuse the other crons' machinery; Sui-first probe so quiet hours
   never wake Neon; hourly cadence per the Neon rule.
3. One free Premium month — `member_rewards` row with a 1-month window,
   granted with the badge (idempotent per circle). `getEntitlements` treats an
   active reward as Premium when the billing row says free. Never money,
   never a fee waiver (no fees exist), never touches a pot.
4. Celebration amount in circle currency only — `PayoutCelebration` shows
   `liveState.totalContributed` formatted in the circle's coin; no estimate.
5. Founder approves stories in /admin — `/admin/testimonials`, gated by the
   operator secret; approve / mark used / withdraw.

## Shipped files
- `src/components/PayoutCelebration.tsx`, wired in `CycleEscrowPanel.tsx`
- `src/lib/testimonials.ts`, `src/pages/api/testimonials/index.ts`,
  `src/pages/api/admin/testimonials/index.ts`, `src/pages/admin/testimonials.tsx`
- `src/lib/member-badges.ts`, `src/pages/api/me/badges.ts`,
  `src/pages/api/cron/founding-badges.ts`, `vercel.json` (hourly)
- `src/lib/member-rewards.ts`, `src/lib/entitlement-gate.ts` (reward hook)
- `src/components/CircleRecordView.tsx` (badges prop, own view only),
  `src/pages/record/index.tsx` (badges + "Your stories" with withdraw)
- `src/lib/i18n.ts` (EN + FR keys), `scripts/migrate-postgres.mjs` (#15–#17)

## Checks
`tsc --noEmit` clean · eslint clean · `check:copy` clean · copy-guard and
i18n-parity tests pass · dev-server smoke: new routes 401 without session /
secret, 405 on wrong method, pages compile.

## Not in v1 (deliberate)
- Photos on testimonials (no consented, revocable store; Walrus is public
  and immutable).
- An image share card (needs a runtime image route or a client renderer;
  v1 copies share text).
- Any fee logic (there are no fees on fund flows).

## Open
- Backfill: the cron's first full pass starts from the beginning of the
  event stream, so circles that completed a first round before today earn
  the badge on the first hourly tick. The Premium month for those starts
  from grant time, not from the historical round.
- `CRON_SECRET` must be set on Vercel for the new cron (same secret the
  other crons use).
