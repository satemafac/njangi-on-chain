# PRD — Circle Record v1

**Priority:** P1. The cheapest differentiating feature we have, and hook #3 in
`docs/product-strategy-beta-2026-08.md`.
**Owner:** unassigned
**Status:** **v1 SHIPPED, 2026-08-20 — with zero Move changes.** See §3.0, which supersedes the
original §2 timing constraint and §3.1 Move plan.
**Estimate (actual):** frontend/API only; no contract work, no publish dependency.

---

## 3.0 As shipped — and why the original Move plan was dropped

The Move additions specced in §3.1 turned out to be **infeasible without breaking upgrade
compatibility**, and it turned out they were not needed. Three findings, all verified against the
contracts:

1. **`open_cycle` takes `circle: &Circle` — an immutable reference**
   (`njangi_cycle_escrow.move:245`). It cannot write a dynamic field onto the Circle, and Sui
   forbids changing an existing public function's signature in an upgrade. The escrow-history
   index as specced cannot be built.
2. **`contribute` receives no `&Clock`** (`njangi_cycle_escrow.move`), so a contribution timestamp
   cannot be written from its body either — it would require a new function, not a body change.
3. **The member aggregates that look like a fallback are dead.** `Member.total_contributed` is
   written only by `njangi_payments` (the legacy rail, gated off) and
   `njangi_circles::contribute_stablecoin`; the live escrow rail never calls into `members::` at
   all, so it reads 0 for escrow circles. `Member.missed_payments`, `reputation_score` and
   `consecutive_on_time_payments` are **never assigned anywhere in the contracts** and are
   structurally always 0. None of them may be surfaced.

**What replaced it.** `finalize` asserts
`contributors_count >= required_contributors` (`njangi_cycle_escrow.move:918`), so **a round
cannot complete unless it was fully funded.** `Circle.rotation_history` is append-only and never
reset (`njangi_circles.move:2927`). Therefore its length is the count of completed, fully-funded
rounds, and a member's position in it is proof they received a payout.

That single invariant turns the whole feature into pure object reads — owned membership receipts,
the Circle object, and the members table — with no escrow enumeration, no event scans, and no
contract change.

**Two consequences worth carrying forward:**

- **The §2 timing constraint no longer applies.** Nothing has to ship before the pilot, because
  nothing needs indexing from a given block forward. The record reads history that is already
  durable. This also removes Circle Record from the Wave 0 publish critical path in
  `docs/build-roadmap-2026-08.md`.
- **Per-member, per-cycle on-time status remains unavailable** and is not claimed anywhere in the
  UI. Delivering it needs a new `contribute`-style entry function taking a `&Clock` plus a
  per-member timestamp dynamic field on the escrow — a genuine v1.1, specced but not built.

**Status since (2026-09-06).** v1.1 was later built as *new* entry functions — `open_cycle*_indexed`
(`&mut Circle`, appends `FIELD_ESCROW_HISTORY`) and `contribute_timed*` — which is the route §3.0
said an upgrade permits; see `docs/build-roadmap-2026-08.md`. v1.2 adds the **duplicate-open guard**
on top of the same history: production 2026-08-30 minted two escrows for one round 34 seconds apart
(`docs/incident-playbook.md` Scenario 5). Every indexed open now also writes a `FIELD_OPEN_ROUND`
marker `(cycle_no, recipient, escrow_id)` on the Circle; `open_cycle_internal` aborts
`E_ROUND_ALREADY_OPEN` (234) while the marker names the round being opened;
`advance_circle_after_claim` clears it once the payout has rotated the circle; and the new
permissionless `release_open_round` clears it for an escrow that can no longer pay out (refunded, or
empty past its cancel window — `is_abandoned`), aborting `E_ROUND_STILL_OPEN` (235) otherwise. The
client chains the release ahead of a re-open behind `NEXT_PUBLIC_ESCROW_ROUND_GUARD_ENABLED`, and
the escrow panel holds one in-flight lock across every open control until discovery confirms the
new escrow (`src/lib/cycle-open-round-lock.ts`). Discovery's tie-break is documented in
`src/lib/cycle-escrow-discovery.ts`: the newest `escrow_history` entry wins, never an older
unfinalized one.

