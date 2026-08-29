# E2E browser runbook

What `scripts/e2e-compliance-check.mjs` **cannot** prove, and how to prove it.

The automated checker asserts every property observable from outside a session:
the signing oracle is gone, the OAuth nonce binds to a browser-held key, sponsor
routes need a cookie, gates block new commitments without trapping funds, a
listed address is refused, and the deployed package has the expected shape.

None of that proves a **transaction actually signs and lands**. That gap is not
theoretical: after the ephemeral key moved into the browser, 22 client paths
kept POSTing to a server that could no longer sign for them, and every one
returned 409. Unauthenticated probes returned `400 Account data is required` —
indistinguishable from healthy — so the regression survived a full verification
pass. Only a signed-in browser tells them apart.

## Accounts

Three Google identities, three distinct zkLogin addresses (a different `sub`
derives a different Sui address):

| Role | Account | Purpose |
|---|---|---|
| ADMIN | `anustalanic@gmail.com` | creates and administers the circle |
| MEMBER-1 | `anufamily594@gmail.com` | joins, pays deposit, contributes |
| MEMBER-2 | `njangionchain@gmail.com` | joins, contributes, receives payout |

**Never type a password.** Use accounts already signed into Chrome and pick
them from the account chooser. If any step asks for a password or 2FA, stop —
that is the operator's to do, not the agent's.

**Funding.** Each address needs testnet SUI for gas unless sponsorship covers
it. Capture each address at first login and fund from the faucet before the
member steps, or they fail on gas rather than on logic.

## The assertion that matters most

Before each on-chain action, open DevTools → Network and filter on `zkLogin`.

- A POST to `/api/zkLogin` with a signing `action` (`activateCircle`,
  `paySecurityDeposit`, `adminApproveMember`, …) means the migration MISSED
  that path. Expect `409 CLIENT_SIGNING_REQUIRED`.
- The healthy signature is **no request at all** for the signing step — the
  transaction is built and signed locally, then submitted straight to RPC.
- `/api/sponsor/prepare` and `/api/sponsor/execute` are expected and correct.
  Sponsorship is the one flow that legitimately round-trips the server, and it
  still never sends a key.

## Flow

### 1 — Admin login
Sign in as ADMIN. Record the address from Wallet Overview.

- Console clean of `CLIENT_SIGNING_REQUIRED`
- `localStorage.account` has **no** `ephemeralPrivateKey`, `zkProofs`, or
  `userSalt` (only display fields)
- `sessionStorage['njangi.zklogin.signer']` exists (tab-scoped key)
- `sessionStorage['njangi.zklogin.pending']` is gone (consumed at callback)

### 2 — Create a circle
Small amounts: contribution 0.1 USD, deposit 0.1 USD, max 3 members.

Proves `createCircle` builds and signs client-side. Record the circle id.

### 3 — Members join
As MEMBER-1 and MEMBER-2: open the invite link and request to join. The request
is an off-chain row — expect `/api/join-requests/create`, no chain write, and
no `/api/zkLogin` POST at all.

Then the admin approves. `adminApproveMembers` is a signing action, so this is
the first real client-signing assertion: a digest on chain and no
`/api/zkLogin` POST.

### 4 — Deposits
Every member, INCLUDING THE ADMIN, pays the security deposit. `activate_circle`
asserts `has_paid_deposit` for the admin and for each member in
`rotation_order`, so an unpaid admin blocks activation as surely as an unpaid
member. The manage page's "N deposits settled" counter is the quickest check.

`paySecurityDeposit` has the most logic of any migrated path — it reads the
amount from chain config and, for USDC, merges owned coins before splitting.
Watch for `InsufficientDepositBalanceError` (a real balance problem) versus a
409 (a missed migration) versus a 503 (a capability gate that should not be in
front of this path — that combination took USDC deposits down entirely once).

Wait for the page to render custody balances before clicking. Clicking while
the circle's wallet id is still loading builds the transaction with a zeroed
object id and fails with an opaque RPC error.

