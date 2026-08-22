# PRD — Address-drift guard

**Priority:** P0. Must land before any mainnet cohort, and ideally before the testnet pilot.
**Owner:** unassigned
**Status:** Spec ready to build. No open external dependencies.
**Estimate:** ~2–3 days including backfill and tests.

---

## 1. The problem

A zkLogin address derives from `(iss, aud, sub, salt)`. Three of those can change without any
user action:

- **`salt`** — supplied by Enoki, and it changes when the Enoki API key is rotated, even within
  the same application. This is documented in `CLAUDE.md` with testnet evidence: circles created
  2026-07-04 belong to one address, everything after to another, with the same Google account,
  same `sub`, same client id, same app. The only variable that moved was the live API key.
- **`aud`** — the OAuth client id (`NEXT_PUBLIC_{GOOGLE,FACEBOOK,APPLE}_CLIENT_ID`).
- **`iss`** — swapping the identity provider entry entirely.

When any of them changes, the same human signs in with the same social account and receives a
**different Sui address**. Their circles, security deposits, and funds remain at the old address,
which no future login will ever reach again. There is no error, no warning, and no migration path.
On mainnet this is permanent user fund loss.

**Why it is silent today.** The code deletes the evidence before it could ever be compared. On
every successful login `src/pages/api/zkLogin.ts:1173` calls `cleanupUserSessions(...)` →
`deleteZkLoginSessionsForUser` (`src/lib/zklogin-session-registry.ts:280`), which wipes prior
sessions for that user. `zklogin_sessions` also carries a 24-hour TTL. So the previous address is
gone before the next login produces a new one, and nothing anywhere retains a durable
identity→address history. The only address comparisons in the codebase are *intra-session*
(client-claimed account vs. cookie session, e.g. `zkLogin.ts:1274`) — there is no cross-login
comparison at all.

`src/lib/auth-callback-guard.ts` does **not** help: it is an OAuth token replay dedupe for React
StrictMode double-effects, unrelated to addresses.

## 2. Goals / non-goals

**Goals**

1. Detect, at login, that a returning identity has resolved to a new address.
2. Stop that user from making **new financial commitments** at the new address before they
   understand what happened.
3. Never block that user from **reaching funds** — theirs or their circle's.
4. Alert operators loudly, because drift affecting more than one user is a configuration incident,
   not a user problem.
5. Preserve the old address durably so support can act on it.

**Non-goals**

- Recovering funds from the old address. That is impossible from our side by design — we hold no
  key for it. Recovery, where possible at all, runs through the circle's own member vote.
- Account-level social recovery (a separate, later feature).
- Preventing drift. That is an operational discipline (rotate keys before you have users); this
  feature only ensures it is never *silent*.

## 3. Design

### 3.1 Detection key — get this right

The naive key is `(sub, aud)`. **It is wrong for our threat model.** If the OAuth client id
changes, `aud` changes, so a `(sub, aud)` lookup finds no prior row and the login looks like a
brand-new user — missing precisely one of the three documented drift causes.

Use the OIDC-canonical stable identity instead:

> **Detection key = `(iss, sub)`** — "have we ever seen this human before, under *any* client id
> or salt?"

`iss` is present in the decoded JWT at `src/services/enokiZkLoginService.ts:500` but is currently
dropped. Capture it and thread it through the return type (`:480-489`, `:591-596`), `AccountData`
(`:117-135`), and the re-export wrapper in `src/services/zkLoginService.ts:71-80`. The existing
`AccountData.provider` field (`'Google' | 'Facebook' | 'Apple'`, set at `:510`) is the fallback
detection key for backfilled rows that predate `iss` capture.

### 3.2 Storage

New Postgres table, append-only in the manner of `legal_acceptances`:

```sql
CREATE TABLE IF NOT EXISTS zklogin_address_bindings (
  id            BIGSERIAL PRIMARY KEY,
  iss           TEXT,
  sub           TEXT NOT NULL,
  aud           TEXT NOT NULL,
  provider      TEXT,
  user_address  TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  login_count   BIGINT NOT NULL DEFAULT 1,
  UNIQUE (sub, aud, user_address)
);
CREATE INDEX IF NOT EXISTS zklogin_address_bindings_identity
  ON zklogin_address_bindings (sub, iss);
```

