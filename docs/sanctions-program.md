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

| Surface | Mechanism | Layer |
|---------|-----------|-------|
| Circle create | `screenAddress(addr,'circle_create')` in `api/zkLogin.ts` before the entitlement gate | Server (authoritative) |
| Circle join | `screenAddress(addr,'circle_join')` in `api/join-requests/create.ts` before any DB write | Server (authoritative) |
| WhatsApp link | `screenAddress(addr,'whatsapp_link')` in `api/whatsapp/admin-link-circle.ts` before the Walrus upload | Server (authoritative) |
| Goal-pool create / escrow open | `preflightSanctionsCheck()` → `GET /api/sanctions/check` | Client preflight (UX only — these flows sign client-side straight to RPC; documented limitation of a non-custodial architecture) |
| App routes (pages) | `src/middleware.ts` geo-block → `/restricted` | Edge |
| API choke points | `isEmbargoedHeaders()` → 403 `EMBARGOED_REGION` | Server |

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
- **Bootstrap after each fresh deploy/migration:**
  `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/sanctions-refresh`
  then confirm the response reports a plausible `addressCount` (~400-500).

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
