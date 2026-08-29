# Build roadmap — first wave

**Date:** 2026-08-20
**Scope:** The next ~3 weeks of engineering, ending with a testnet pilot that can start safely.
**Companion docs:** `docs/product-strategy-beta-2026-08.md` (why), `docs/prd/` (what),
`docs/pilot-readiness.md` + `docs/softlaunch-gameplan.md` (launch mechanics, unchanged).

---

## 0. Where we actually are

The repo has compliance roadmaps, launch runbooks and ops guides, but **no feature-level PRDs and
no build roadmap**. This document and `docs/prd/` fill that gap. Nothing here changes the launch
sequencing already agreed in `pilot-readiness.md`; it slots the engineering work into it.

Two corrections to earlier assumptions, both established by reading the tree rather than the docs:

- **Mid-rotation migration is essentially built, not "planned."** `declare_migration_state`,
  `acknowledge_migration_state` and `clear_migration_state` exist in `njangi_circles.move`, with tx
  builders (`src/lib/zklogin-tx-builders.ts:648-729`), a parsing library
  (`src/lib/circle-migration.ts`, 242 lines), unit tests, and `CircleMigrationPanel` already wired
  into `src/pages/circle/[id]/manage/index.tsx:7326`. The full Move suite passes **169/169**. It is
  ~1,144 uncommitted lines across two Move files, so what it needs is a **publish**, not a build.
- **Circle Record is cheaper than expected, but has a deadline.** Almost everything it needs is
  durably readable via object reads. The exception is that nothing on-chain links a Circle to its
  past escrow objects, and contributions store no timestamp — both fixable with small,
  upgrade-compatible dynamic-field additions. Those additions **only index cycles created after
  they publish**, which is what forces the sequencing below.

## 1. Sequencing — updated 2026-08-20

> **~~Hold the publish to add Circle Record Move additions.~~ WITHDRAWN — the additions proved
> both infeasible and unnecessary.**

The original argument was that an escrow-history index cannot backfill, so it had to ship before
the pilot generated real history. Building the feature disproved the premise on both halves:

- **Infeasible:** `open_cycle` takes `circle: &Circle` (immutable), and Sui forbids changing an
  existing public function's signature in an upgrade, so the index cannot be added at all.
- **Unnecessary:** `finalize` requires full funding, and `rotation_history` is append-only and
  never reset — so completed rounds are already durable proof of participation. Circle Record v1
  ships on pure object reads with **no contract change and no publish dependency**.

Net effect: **Waves 1 and 2 are both independent of Wave 0.** The publish now carries only the
mid-rotation migration work, and can happen whenever it suits.

```
t=0  ─┬─ Counsel addendum sent ────────────────────────────────────► (weeks, external)
      │
      ├─ Wave 0: publish migration work → verify on testnet (2–3d)   [independent]
      │
      ├─ Wave 1: Address-drift guard (2–3d)                          [SHIPPED]
      │              └─► gates pilot start
      │
      └─ Wave 2: Circle Record v1 (frontend/API only)                [SHIPPED]
```

## 2. Wave 0 — ship what is already built

**Goal:** one testnet publish carrying the migration feature and the Circle Record contract
additions.

| # | Task | Notes |
|---|---|---|
| ~~0.1~~ | ~~`FIELD_ESCROW_HISTORY` index~~ | **Dropped.** Infeasible: `open_cycle` takes an immutable `&Circle` and signatures cannot change in an upgrade. Not needed either — see §1. |
| ~~0.2~~ | ~~Contribution timestamp field~~ | **Deferred to Circle Record v1.1.** `contribute` receives no `&Clock`, so this needs a new entry function, not a body change. Only blocks per-member on-time status, which v1 does not claim. |
| 0.4 | Commit the migration work | 1,144 uncommitted lines across two Move files. |
| 0.5 | `npm run validate:move-network` → `npm run preflight` → `bash move/build_and_test.sh` | Per the publish runbook in `CLAUDE.md`. Answer `y` to the post-publish bootstrap. |
| 0.6 | `npm run validate:env` | Confirm every active-network id populated after publish. |
| 0.7 | Verify mid-rotation migration end-to-end on testnet | Declare a ledger, have members ack, confirm `activate_circle` resumes at the right position. This is the first real exercise of that code. |