Append-only matters: on a drift event **both** rows survive, so the old address stays visible to
support rather than being overwritten by the new one.

Add it to `scripts/migrate-postgres.mjs` as one `{name, sql}` entry appended to the `STATEMENTS`
array (there are no `.sql` files and no version table — every statement must be idempotent), plus
a numbered line in the header inventory at `:8-19`. Follow the comment style of the
`legal_acceptances` entry at `:321-345`. Mirror the lazy `ensureTable()` self-creation race guard
used by `zklogin-session-registry.ts:152` and `stripe-service.ts:187`.

### 3.3 Detection point

`src/pages/api/zkLogin.ts`, in `case 'handleCallback'`, **after** `:1141` (where `result` carries
the freshly derived address) and **before** `:1173` (`cleanupUserSessions`, which destroys prior
state). Sit it directly alongside the existing sanctions screen at `:1165` — that call is the
precedent for this exact shape: it refuses to return zkProofs, so the client cannot sign at all.

Logic:

1. Look up existing bindings for `(iss, sub)`, falling back to `(provider, sub)` for rows written
   before `iss` capture.
2. **No rows** → insert binding, proceed normally. (First-ever login.)
3. **A row matches the derived address** → bump `last_seen_at` / `login_count`, proceed normally.
4. **Rows exist but none matches the derived address** → **drift**. Insert the new binding
   (append-only), mark the session as drifted, emit an operator alert, and return the drift state
   to the client.

### 3.4 Behavior on drift — reuse the sanctions split

Do not invent a new posture. `src/lib/sanctions.ts` already establishes the right one for this
codebase, and the reasoning transfers exactly:

> **Fail-closed on new commitments. Fail-open on fund access.**

| Surface | Behavior on drift | Why |
|---|---|---|
| Circle create, circle join, contribute, goal-pot contribute, ramp session, WhatsApp link | **Blocked** | These commit new money or new obligations at an address the user may not realize is new. |
| Claim payout, redeem, refund, recovery vote, withdrawal, `CashOutGuide` | **Allowed** | Never stand between a user and funds. Blocking these would convert a config error into a lockout. |
| Login itself | **Allowed** | The user must be able to get in to see the explanation. |

This mirrors `sanctions.ts` (fail-closed on `circle_create` / `circle_join` / `ramp_session` /
`proof_issuance`; fail-open on claim / refund / recovery) and should reuse the same route-level
enforcement points so there is one list of "commitment surfaces" in the codebase, not two.

### 3.5 Surfacing it to the user

Copy the legal-acceptance gate pattern wholesale rather than inventing one.

- **Server status endpoint:** `GET /api/auth/address-drift`, modeled directly on
  `src/pages/api/legal/status.ts` — resolve identity solely from
  `getZkLoginSessionAccount(req.cookies['session-id'])` (`:39`), 401 with `requiresReauth: true`,
  rate-limit via `consumeRateLimit` (`:28-36`).
- **Client gate:** a `AddressDriftGate` component modeled on `LegalAcceptanceGate`
  (`src/components/LegalAcceptanceModal.tsx:486-538`), mounted once inside `AuthProvider`
  (`src/contexts/AuthContext.tsx:586`). Mounting inside the provider is essential: `/auth/callback`
  only covers fresh logins, while the provider also covers localStorage session restore
  (`AuthContext.tsx:129-172`).
- **Exempt the same routes.** Reuse the `isLegalGateExemptPath` idea (`:531`) so recovery, claim
  and withdrawal routes are never covered by the interstitial — same rationale as §3.4.

**The modal is non-dismissable for commitment surfaces and explains, in plain language:** that
sign-in produced a different account than last time, that their previous funds are at the previous
address (shown), that we cannot move funds between them, what we are doing about it, and how to
contact support. It must not blame the user, and must not use the word "salt."

Copy must pass `scripts/check-marketing-copy.mjs` — in particular avoid absolute claims about
safety or recoverability.

### 3.6 Operator alerting

One user drifting is strange; several drifting in an hour is a configuration incident affecting
everyone who logs in afterward. Emit on every drift event:

