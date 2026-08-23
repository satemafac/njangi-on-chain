# PRD — Member-controlled account recovery ("recovery contact")

**Priority:** Post-mainnet-go-live (Q4 per roadmap). Counsel question rides in the pre-go-live
package; build starts only after counsel answers AND this design's v2 gates are met.
**Owner:** unassigned
**Status:** **v2 — adversarial review complete (2026-08-22).** Three independent reviews
(red-team, Move implementability, product/compliance) are folded in below; every open question
is resolved. Findings register at the end.
**Naming:** the concept is a **"recovery contact"** (*personne de confiance*), not a
"beneficiary" — "beneficiary" reads death-only, overpromises seat inheritance, and collides
with `GoalPool.beneficiary` in the contracts. "Beneficiary" survives only as a Move field name.

---

## 1. The problem

A zkLogin account *is* a social login: the Sui address derives from the OAuth identity, so a
member who permanently loses their Google/Facebook/Apple account permanently loses their
address. There is no seed phrase to restore. Today's honest answer is circle-level — the
emergency-stop vote returns contributions — but refunds pay the *address of record*, which for
a lost account means re-stranding the money one hop later, and future payouts mint claims that
expire uncollected.

The address-drift guard (shipped) makes account loss *visible*; nothing makes it *survivable*.
The two stay separate: configuration drift is fixed by reverting configuration (incident
playbook Scenario 4); genuine OAuth-account loss has no operator fix — which is why the remedy
must be member-configured, in advance, on-chain.

**Scope truth (from review):** the registry rescues *addresses*, not humans. It helps the
member who lost their OAuth account. It cannot help a drift victim reach a stranded old
address (the new address is an on-chain stranger to the old one), and — recorded as residual
risk — a drifted-but-alive victim **cannot cancel** a false claim against their old address
until the configuration is reverted. Best practice the UI should suggest: register your **own
other-provider address** as your recovery contact (Facebook-you rescuing Google-you — the
providers are separate identities by design), which keeps the contact self-custodial.

## 2. Design principles — invariants this must not bend

1. **We gain no power.** No operator, admin, or attestor role may move, redirect, or reassign
   funds. The shared registry carries **no admin capability of any kind** — not even a
   "janitor" function; a stale-record cleaner would be an operator directing funds.
2. **The healthy member always wins.** At every stage the original address cancels
   unilaterally with one signature — and cancellation is fail-**open** (never blocked by
   drift status, billing, or screening outages).
3. **Absence of setup is absence of the feature.** No defaults, no operator-seeded contacts.
4. **Loud by construction.** Every state change emits an event surfaced over WhatsApp — which
   survives OAuth loss, because a phone number is not a Google account. That channel
   outliving the account is load-bearing and belongs in the user-facing story.
5. **Value only, never identity.** An active redirect delivers what is *owed* — payouts,
   refunds, deposit returns. Votes, membership, contribution rights and admin roles die with
   the account. Nobody "becomes" anyone.

## 3. The mechanism (v2)

### 3.1 Registration (while healthy)

`register_recovery_contact(registry, contact_address, challenge_window_choice, clock)`:

- Shared `RecoveryRegistry` (one per package): `Table<address, ContactRecord>`. Keyed by
  **address** — the only key the chain can see; the off-chain (iss,sub) bindings table maps
  humans to address sets.
- **Co-signed acceptance is REQUIRED** (all three reviews converge): registration is pending
  until the named contact signs `accept_recovery_contact`. Kills typo'd-address fund loss,
  surprise-contact coercion, and naming an unwitting third party as a relay. The 7-day
  cooldown starts at **acceptance**; remind the member at day 7 if still unaccepted.
- **Challenge window is member-chosen at registration: 14 / 30 / 60 days, default 30**, floor
  14, UI framed "Away often? Choose more time." Member choice is upward-only in spirit: the
  attacker cannot shorten what the member chose. An opt-in **travel hold** extends a window
  mid-flight (one more signature the healthy member can always make).