**Done when:** a circle can be migrated mid-rotation on testnet, and a new cycle's escrow id
appears in the circle's escrow-history field.

## 3. Wave 1 — address-drift guard (P0)

**PRD:** `docs/prd/prd-address-drift-guard.md`
**Runs in parallel with Wave 0.** No contract dependency.

The one item here that is genuinely urgent rather than merely important. A returning user can
silently resolve to a different Sui address, stranding their funds, and today the code *deletes the
evidence* before it could be compared (`src/pages/api/zkLogin.ts:1173` wipes prior sessions on
every login). CLAUDE.md documents this happening on testnet already.

Two design points that must survive review:

- **Detect on `(iss, sub)`, not `(sub, aud)`.** A client-id change is itself a drift cause; keying
  on `aud` would make that case look like a brand-new user and miss it entirely.
- **Fail-closed on new commitments, fail-open on fund access**, reusing the split
  `src/lib/sanctions.ts` already establishes. Never stand between a user and their money.

**Done when:** a simulated salt change and a simulated client-id change both produce a blocking
interstitial and an operator alert, while claim/refund/recovery routes stay reachable.

**Gate:** this ships before the pilot cohort is invited. Pilot users are real people even on
testnet, and the same code path runs on mainnet.

## 4. Wave 2 — Circle Record v1 — **SHIPPED**

**PRD:** `docs/prd/prd-circle-record.md` (see §3.0 for the design that actually shipped)
**No dependency on Wave 0.** Frontend and API only.

Aggregates across circles via the existing `discoverMemberCircleIds`, reads the Circle object and
the members table, and derives participation from `rotation_history` — which is proof of full
funding, since a round cannot finalize otherwise. Renders a statement with print, JSON export, and
expiring, revocable share links.

**Deliberately not claimed:** per-member, per-cycle on-time status. That needs the v1.1 entry
function above. The UI reports "turn not yet reached" rather than ever asserting a missed payment.

## 5. Counsel track — OWNER DECISION 2026-08-22: last before go-live

`docs/counsel-addendum-asset-conversion.md` is written and send-ready. This document originally
recommended sending it immediately; **the owner has decided counsel review is the final step
before go-live instead.** Consequences of that sequencing, so nobody trips on them later:

- The mainnet gate in `docs/compliance-roadmap-cex-dex-non-kyc.md` is unchanged: **no real
  family money before the opinion letter lands.** Counsel-last therefore means counsel sits
  directly on the go-live critical path — everything else must be finished and waiting on it,
  not the other way around.
- The Phase C tripwire still holds in the meantime: no design work on asset conversion (rungs
  2–3), auction framing, or the account-recovery build until the answers come back. Those tracks
  are paused-by-sequencing, not forgotten — each has a review-ready document
  (`counsel-addendum-asset-conversion.md`, `prd-account-recovery.md` §6.2).
- The counsel package to send, when the time comes: `docs/counsel-brief.md` + the asset-conversion
  addendum + the account-recovery question + the bidding-circles framing question.

## 6. Deliberately not in this wave

| Item | Why not |
|---|---|
| Asset conversion (any variant) | Blocked on counsel. Designing it first is exactly the failure mode the tripwire exists to prevent. |
| Bid-for-your-turn auctions | Contract functions exist with no UI, but the framing risk (lending characterization) needs counsel review, and it must not ship in the same release as the flagship. |
| Live Stripe billing | Stays off while the cohort is invited and small. Not a publish blocker. |
| Integrated off-ramp | Real gap, but it is a partner-selection problem before it is an engineering one. First post-beta priority. |
| Member-controlled account recovery | Larger design; the drift guard addresses the urgent half of the problem. |
| Organizer-side view of a member's record | Needs consent design; v1 is member-only. |

