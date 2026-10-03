# Incident Playbook (internal)

_Last updated: 2026-07-05. Owner: founder. Companions:
[sanctions-program.md](sanctions-program.md),
[compliance-roadmap-cex-dex-non-kyc.md](compliance-roadmap-cex-dex-non-kyc.md)._

Three scenarios, one discipline: **acknowledge, don't improvise, call
counsel, use the levers, document everything.** The single most important
fact to state early and accurately in any of these:

> **We cannot freeze, seize, move, or recover user funds. The protocol is
> non-custodial by design.** Our levers are service-level, not fund-level.

## Lever inventory

1. **Refuse/terminate service** — ToS right; enforce by refusing API
   actions for an address, and (if needed) blocking at middleware.
2. **Compliance gate** — `open_cycle_*_with_gate` can require KYC
   attestations per circle/corridor (tested end-to-end 2026-07-04).
3. **Geo-block** — extend `EMBARGOED_COUNTRIES` in `src/lib/embargo.ts`
   (ships in minutes).
4. **WhatsApp/notification suspension** — separable from on-chain access.
5. **Public pages stay up; app routes can be gated** — middleware.

## Scenario 1 — Sanctions screen hit (blocked or retro-sweep row)

1. Confirm it's real: check `sanctions_screen_log` for the row; verify the
   address against the current `sanctioned_addresses` row (`list_version`).
2. Do NOT contact the user beyond the automatic neutral refusal. Do not
   say "sanctions". Do not tweet.
