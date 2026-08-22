# PRD — Member-controlled account recovery ("recovery beneficiary")

**Priority:** Post-beta. Designed now so the review can start; **build-gated on design review,
because its failure mode is theft.**
**Owner:** unassigned
**Status:** Design for review. No code exists and none should be written until the threat model
below survives scrutiny (and counsel review lands before go-live, per the owner's sequencing).

---

## 1. The problem

A zkLogin account *is* a social login: the Sui address derives from the OAuth identity, so a
member who permanently loses their Google/Facebook/Apple account permanently loses their address.
There is no seed phrase to restore. Today the product's honest answer is circle-level — the
emergency-stop vote returns contributions — but that answer has two holes:

1. **Refunds pay the address of record.** A refund to an address the member can no longer sign
   for is not a remedy; it re-strands the money one hop later.
2. **Future payouts are worse.** A rotation that reaches an unreachable member mints a claim that
   expires uncollected, and the member's own past contributions funded everyone before them.

The address-drift guard (shipped) makes account loss *visible*; nothing yet makes it
*survivable*. The two are deliberately separate: drift from a configuration change is fixed by
reverting the configuration (incident playbook, Scenario 4), while genuine OAuth-account loss has
no operator fix at all — which is exactly why the remedy must be something the member sets up
themselves, in advance, on-chain.

## 2. Design principles — the invariants this must not bend

1. **We gain no power.** No operator, admin, or attestor role may move, redirect, or reassign a
   member's funds or position. The mechanism is member-configured and member-triggered, or it
   does not exist. (Compliance invariant #1; a recovery path that runs through us is custody.)
2. **The healthy member always wins.** At every stage, the original address can unilaterally
   cancel with a single transaction. Recovery is a race the attacker must win *slowly and
   loudly* while the victim can stop it *instantly and quietly*.
3. **Absence of setup is absence of the feature.** A member who never registers a beneficiary
   keeps exactly today's semantics. No defaults, no operator-seeded beneficiaries.
4. **Loud by construction.** Every state change emits an event that the existing WhatsApp relay
   surfaces to the member and their circles. Silence is the attacker's friend; this design has
   none.

## 3. The mechanism

### 3.1 Registration (while healthy)

A member signs `register_recovery_beneficiary(registry, beneficiary_address, clock)`:

- Stored in a **shared `RecoveryRegistry`** (one per package, `Table<address, BeneficiaryRecord>`)
  — *not* on any circle, so one registration covers every circle the member is in, including
  future ones.
- `BeneficiaryRecord { beneficiary, registered_at_ms, effective_at_ms }` with
  `effective_at_ms = registered_at_ms + REGISTRATION_COOLDOWN` (**7 days**). The cooldown is the
  defense against a *session thief*: someone who briefly controls the member's signer can point
  the beneficiary at themselves, but cannot benefit for 7 days, during which the member sees the
  change notification and re-registers (which resets the clock and overwrites the record).
- Changing or clearing the beneficiary is the same call; latest registration wins.

### 3.2 Claim (after loss)

The beneficiary signs `initiate_recovery_claim(registry, lost_member, clock)`:

- Valid only if a record exists, is effective, and names the sender.
- Opens a **challenge window** (**14 days**) recorded in the registry; emits
  `RecoveryClaimInitiated`.
- During the window, the original address can sign `cancel_recovery_claim` — one transaction,
  no argument beyond the registry. This is the "I'm alive" switch, and it also *clears the
  beneficiary registration entirely* (a contested claim proves the registration is compromised
  or stale).
- After the window with no cancellation, the claim becomes **active**: the registry now maps
  `lost_member → beneficiary` as a settled redirect.

### 3.3 What an active redirect actually does — deliberately narrow

An active redirect changes **where value that was already owed to the lost member is deliverable**.
It does not impersonate them:

| Flow | With active redirect |
|---|---|
| Cycle payout (`finalize`) | Claim minted to the beneficiary instead of the lost address |
| Escrow refund / expired-claim refund | Paid to the beneficiary |
| Emergency-stop refunds | Lost member's share paid to the beneficiary |
| Security-deposit return on circle close | Paid to the beneficiary |
| **Voting, contributing, joining, admin roles** | **Not transferred. Ever.** |

The lost member's *social* standing — votes, membership, the ability to contribute — dies with
the account. Only *value already owed* is rescued. This keeps the mechanism firmly on the
"delivering someone their own property" side of the line and far from "account takeover as a
feature."

Implementation shape: the escrow/refund paths gain `*_or_beneficiary` variants (additive entry
functions — same upgrade-compatibility pattern as v1.1) that read the shared registry and pay
`resolve_payable_address(registry, member)` instead of `member`. Existing entry points stay
untouched; circles opened before the upgrade keep working.

## 4. Threat model

| Attack | Defense |
|---|---|
| Session thief registers themselves as beneficiary | 7-day cooldown + notification on registration; victim re-registers, resetting the record |
| Thief registers, then initiates a claim later | 14-day challenge window + notifications; victim cancels with one signature, which also voids the registration |
| Coercion ("register your beneficiary as me") | No better than coercing a transfer directly; the mechanism adds no new leverage |
| Beneficiary falsely claims while member is alive but inactive | Notifications to the member AND their circles' WhatsApp threads; any login during 14 days surfaces a blocking banner with one-tap cancel |
| Member loses account AND beneficiary account | Out of scope — same as today. The mechanism is strictly additive. |
| Registry as an attack surface (griefing, spam claims) | Claims only from the registered beneficiary; one live claim per member; initiating is idempotent |
| **Residual risk:** member offline > 14 days with a compromised, unnoticed registration | Real. Mitigations: long cooldown+window totals (21 days minimum attacker latency), loud events, and the member's option not to use the feature at all |

## 5. What this is deliberately not

- **Not social recovery by committee.** No M-of-N guardians, no circle vote to reassign an
  account. Votes reassigning identity put the circle in a position to expropriate a member —
  exactly the power this product exists to remove.
- **Not operator-assisted.** Support can explain the feature; support cannot trigger, approve,
  or expedite it.
- **Not identity migration.** The beneficiary does not "become" the member; they receive owed
  value. A member who regains a *new* OAuth account joins circles as a new address like anyone
  else.
- **Not a substitute for the drift playbook.** Configuration drift is fixed by reverting
  configuration; this handles the case with no fix.

## 6. Rollout

1. **Design review** of this document — adversarial, same bar as the escrow reviews.
2. Counsel question folded into the pre-go-live counsel package (the owner sequences counsel
   last before go-live): does a member-configured, time-locked redirect of owed funds to a
   designated beneficiary raise custody/transmission questions we do not already carry? (Our
   read: no — we never hold or direct; the member configures, the chain executes. But it is a
   new answer to "who can funds go to," which is precisely the class of change that gets asked.)
3. Move module `njangi_member_recovery.move` + additive `*_or_beneficiary` escrow variants +
   tests, including the full attack matrix above.
4. UX: registration in settings; claim + cancel flows; WhatsApp notifications for every event;
   the drift modal gains a "set up a recovery contact" pointer (its absence today is the gap
   this closes).
5. Testnet pilot cohort exercises a full claim + a contested cancel before mainnet.

## 7. Open questions for review

1. Are 7/14-day windows right for this audience? (Longer = safer against theft, crueler to a
   genuinely locked-out member. A member-chosen window within bounds may be better.)
2. Should an active redirect expire if unused (e.g. 180 days), forcing re-initiation?
3. Should registration require the beneficiary to co-sign an acceptance, preventing surprise
   beneficiaries and typo'd addresses? (Leaning yes; it adds one step to setup and removes a
   whole class of mistakes.)
4. Does the WhatsApp notification path leak that a member has lost their account to their whole
   circle before they've had a chance to cancel a false claim? (Possible middle ground: notify
   the member privately at registration, the circle only when a claim goes active.)