## 7. Risks to the wave itself

- **The publish is the riskiest step**, because it is the first time the migration code runs
  outside tests. Verify on testnet before anyone is invited, and keep the previous package id
  recorded.
- **Wave 2 read cost** could disappoint on a member with many circles; batch and cache from the
  start rather than optimizing later.
- **Drift-guard copy** is the part most likely to need rework — it reports a frightening problem to
  a non-technical audience in two languages. Budget a review pass, not just a translation.
- **Counsel latency is unbounded from our side.** Nothing in Waves 0–2 depends on it, which is
  deliberate; keep it that way.


## 8. Gap closure — 2026-08-22

Every gap from the 2026-08-20 status review, with its outcome:

| Gap | Outcome |
|---|---|
| Work uncommitted | **Closed.** Committed as six semantic commits on `feat/smart-goal-pools`. |
| Migration never run | **Closed.** `npm run migrate:postgres` ran against the production database: all 25 statements applied, backfill seeded 4 identities (0 drifted — clean baseline), sanctions list intact (419 addresses, v2026-07-13). |
| Drift guard covered 2 of 4 commitment surfaces | **Closed.** Now gates circle create, join, all three ramp session routes (address-based lookup — those routes have no session identity) and WhatsApp linking. The sponsor broker is deliberately ungated: sponsorship failure falls back to self-paid gas by design, so a gate there blocks nothing. |
| Circle-create gate bypassable | **Documented, not closable server-side.** create_circle is a public Move entry point with client-side signing; the route now says so plainly (matching the billing gate's own caveat). Hard coverage = join queue + client interstitial. |
| /record unreachable | **Closed.** "Your record" entry in the dashboard wallet panel. |
| New copy outside i18n | **Closed** to the house standard: drift.* / record.* keys in EN + FR (strict parity enforced by test); the other five locales remain intentionally partial with EN fallback, per the documented policy. Dates follow the app locale. |
| Share page unverified e2e | **Closed.** Verified in the real browser against a production build, the production database and live testnet chain data: live link renders a real member's 3 circles (EN and FR); a payout landed on-chain mid-test and the record picked it up; revoked, expired and unknown tokens all render one identical "not available" page; signed-out /record shows the sign-in CTA. Local-prod note: the HTTPS-force middleware 301s plain-http localhost, so local prod testing needs an x-forwarded-proto: https shim in front of `next start`. |
| Per-cycle on-time status | **Code complete, publish-gated (2026-08-22).** v1.1 shipped in source: `open_cycle*_indexed` entries append each escrow's id to a `FIELD_ESCROW_HISTORY` dynamic field on the Circle (taking `&mut Circle` — new functions may, existing signatures may not), and `contribute_timed*` record per-member timestamps. 176/176 Move tests. Frontend reads the history + timestamps and renders "N of M recorded" on-time evidence — only when data exists; absence renders nothing. Client targets switch behind `NEXT_PUBLIC_ESCROW_TIMED_ENTRIES_ENABLED` (default OFF). **Goes live when the owner authorizes the v6 publish**: run the publish runbook, `sui client upgrade --dry-run` first per the upgrade-compatibility memory, then flip the flag. |
| Counsel letter unsent | **Owner-sequenced: LAST before go-live** (decision 2026-08-22, see §5). Package is assembled and waiting. |
| Account recovery unbuilt | **Design complete, build-gated on review** — `docs/prd/prd-account-recovery.md`: member-registered recovery beneficiary, 7-day registration cooldown + 14-day challenge window, redirects owed value only (never votes/membership), member cancel always wins. Counsel question folded into the pre-go-live package. |