---

## 1. The problem

Millions of people have decades of flawless njangi payment history and nothing to show for it. A
person can be trusted with a community's money for twenty years and remain unbankable, because the
record lives in a notebook nobody else will accept.

We already produce that record as a side effect of running circles, and **nothing in the product
surfaces it**. There is no history view, no export, no reputation surface anywhere in `src/` or
`move/sources/` — the only hits are marketing copy and an unimplemented `analytics` entitlement
whose i18n string (`src/lib/i18n.ts:377`) already promises "contribution history, on-time rates,
and payout trends" we do not deliver.

## 2. Goals / non-goals

**Goals**

1. A member can see their own verified participation history across **all** their circles.
2. They can export it and share it on their own terms, with an expiring link.
3. Anyone receiving it can verify it independently against the public ledger without trusting us.
4. It gives long-term participation a payoff beyond the payout — the "why stay" answer the product
   currently lacks — and makes reputation portable *between circles*, which is a direct retention
   and referral mechanism.

**Non-goals — these are the compliance boundary, not scope trimming**

- **No score, rating, tier, or grade.** Facts only.
- **We never furnish it to anyone.** The member is the sole distributor. Assembling consumer
  information and furnishing it to third parties for credit, employment or housing decisions is
  what makes an entity a consumer reporting agency under FCRA; not scoring and not furnishing is
  what keeps us out. See `docs/product-strategy-beta-2026-08.md` §F8.
- No lender, cooperative or underwriting integration. That is a counsel gate, not a BD decision.
- No organizer-side view of another member's record in v1 (a consented version is a later
  Premium candidate).

**~~Timing constraint~~ — WITHDRAWN.** This section originally argued that the Move addition had to
ship before the pilot, because an index cannot backfill. That reasoning was sound but the premise
is gone: the shipped design (§3.0) reads history that is already durable, so there is nothing to
index and no publish deadline. Retained here only so the reversal is legible.

## 3. Design

### 3.1 Move additions — SUPERSEDED by §3.0, not built

*Retained for the v1.1 on-time work, which does need a new entry function. The index half of this
section is infeasible as written — see §3.0.*

Sui Move upgrades **cannot change existing struct layouts**, so neither `Circle` nor `CycleEscrow`
may gain a field. Both additions therefore use **dynamic fields**, which is already the
established pattern on `Circle` (`FIELD_CYCLE_CONTRIBUTORS` etc., `njangi_circles.move:92-113`).
Function bodies *can* change in an upgrade, so writing the new fields from existing entry points
is fine.

**(a) Escrow history index — turns the whole feature into pure object reads.**

There is currently **no on-chain link from a Circle to its past `CycleEscrow` object ids**. The
escrow points forward (`circle_id: ID`, `njangi_cycle_escrow.move:103`) but nothing points back.
The only way to find escrows today is `findCurrentCycleEscrow`
(`src/lib/cycle-escrow-discovery.ts:107-150`), a `queryEvents` scan capped at `limit: 50` with
client-side filtering — exactly the pattern this project's read policy forbids
(`src/lib/sui-read.ts:18-19`), and unreliable on current RPC endpoints where `queryEvents` is
provider-dependent and rate-limited.

Add `FIELD_ESCROW_HISTORY`: a `vector<ID>` dynamic field on the Circle's UID, appended when a
cycle escrow is opened (`open_cycle*`). One small write per cycle, and escrow enumeration becomes
a pure object read that works on every endpoint.

**(b) Per-member contribution timestamps — the only way to say "on time" honestly.**