### 5 — Rotation order, then activate

**The rotation order must list every member before a cycle can open.**
`admin_approve_members` does NOT add anyone to `rotation_order` — only
`set_rotation_position` and `reorder_rotation_positions` do, and a circle
created by the normal flow starts with just the admin in it. `open_cycle`
builds its member set from `rotation_order` and asserts at least two active
members, so an incomplete order fails there rather than at activation, with an
error that does not mention rotation.

Use **Edit Rotation Order** on the manage page, confirm all members appear,
then save. Expect a digest and no `/api/zkLogin` POST.

Only then **Activate**. A delegate is required *only* if the circle was created
with auto-release enabled; the contract checks it inside
`if (config::is_auto_release_enabled(...))`, and a circle created without it
cannot have a delegate at all. If the UI demands one on such a circle, that is
a bug, not a prerequisite.

Expect no `/api/zkLogin` POST and a digest on chain.

`paySecurityDeposit` has the most logic of any migrated path — it reads the
amount from chain config and, for USDC, merges owned coins before splitting.
Watch for `InsufficientDepositBalanceError` (a real balance problem) versus a
409 (a missed migration).

### 6 — Rotation lock
With the circle now active, reordering the rotation must be REFUSED
(`ECircleNotPausedForConfigChange`). That is the guard stopping an admin
redirecting a payout members have already funded — and it is why step 5 has to
happen while the circle is still inactive.

### 7 — Contribute
Both members contribute to the open cycle.

If sponsorship is on, watch for `/api/sponsor/prepare` → `execute`. Three
console lines are worth capturing, and they mean different things:

- `sponsorship declined, paying own gas: <reason>` — prepare said no. Benign,
  but the reason names which precondition failed (`disabled`,
  `metering_unavailable`, `user_daily_cap`, `no_circle_id`, …).
- `falling back to self-paid gas` — the byte-equality verifier rejected the
  sponsor's bytes. Either a real defect or a too-strict comparator; both need
  investigating.
- `submitted but not confirmed; not re-signing` — the transaction went out but
  confirmation timed out. Correct behaviour: re-signing here would charge the
  member twice.

A `prepare` with no `execute` and self-paid gas on chain means the decline path
ran; check the reason rather than assuming quota was consumed.

### 8 — Payout
Finalize and let the scheduled recipient claim.

Then attempt to claim as the **wrong** member. It must abort with
`E_NOT_RECIPIENT` (207). This is the single most important on-chain assertion
in the product: the pot is redeemable only by the address frozen into the
snapshot.

The UI will not offer a non-recipient the button, so testing this through the
interface proves nothing about the contract. Simulate the call instead —
`devInspectTransactionBlock` takes a sender and needs no signature, so the
guard itself is what gets measured. Run it for both non-recipients AND for the
real recipient: without that control, an abort could simply mean the call was
malformed.

```
node scripts/assert-not-recipient.mjs \
  --escrow 0x… --package 0x… --coin 0x…::usdc::USDC \
  --recipient 0x… --member 0x… --member 0x…
```

Works on a settled escrow too: the identity assert is the FIRST guard in the
function, so once a pot has been claimed the recipient gets
E_ALREADY_FINALIZED (205) while non-recipients still get 207 — which shows the
recipient clearing the exact gate that stopped everyone else.

### 9 — Compliance surfaces
- Legal acceptance modal appears before joining and is recorded
- Swap UI present (swaps are an enabled product feature)
- Legacy contribution routes absent or refused
- No copy promising interest, yield, or returns

## Recording results

For each step: the action, whether any `/api/zkLogin` signing POST appeared,
the transaction digest, and any console error. A step that "seemed to work"
without a digest has not been verified.

Anything that 409s is a missed migration — the fix pattern is a builder in
`src/lib/zklogin-tx-builders.ts` plus `signLocallyWithBuilder` in
`src/services/zkLoginClient.ts`.