- Changing or clearing the contact is the same call; latest registration wins and resets the
  cooldown.
- **Sanctions:** the contact address is screened at registration (new `ScreenContext:
  'recovery_registration'`, fail-closed — a new commitment), re-screened at claim initiation,
  and swept by the weekly retro-sweep like every screened surface. On-chain code cannot
  consult the SDN list; enforcement is the same layered posture as circle join — service-
  surface refusal at the choke points plus retro-sweep evidence — stated honestly.
- **Drift-guard composition (review-critical):** `register` and `initiate` join the
  fail-**closed** commitment list beside circle create/join. Only `cancel` and
  `accept` are fail-open. The "recovery" name must never land these on the exemption list —
  that exemption exists for fund *access*, and registration is a fund *destination* change.

### 3.2 Claim (after loss)

`initiate_recovery_claim(registry, lost_member, clock)` — valid only from the accepted
contact, only after the cooldown, one live claim per member:

- Opens the member's chosen challenge window; emits `RecoveryClaimInitiated`.
- During the window `cancel_recovery_claim` (the lost member's address, one signature) voids
  the claim **and the registration** — a contested claim proves the registration is
  compromised or stale. Cancel-void also kills repeat-claim griefing dead: re-arming requires
  a fresh co-signed registration plus cooldown.
- **Activation is an explicit transaction, not a time predicate** (red-team N1/N6 — the
  critical fix): after the window elapses, the contact signs `activate_recovery_claim`. A
  **48-hour settlement grace** follows activation in which a late cancel still wins. Only a
  settled, activated, un-cancelled claim makes `resolve_payable_address` return the contact.
  *An effective-but-unclaimed registration NEVER redirects anything* — this gets its own Move
  test, because getting it wrong silently deletes the entire challenge window.
- **Redirect expiry:** an activated redirect lapses after **90 days of non-use; each delivery
  refreshes the clock** (synthesis of both reviews: kills the patient attacker's silent
  permanent lien without cutting off a genuine rescue mid-rotation — and every delivery is
  itself a loud event).

### 3.3 What an active redirect delivers — corrected to match the contracts

The review verified every flow against source. The PRD's original "Claim minted to the
contact" was the wrong shape; the corrected inventory:

| Flow | Mechanism (verified feasible, additive-only) |
|---|---|
| Cycle payout | `redeem_as_beneficiary<T>(escrow, registry, clock)` drains the **shared escrow** directly (`finalized && !claimed && !refunded`, within the claim window, sender = resolved contact) and sets `claimed`. Covers BOTH future payouts and **already-minted Claims stranded at the lost address** — the Claim object itself is untouchable (owned objects need their owner's signature, forever), but the value never leaves the shared escrow until redemption, so the stranded Claim simply goes inert. |
| Escrow refunds | `*_with_registry` twins of `cancel_unfinalized_escrow`, `…_for_recovery`, `refund_expired_claim`, resolving each recorded contributor through the registry. |
| Emergency-stop refunds | `execute_recovery_v2` / `trigger_auto_release_v2` taking the registry; the private internal changes freely. |
| Security-deposit return | **Rescoped** (original row misdescribed the flow): deposits return (a) inside emergency-stop recovery — covered above — and (b) via `admin_remove_member_with_registry` for inactive circles. There is no "circle close" return path. |
| **Goal pools** (was a scope gap) | `release_with_registry` (a lost pool beneficiary otherwise means the whole pot pushed to a dead address); and `claim_refund_for` — pull-based, sender must be the resolved contact, **no race at all**: the safest redirect in the system. |
| Votes, membership, contributing, admin roles, migration acks | **Never.** |

**Honest limits the UI must carry:**
- **Best-effort on push paths:** the legacy refund entries remain callable forever (public
  signatures are frozen), and they are permissionless. A griefer or naive indexer calling the
  legacy path pushes the lost member's share to the lost address — stranded. First
  transaction wins; the frontend always builds the `_with_registry` variants, and that is the
  strongest guarantee possible without breaking upgrade rules.
- **The 30-day race:** a cycle claim expires 30 days after finalize, and `refund_expired_claim`
  is permissionless. A redirect that activates late (≥21 days from registration at minimum)
  can lose a specific payout to the refund path; the value then follows refund semantics.
- **Governance freeze:** a lost member can never sign `acknowledge_migration_state`
  (unanimity, real address), so a circle with a lost member cannot ratify a mid-rotation
  migration. The feature rescues value, not liveness.
- **Conservation (red-team N4):** emergency-stop accounting and per-cycle escrow live in
  different modules with no shared ledger. All redirect variants resolve through the **single**
  `resolve_payable_address`, every delivery emits a `RecoveryDelivery` event, and the test
  suite must include a conservation property: total redirected ≤ what the lost member would
  have received with no redirect, across every flow combination.
- **One hop, non-transitive** (red-team N5): resolve ignores the contact's own registration.

### 3.4 The death case (was silent; product review)

A dead member leaves a ghost seat: they stop contributing, the circle cannot fully fund, and
§3.3 refuses to transfer the seat. The humane wind-down already exists **by composition**:
the emergency-stop vote (any member can propose through the admin, members pass it) plus the
active redirect delivers the family their share and deposit through the contact. When a claim
goes active, the organizer's UI must say exactly that: "the circle can vote to close this
round and everyone — including [name]'s family — receives their share."

### 3.5 Setup moment (product review)

Settings-page burial yields single-digit adoption. The prompt lands at **first payout claim**
— the moment the member has just watched money arrive and viscerally understands what losing
the account would mean — plus an **organizer nudge** ("3 of 12 members have a trusted
contact"). The drift modal keeps its pointer (the fire, not the drill). Target: ≥40% of
active members registered within two rotations.

## 4. Threat model (v2 verdicts from red-team)

| Attack | Defense | Review verdict → v2 disposition |
|---|---|---|
| Session thief registers themselves | 7-day cooldown from **acceptance** + co-sign + member-only notification | PARTIAL → **fixed** by N1 activation gating (below): thief latency is full cooldown + window + 48h, minimum 23 days at the 14-day floor |
| Thief registers, claims later | Member-chosen window + explicit activation + 48h grace; cancel voids registration | PARTIAL → **fixed** (activation tx removes the payout-timing race) |
| Coercion | Co-sign + loud events | PARTIAL, honestly restated: a coerced registration is a persistent lien on all future payouts — worse than a one-time transfer. Mitigations: co-sign makes it a two-party act, cancel voids it any time, expiry re-arms the alarm. **No full defense exists; said plainly.** |
| False claim, member alive but offline | Tiered notifications (below) + member-chosen window + travel hold | PARTIAL→BROKEN at 14 days for this audience → **mitigated** by 30-day default, member choice, travel hold, and organizer corroboration at initiation |
| Member loses account AND contact | Out of scope, unchanged | HOLDS |
| Registry griefing / spam claims | Contact-only initiation, one live claim, cancel-voids | HOLDS |
| Offline > window (residual) | Stated as the design's honest residual, not a tail case; "don't enable the feature" remains a legitimate choice the UI respects | Reframed per review |
| **N1 resolve-gating** (new, critical) | Resolve returns the contact **iff** settled active claim; dedicated test | **Adopted** |
| **N2 drift-guard composition** (new, high) | register/initiate fail-closed; cancel/accept fail-open; address-keying limits documented | **Adopted** |
| **N3 unscreened contact = OFAC channel** (new, high) | Screen at registration + initiation + retro-sweep; refuse on hit | **Adopted** |
| **N4 cross-module conservation** (new, high) | Single resolver + delivery events + conservation property test | **Adopted** |
| **N5 transitive redirect** (new, med) | One hop, non-transitive | **Adopted** |
| **N6 cancel/activation ordering** (new, med-high) | Explicit activation tx + 48h settlement grace | **Adopted** |

## 5. Registry creation & keys (Move review)

`init` only runs on fresh publishes and both deployments are upgrade lineages, so the
registry is created post-upgrade via the **UpgradeCap-gated bootstrap pattern**
(`assert_canonical_upgrade_cap`, as `njangi_compliance::create_config` does), wired into
`scripts/bootstrap-package.mjs`, pinned in env as
`NEXT_PUBLIC_<NET>_NJANGI_RECOVERY_REGISTRY_ID`. Sender-keyed registration means a forged
twin registry cannot fabricate victim→attacker mappings, but a confusion-grief with an empty
twin ("no redirect here") is why exactly one publisher-created instance + env pin + layered
guard is the pattern — same caveats njangi_compliance documents for itself.

## 6. User-facing copy (drafted to pass check:copy; product review)

> "If you ever lose the account you sign in with, money already owed to you doesn't have to
> be lost with it."
> "Choose a trusted contact — usually family. Money the circle owes you can be delivered to
> them instead."
> "Only you can set this up, and you can change or cancel it any time with one tap."
> "Nothing happens quickly or quietly: every step is announced, and any request waits the
> time you chose — so you can stop it if it wasn't you."

Pre-copy task: `check:copy` has no pattern for "safe / protected / never lose your money";
add one before this feature's marketing lands, because the natural pitch is exactly the
overclaim the honest-copy doctrine forbids.

**Notification tiers (Q4 resolved):** registration → member only. Claim initiated → member on
every channel **+ organizer only**, neutrally worded ("A recovery request was started for
[name]. If you can reach them, ask them to open the app") — the organizer is the social hub
who knows whether [name] is at the village, and corroboration is only useful while cancel is
still possible. Claim activated → full circle, with the §3.4 wind-down guidance.

## 7. Rollout gates

1. ~~Adversarial design review~~ — **done 2026-08-22**, findings adopted above.
2. Counsel question in the pre-go-live package (owner sequencing: counsel last). Includes the
   new question: does screening a member-designated contact at our service surfaces, while
   the chain cannot enforce it, hold up under the sanctions program's layered-posture
   argument?
3. Build: `njangi_member_recovery.move` (~9–11 additive publics + registry; zero existing
   signatures or layouts change — inventory verified against source) + the drift-guard list
   additions + `ScreenContext` addition. Gate on `sui client upgrade --dry-run`.
4. Testnet drill with registry windows parameterized at creation (hours, not days — same code
   path): register+co-sign with WhatsApp on a real feature phone → early claim rejected →
   stranger claim rejected → contested cancel voids → uncontested claim activates →
   `redeem_as_beneficiary` collects a finalized cycle → emergency stop pays the contact →
   goal-pool `claim_refund_for` → comprehension interviews (≥80% of cohort can say what the
   contact can and cannot do) → measure member time-to-notice.
5. Ship after mainnet go-live (Q4 roadmap slot): a new theft-shaped money surface does not
   land in the same quarter as first real money; the allowlisted cohort is covered by the
   drift guard, emergency stop, and hands-on support meanwhile.

## 8. Review register

- **Red-team** (verdicts + N1–N6): all adopted; coercion and offline residuals restated
  honestly rather than defended.
- **Move implementability**: mechanism corrected to escrow-drain redemption; deposit row
  rescoped; goal pools brought into scope; best-effort push-path and 30-day-race caveats
  added; registry bootstrap pattern fixed; address-keying documented with the
  cross-provider-contact recommendation. Verdict: implementable as a pure upgrade.
- **Product/compliance**: naming, setup moment, window choices, expiry semantics,
  notification tiers, death case, copy drafts, and the after-go-live priority call — all
  adopted. No compliance invariant crossed; the no-admin-cap rule is restated as absolute.