`CycleEscrow.contributed` is `Table<address, bool>` (`:105`) — it records *that* a member
contributed, never *when*. `Member.last_contribution` holds only the most recent and is zeroed
every rotation (`njangi_members.move:288-291`). So per-member on-time status does not exist
on-chain today at any granularity finer than "the cycle finalized before its `due_at_ms`."

Add a dynamic field on the **escrow's** UID mapping `address → u64` (contribution timestamp),
written inside `contribute` alongside the existing `contributed` write at `:476`. The snapshot
already carries `due_at_ms` and `opened_at_ms` (`:97-98`), so on-time becomes a simple comparison.

> **Do not build on `Member.reputation_score` or `consecutive_on_time_payments`.**
> `update_member_reputation` has no call sites outside the members module, so those values are
> effectively always zero in production. Verify before relying on them anywhere.

### 3.2 What v1 reports

Per circle, per cycle, strictly from durable object reads:

| Field | Source |
|---|---|
| Cycle number, contribution amount, due date | `CycleSnapshot` (`njangi_cycle_escrow.move:90-99`) |
| Did this member contribute | `contributed` table via `getDynamicFieldObject` |
| Was it on time | new timestamp field vs `snapshot.due_at_ms` (cycles after the upgrade only) |
| Did the cycle complete | `finalized`, `claimed` flags (`:106-133`) |
| Did this member receive the payout | `snapshot.recipient` == member, plus `claimed` |
| Circles joined and when | soulbound `CircleMembership {circle_id, member, joined_at}` (`njangi_circles.move:305-310`) |
| Lifetime payouts received | `Circle.rotation_history: vector<address>` (`:131`) — append-only, never reset |

**Two correctness traps that must be handled explicitly:**

1. **Refunds erase contribution entries.** `refund` removes from `contributed` and decrements
   `contributors_count` (`njangi_cycle_escrow.move:826-827`). A refunded cycle must be read via the
   `refunded` flag and reported as **"cycle cancelled — contributions returned"**, never as "member
   did not pay." Getting this wrong would falsely damage someone's record, which is the worst
   possible bug in this feature.
2. **Several `Member` aggregates reset per rotation** — `last_contribution`
   (`njangi_members.move:288`), `received_payout` (`njangi_circles.move:2833`). Use them for
   *current-round* status only; never as lifetime history.

### 3.3 Reads — reuse, do not invent

- **Multi-circle discovery is already solved.** `discoverMemberCircleIds(address)`
  (`src/lib/membership-discovery.ts:42-92`) uses `getOwnedObjects` filtered by the soulbound
  `CircleMembership` struct type — server-side filtered, cursor-paginated, `cachedRead`-wrapped,
  and anchored to `originalId` so it survives package upgrades. Pure object read; works on every
  endpoint. Use as-is.
- **Table-entry reads:** copy `readContributorAmount`
  (`src/lib/goal-pool-discovery.ts:227-248`) — reads the table's inner UID then
  `getDynamicFieldObject({parentId, name:{type:'address', value}})`. Handle `dynamicFieldNotFound`
  the way `isCircleMember` does (`src/lib/milestone-discovery.ts:762-788`).
- **All RPC through `getPooledSuiClient`** from `@/services/sui-rpc-failover`; wrap in
  `cachedRead` from `src/lib/sui-read.ts:68` and batch via `readObjects` (`:222`, chunks of 50).
- **Verify every discovered id before it reaches a tx builder** — the project's discovery doctrine
  (`src/lib/custody-wallet-discovery.ts:20-32`). Circle Record is read-only so the risk is lower,
  but the same validation applies to ids rendered as verification links.

**Event scans are a tier-2 fallback only**, for cycles that predate the upgrade, clearly labeled
in the UI as unverified-legacy rather than silently merged. Do not make the feature depend on them.

### 3.4 Surfaces