3. Preserve evidence: note the log row ids, list version, timestamps in a
   dated internal memo (append to this file's log section below).
4. **Retro-sweep hit** (address passed earlier, listed now): additionally
   check what the address did in the window (join requests, circle
   membership on-chain) and record it.
5. Call counsel the same week. Counsel decides whether a voluntary
   self-disclosure to OFAC is warranted — that is not our call to make
   alone.
6. Keep refusing service (the screen already does).

## Scenario 2 — Regulator / law-enforcement contact

1. Acknowledge receipt in writing, briefly and politely; commit to a
   response date. Nothing substantive in the first reply.
2. Call counsel before any substantive response. Forward the request
   verbatim.
3. Facts to have ready (all true by design): non-custodial, no fiat, no
   fund-flow fees, no yield; data inventory =
   [records-of-processing.md](records-of-processing.md); sanctions program
   = [sanctions-program.md](sanctions-program.md); we can refuse service
   but cannot touch funds.
4. Preserve everything from the moment of contact (no log pruning, no
   schema cleanup that drops rows).
5. Document each interaction in the log section below.

## Scenario 3 — Complaint / takedown about a specific circle

(Fraud allegation, family dispute, scam report, court order about a member.)

1. Triage: is it (a) a member dispute inside a circle, (b) an alleged
   scam circle, (c) a legal demand? For (a): the protocol's answer is the
   member-initiated recovery vote — point them to it; we don't adjudicate.
2. For (b)/(c): capture evidence (circle id, addresses, screenshots),
   check on-chain state, and apply proportionate levers: suspend WhatsApp
   suite for the circle, refuse further API service to the offending
   address(es). We cannot take the funds down — say so plainly and point
   to the recovery mechanism members can trigger themselves.
3. Legal demand → counsel before compliance or refusal.
4. Document in the log.

## Scenario 4 — Address drift (users signing in to a different account)

Signal: `[address-drift] DRIFT DETECTED` in logs, a Sentry event tagged
`feature: address-drift`, or a user reporting that their circles and money
"disappeared" after signing in normally.

**What it means.** A zkLogin address derives from `(iss, aud, sub, salt)`.
If any of those changes, the same social login resolves to a DIFFERENT Sui
address and the user's funds stay at the old one, unreachable. See
`CLAUDE.md` → "Address-affecting environment variables".

1. **Establish blast radius first.** One user is odd; several in an hour is
   a configuration incident that will hit everyone who signs in next. Query:
   `SELECT COUNT(*) FROM (SELECT sub FROM zklogin_address_bindings
   GROUP BY sub, COALESCE(iss, provider)
   HAVING COUNT(DISTINCT user_address) > 1) t;`
   (`countRecentDriftEvents()` in `src/lib/zklogin-address-bindings.ts`
   answers the same question windowed to the last hour.)
2. **Ask the only question that matters: what changed?** In order of
   likelihood — `NEXT_PUBLIC_{GOOGLE,FACEBOOK,APPLE}_CLIENT_ID`, or the
   Enoki APPLICATION being deleted/recreated (which resets salts). Note:
   rotating an Enoki API key within the same app does NOT move salts
   (CLAUDE.md, corrected 2026-08-02) — before suspecting salt drift at
   all, check whether the "same user" is actually a different PROVIDER
   identity (sub/aud formats identify it). Check the deploy/env change
   history around the first drift timestamp (`MIN(first_seen_at)` on the
   new bindings).
3. **If a change is identified, REVERT IT.** Restoring the previous salt
   source restores the original addresses for everyone who has not yet been
   onboarded under the new one. This is the only real fix and it gets
   harder every hour, because each new user onboarded under the new
   configuration is someone the revert will then strand. **Speed matters
   more than diagnosis here** — revert first, understand afterwards.
4. **Do not tell users their funds are "safe" or "recoverable" as a matter
   of course.** The funds are intact at the old address, but we hold no key
   for it and cannot move them. The modal already says this accurately;
   support must not improve on it.
5. Affected users can still claim payouts, request refunds and take part in
   recovery votes at their *current* address — the gate is deliberately
   fail-open on fund access. Joining, creating and contributing are blocked
   until resolved.
6. For a circle whose members are split across old and new addresses, the
   protocol's answer is the member-initiated recovery vote, same as
   Scenario 3(a): members can stop the circle and take back what they put
   in. Point them to it; we cannot do it for them.
7. Record in the log below: first drift timestamp, count of affected
   identities, the suspected change, whether it was reverted, and the
   addresses involved.

**Prevention.** Key rotation is a plain credential refresh and is safe.
The address-affecting changes are client ids, provider entries, and the
Enoki application itself — treat THOSE as address migrations: never change
them once users exist, and record any change in the deploy log so step 2
has something to find.

## Scenario 5 — Two escrows for one round (duplicate open)

Signal: a member reports paying in but the round's pot still shows them as
pending; or the circle's `escrow_history` has two entries whose snapshots
carry the same `cycle_no` AND the same `recipient`, the older one open,
empty or part-funded, never finalized. First seen 2026-08-30 on circle
`0xa3fada…675ed`: two `open_cycle_stable_indexed` transactions 34 seconds
apart (`7WSGJFyerF…`, `8hpKgUeYg1…`), members paid into the second, the
first is a permanent orphan.

**What it means.** Until the package carrying the v1.2 duplicate-open guard
(`E_ROUND_ALREADY_OPEN`, 234) is published, the chain accepts a second
escrow for a round it already has one for, and the escrow panel used to
offer the second open the moment the first resolved. A page that read
history before the second open landed pays into the FIRST escrow; split
across two pots, neither can fill, and the contributions sit until a refund
path runs. Nobody can move those funds anywhere but back to the members who
paid them.

1. **Name the live escrow.** It is the LAST entry of the circle's
   `escrow_history` — discovery resolves newest-first by design, so every
   page that reloads converges on it. Do not "prefer the unfinalized one";
   that resurrects the orphan.
2. **Get the members onto it.** Anyone who paid into the older escrow pays
   again into the live one (their share is not lost — see step 3). The
   recipient collects from the live one as normal.
3. **Drain the orphan.** If it holds contributions: once its snapshot due
   date plus the 7-day grace has passed, anyone can call
   `cancel_unfinalized_escrow` and every recorded contributor gets exactly
   their contribution back. If it is empty there is nothing to do — it
   stays in `escrow_history` as an inert entry.
4. **After the guard is published**, a refunded (or empty, past-window)
   escrow still pins its round on chain: re-opening that round needs
   `release_open_round` chained ahead of the open. The panel does this
   when `NEXT_PUBLIC_ESCROW_ROUND_GUARD_ENABLED` is on; a re-open that
   aborts 234 on a refunded round means the flag was not flipped after the
   publish. A 235 means the release named an escrow that can still pay
   out — check whether it was actually refunded before assuming a bug.
5. Record in the log below: circle, both escrow ids, which one the members
   converged on, and whether the orphan held funds.

**Prevention.** Both layers are in the repo: the panel holds one in-flight
lock across every open control until discovery confirms the new escrow
(`src/lib/cycle-open-round-lock.ts`), and the Move guard refuses the second
open outright once published. Watching a round in an E2E run: poll the last
`escrow_history` entry, not an escrow id captured earlier.

## Contact chain

- Counsel: {{COUNSEL_CONTACT}} (fill when the A6 engagement closes)
- Operator: founder (this repo's owner)
- Infra: Vercel support (hosting), Neon support (DB) — for evidence
  preservation requests.

## Incident log

_Append dated entries here. None yet._

## Reads that lie — the recurring bug family

Found six times in production on 2026-08-23/24, then twice more by audit.
Every instance renders as a confident falsehood about a person or their
money, and unit tests never catch any of it because tests mock the reads.

**The four shapes:**

1. **Swallowed error as absence.** `catch { return null | [] | false }`
   around an RPC read, where the caller cannot tell "failed" from
   "genuinely absent". Presents as: "you are not a member", "nobody has
   paid", "you have no circles", "deposit not paid".
2. **Wrong package id.** Move types anchor to the package version that
   DEFINED them. Types from the original publish need `originalId`; types
   added in an upgrade need that version's id (e.g.
   `timedEntriesPackageId`). Using published-at matches **zero** objects
   or events forever, with no error.
3. **Pinned / rationed client.** Reads that bypass `withSuiRpcFailover`,
   or whose failure lands in a swallow. Some endpoints serve object reads
   but refuse event history, and the rationed one is tried last.
4. **Silent field drop.** An accessor that rebuilds its return value from
   hand-listed fields, so a newly added field never reaches callers.

**The rules:**

- Distinguish absence from failure. `dynamicFieldNotFound` / `notExists`
  is an answer; anything else is an unknown. Use `boolean | null`,
  `string | null`, or an explicit `status: 'ok' | 'unavailable'`.
- **Never move money or run a destructive operation on a guessed read.**
  Refuse with a 503 and say nothing was done. Three shipped bugs did the
  opposite: routing a contribution as a second deposit, submitting a
  hardcoded contribution amount, and skipping the wallet check before
  deleting a circle.
- Never publish an invented figure. A "reasonable fallback for demo" on a
  public page is a fabricated statistic.
- Spread-first in accessors so a new field cannot be dropped.

**Reference implementations:** `src/lib/circle-record.ts` (absent `[]` vs
unknown `null`, via failover), `src/lib/circle-chain.ts`
(`resolveCircleLifecycleState`, spread-first accessor),
`src/pages/api/cron/cycle-finalized.ts` (refuses loudly on a package-id
mismatch), `src/components/CycleEscrowPanel.tsx` (`loadError` distinct
from "not open yet").
