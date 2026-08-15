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

### 3 — Activate
The action that was broken for a day, and the reason this runbook exists.

Expect no `/api/zkLogin` POST and a digest on chain.

### 4 — Members join
As MEMBER-1 and MEMBER-2: open the invite link, request to join, pay the
security deposit.

`paySecurityDeposit` has the most logic of any migrated path — it reads the
amount from chain config and, for USDC, merges owned coins before splitting.
Watch for `InsufficientDepositBalanceError` (a real balance problem) versus a
409 (a missed migration).

### 5 — Admin approves
Approve both members. Then confirm the **rotation lock** from Phase 5: with the
circle active, reordering the rotation must be refused
(`ECircleNotPausedForConfigChange`). That is the guard stopping an admin
redirecting a payout members have already funded.

### 6 — Contribute
Both members contribute to the open cycle.

If sponsorship is on, watch for `/api/sponsor/prepare` → `execute`. Any
`[sponsored-tx] falling back to self-paid gas` in the console is worth
capturing — it means the byte-equality verifier rejected the sponsor's bytes,
which is either a real defect or a too-strict comparator.

### 7 — Payout
Finalize and let the scheduled recipient claim.

Then attempt to claim as the **wrong** member. It must abort with
`E_NOT_RECIPIENT`. This is the single most important on-chain assertion in the
product: the pot is redeemable only by the address frozen into the snapshot.

### 8 — Compliance surfaces
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