1. **`/record`** — the member's own statement. Summary (circles joined, cycles completed,
   contributions made, on-time count where known, payouts received), then a per-circle breakdown.
   Plain language, no score anywhere.
2. **Export** — a print-friendly page and a JSON download containing the object ids used, so it is
   checkable.
3. **Share link** — `/record/s/<token>`, **expiring by default** (30 days, member-selectable
   shorter), revocable from `/record`. A share link is a permanent disclosure if it never expires;
   default-expiry is the privacy design.
4. **Verification** — the shared view lists the circle and escrow object ids with explorer links,
   so a recipient verifies against chain rather than trusting our rendering. State plainly: *this
   is a record of on-chain activity, it is not a credit report and not a score.*

Share tokens are opaque, random, stored server-side with expiry, and resolve to the address only —
they must never embed the address, `sub`, or any personal identifier.

### 3.5 Entitlement

Free for the member. Charging someone for their own history is indefensible and undermines the
"your money is never behind a paywall" pricing promise. The `analytics` Premium entitlement stays
reserved for the *organizer-side* aggregate view later.

## 4. Acceptance criteria

1. A member in three circles sees all three, discovered via owned `CircleMembership` objects with
   no event scan in the request path.
2. Cycles the member contributed to show as contributed; cycles they missed show as missed.
3. **A refunded cycle reports "cancelled — contributions returned", not "did not pay."** Explicit
   test.
4. On-time status appears only for cycles with timestamp data; older cycles show contribution
   status without an on-time claim rather than guessing.
5. Payouts received match `rotation_history`.
6. Export produces object ids that resolve on a public explorer to the stated facts.
7. A share link works for a non-authenticated visitor, expires at its expiry, and 404s after
   revocation.
8. No score, rating, tier or numeric grade appears anywhere in UI, export or JSON.
9. Statement renders correctly for a member with zero completed cycles (new joiner) and for one
   with a missed contribution.
10. `npm run check:copy` clean; strings in EN + FR.

## 5. Files to touch

| File | Change |
|---|---|
| `move/sources/njangi_circles.move` | `FIELD_ESCROW_HISTORY` constant + append helper |
| `move/sources/njangi_cycle_escrow.move` | Append escrow id to circle history on `open_cycle*`; write contribution timestamp dynamic field in `contribute` (`:476`) |
| `move/sources/*` tests | Cover history append, timestamp write, refund-then-read |
| `src/lib/circle-record.ts` | **New.** Aggregate reads, per-cycle normalization, refund handling |
| `src/lib/cycle-escrow-discovery.ts` | Add object-read escrow enumeration from the new index; keep the event scan as labeled fallback |
| `src/lib/sui-read.ts` | Add a paginated `getDynamicFields` helper (none exists) |
| `src/pages/record/index.tsx` | **New.** Member statement |
| `src/pages/record/s/[token].tsx` | **New.** Shared view |
| `src/pages/api/record/share.ts` | **New.** Create / revoke share tokens |
| `scripts/migrate-postgres.mjs` | `record_share_tokens` table (token, address, created_at, expires_at, revoked_at) |
| `src/lib/i18n.ts` | Strings, EN + FR |

## 6. Risks

- **Falsely reporting someone as delinquent** is the highest-severity bug here — it is a
  reputational statement about a real person. The refund path (§3.2) is the known trap; treat any
  ambiguous state as "no claim" rather than a negative claim.
- **Scope creep toward scoring.** Users and partners *will* ask for a number. The refusal is a
  product requirement, written into this spec deliberately so it is not quietly traded away later.
- **Share links are permanent disclosures.** Default expiry plus revocation is the mitigation;
  do not ship an unexpiring link "for convenience."
- **Pre-upgrade cycles have no timestamps and no index.** Label them honestly; never infer.
- **Read cost.** A member in many circles with many cycles fans out into many object reads. Batch
  through `readObjects`, cache, and paginate the UI by circle.