- A structured error to Sentry (currently an owner blocker — if the DSN is not yet provisioned,
  this feature is a reason to finish it).
- An internal notification via the existing `INTERNAL_NOTIFY_SECRET` channel.
- A counter suitable for "N drift events in the last hour" so a spike is visible.

Add a short section to `docs/incident-playbook.md`: on a drift spike, the first question is
*"which address-affecting env var or Enoki key changed, and can it be reverted?"* — reverting the
salt source restores the original addresses for everyone who has not yet been onboarded under the
new one.

### 3.7 Backfill — without it the guard protects nobody at first

A fresh table means every existing user's next login looks like a first-ever login, so drift would
still pass undetected once. Backfill durable `(sub, aud, user_address)` triples from the tables
that already hold them:

- `legal_acceptances` — **the best source**, since every user must accept before joining a circle,
  and it is already append-only.
- `subscriptions` — paying organizers.
- `gas_sponsorship_usage` — sponsored users.

Backfilled rows have `iss = NULL` and rely on the `provider` fallback until each user's next login
fills `iss` in. Ship the backfill as an idempotent statement in the same migration run.

## 4. Acceptance criteria

1. A first-ever login records a binding and is not blocked.
2. A repeat login with a matching address is not blocked and bumps `login_count`.
3. **Simulated salt change** (test harness stubs `getUserSalt` to return a different value) produces
   a drift result: new binding row appended, old row intact, interstitial shown, commitment
   surfaces blocked.
4. **Simulated `aud` change** with the same `sub`/`iss` is *also* detected as drift. (This is the
   case a `(sub, aud)` key would have missed — assert it explicitly.)
5. A drifted user can still reach claim, refund, recovery and withdrawal routes and complete a
   payout claim end-to-end.
6. A drifted user cannot create a circle, join a circle, or contribute.
7. Drift emits exactly one operator alert per event, with both addresses in the payload.
8. Backfill populates bindings for every distinct `(sub, aud, user_address)` in
   `legal_acceptances`, and re-running the migration is a no-op.
9. `npm run preflight` clean; new unit tests colocated under `src/lib/__tests__/`.

## 5. Files to touch

| File | Change |
|---|---|
| `src/services/enokiZkLoginService.ts` | Capture `iss` at `:500`; thread through `:480-489`, `:591-596`, `AccountData` `:117-135` |
| `src/services/zkLoginService.ts` | Widen the re-export wrapper `:71-80` |
| `src/lib/zklogin-address-bindings.ts` | **New.** Table ensure, lookup by `(iss, sub)`, append binding, drift decision |
| `src/pages/api/zkLogin.ts` | Detection call between `:1141` and `:1173`, beside the sanctions screen at `:1165`; new error class beside `SanctionsBlockedAtLoginError` `:71`; map it in the catch at `:1232` |
| `src/pages/api/auth/address-drift.ts` | **New.** Status endpoint, modeled on `legal/status.ts` |
| `src/components/AddressDriftModal.tsx` | **New.** Modeled on `LegalAcceptanceModal.tsx` |
| `src/contexts/AuthContext.tsx` | Mount the gate beside `LegalAcceptanceGate` at `:586` |
| Commitment-surface routes | Enforce the block; reuse the sanctions enforcement points |
| `scripts/migrate-postgres.mjs` | Append table + backfill statements; header inventory `:8-19` |
| `docs/incident-playbook.md` | Drift-spike response section |
| `src/lib/i18n.ts` | Modal strings, EN + FR minimum |

## 6. Risks

- **False positives lock users out of joining.** A user legitimately signing in with a *different
  provider* (Google vs Facebook) has a different `sub` and correctly gets its own binding — not
  drift. Verify this in test 4's negative case.
- **The interstitial frightens people.** It reports a real problem, but tone matters enormously
  for this audience. Copy needs a careful review pass, in both languages.
- **Blocking is only as good as the enforcement list.** If a commitment surface is missed, drift
  silently permits a new deposit there. Deriving the list from the existing sanctions choke points
  rather than a fresh list is the mitigation.
- **Backfill gap.** Users with no legal acceptance, no subscription and no sponsored usage cannot
  be backfilled; their next login establishes a first binding. Accept and document.
