# Sanctions Program (internal)

_Last updated: 2026-07-05. Owner: founder. Roadmap:
[compliance-roadmap-cex-dex-non-kyc.md](compliance-roadmap-cex-dex-non-kyc.md) §A1.
Escalation: [incident-playbook.md](incident-playbook.md)._

One page describing what we screen, when, and what happens on a hit. This
document is the "program" a reasonable-measures OFAC posture expects a
non-custodial software provider of our size to have.

## What we screen

**Wallet addresses** against the OFAC SDN digital-currency address set
(every ticker OFAC publishes, ~400-500 addresses today), plus **IP geolocation**
against comprehensively embargoed jurisdictions (Iran, North Korea, Syria,
Cuba, and embargoed Ukrainian regions: Crimea, Sevastopol, Donetsk,
Luhansk). We do not screen names — we do not collect any.

## Where (choke points)

**Proof issuance is now the primary choke point.** Transactions are signed in
the browser, so the old per-action server screens no longer sit on the money
paths — the `circle_create` screen lives inside `sendTransaction`, which
returns 409 for every current session and therefore enforces nothing. What
replaced it is refusing to mint zkProofs: without a proof the client cannot
assemble a zkLogin signature, so nothing reaches the chain.

Declining to authenticate is not seizing or freezing assets. We never gain
the ability to move a user's funds; we decline to help. That is what keeps
this compatible with the non-custodial posture.

| Surface | Mechanism | Layer | Fail mode |
|---------|-----------|-------|-----------|
| **Login / proof issuance** | `screenAddress(addr,'proof_issuance')` in `api/zkLogin.ts` `handleCallback`, before proofs are returned → 403 | **Server (primary)** | open |
| Circle join | `screenAddress(addr,'circle_join', {failClosed:true})` in `api/join-requests/create.ts` before any DB write | Server | **closed** |
| Ramp session | `screenAddress(wallet,'ramp_session', {failClosed:true})` in `api/onramp/*/session.ts` | Server | **closed** |
| WhatsApp link | `screenAddress(addr,'whatsapp_link')` in `api/whatsapp/admin-link-circle.ts` before the Walrus upload | Server | open |
| Circle create | `screenAddress(addr,'circle_create')` in `api/zkLogin.ts` | **Vestigial** — inside `sendTransaction`, unreachable for current sessions. Covered by proof issuance. | n/a |
| Goal-pool create / escrow open | `preflightSanctionsCheck()` → `GET /api/sanctions/check` | Client preflight (UX only — these sign client-side straight to RPC) | n/a |
| App routes (pages) | `src/middleware.ts` geo-block → `/restricted` | Edge | n/a |
| API choke points | `isEmbargoedHeaders()` → 403 `EMBARGOED_REGION` | Server | n/a |

**Why the fail modes differ.** New commitments (join, ramp) fail CLOSED: an
unscreened commitment cannot be undone, and nothing is stranded by asking the
member to retry. Login, claim, refund and recovery fail OPEN, because those
reach funds a member has *already* committed — failing them closed during an
outage would trap money, which is a worse compliance outcome than a delayed
screen. The 2026-07-21 Neon outage is the concrete case: a fail-closed login
would have locked every user out of their own funds for twelve days.

A caller blocked by fail-closed gets `SCREENING_UNAVAILABLE` (503), not
`SANCTIONS_BLOCKED` (403) — an innocent user must not be told they are banned
because Postgres blinked.

**Known window:** proofs live one Sui epoch (~24h). A user listed immediately
after logging in keeps a usable proof until it expires. The weekly retro-sweep
is what catches that window; there is no way to revoke an issued proof.

Blocked responses are deliberately neutral user-side ("This wallet can't
use Njangi On-Chain.") with stable codes (`SANCTIONS_BLOCKED`,
`EMBARGOED_REGION`) in logs and bodies.

## List source and refresh

- Authoritative source: `https://www.treasury.gov/ofac/downloads/sdn.csv`,
  parsed for `Digital Currency Address - <TICKER> <address>` entries.
- Weekly cron `/api/cron/sanctions-refresh` (Mondays 06:00 UTC): fetch →
  content-hash short-circuit → floor guard (`SANCTIONS_MIN_ADDRESS_FLOOR`,
  abort + keep last-good on suspicious shrinkage) → transactional upsert +
  delisting prune → meta row. Optional read-only mirror cross-check
  (`SANCTIONS_MIRROR_CROSSCHECK_URL`) warns on >10% divergence, never
  ingests.
- **Bootstrap after each fresh deploy/migration — REQUIRED, not optional:**
  `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/sanctions-refresh`

  Or, with database access instead of the cron secret:
  `DATABASE_URL=<target> npm run bootstrap:sanctions`

  An empty list is not "everything passes" — it is "screening cannot run".
  Every fail-closed surface (circle join, ramp session) therefore refuses
  with `SCREENING_UNAVAILABLE` until this has run. Observed 2026-08-02:
  after migrating to a new Neon database, `sanctions_list_meta` was empty
  and joins returned 503 until the list was bootstrapped. `migrate:postgres`
  creates the tables; it does NOT populate them.
  then confirm the response reports a plausible `addressCount` (~400-500).
  Note: production `CRON_SECRET` is a Vercel **sensitive** env var —
  `vercel env pull` returns it empty, so the curl needs the real value
  (Vercel's own scheduled invocations inject it automatically and are
  unaffected; verified firing on schedule 2026-07-13). If the value isn't
  at hand, the fallback used for the 2026-07-05 bootstrap works: run the
  app locally with the production `DATABASE_URL` and a temporary
  `CRON_SECRET`, and curl localhost — the real handler then executes
  against the production table.

## Fail mode and compensations

Screening **fails open** on infrastructure errors (house precedent; if
Postgres is down the surrounding action fails anyway). Compensations:

1. Every decision (pass / blocked / error_fail_open) is written to
   `sanctions_screen_log`; fail-opens also `console.error` loudly
   (Vercel log drain = evidence trail).
2. The weekly cron runs a **retro-sweep**: recent pass/fail-open log rows
   are re-joined against the fresh list; hits are logged as
   `retro_sweep`/`blocked` and escalate per the incident playbook.
3. A **positive hit is never fail-open** — a match always blocks, even if
   the audit write fails.

Kill switches `SANCTIONS_SCREENING_ENABLED` / `SANCTIONS_GEO_BLOCK_ENABLED`
are **default-ON**; setting either to `false` triggers a `validate:env`
warning. Turning them off in production is an operator decision to be
documented at the time.

## On a hit (summary — full steps in incident-playbook.md)

We cannot freeze or move funds (non-custodial, by design). What we do:
refuse the action (automatic), keep refusing service, preserve the log
rows, and call counsel before any external communication. Do not tell the
counterparty they are "sanctioned" — the neutral copy exists on purpose.

## Monthly review (Phase B cadence)

- `SELECT result, count(*) FROM sanctions_screen_log WHERE created_at > now() - interval '30 days' GROUP BY 1;`
- Investigate any `blocked` or `retro_sweep` rows (incident playbook).
- Confirm the cron ran (meta row `refreshed_at` within 8 days) and the
  `error_fail_open` count is near zero (spikes = infra problem to fix).
