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

## Contact chain

- Counsel: {{COUNSEL_CONTACT}} (fill when the A6 engagement closes)
- Operator: founder (this repo's owner)
- Infra: Vercel support (hosting), Neon support (DB) — for evidence
  preservation requests.

## Incident log

_Append dated entries here. None yet._
