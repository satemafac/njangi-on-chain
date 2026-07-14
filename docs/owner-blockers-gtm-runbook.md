# Owner blockers — step-by-step GTM runbook

_2026-07-03. The engineering blockers are closed and on prod (testnet). What remains is owner-owned: config, external sign-off, and go/no-go decisions. This is the ordered path from here to a mainnet soft-beta launch. Each item: what it is · why it blocks · your options · exact steps · my recommendation._

Legend: 🟢 quick config (≤30 min) · 🟡 decision + action · 🔴 external dependency (days/weeks).

---

## Order of operations (the critical path)

```
1. Sentry DSN            🟢  (do first — you want eyes on prod before anything else)
2. Rotate Enoki key      🟢  (security; also unblocks gas sponsorship)
3. Stripe 4242 test      🟢  (proves the money path in sandbox)
4. Enable gas sponsorship🟡  (Enoki plan + portal config; depends on #2)
        ── testnet is now fully launch-shaped ──
5. Counsel sign-off      🔴  (longest pole — START NOW, runs in parallel with 1-4)
6. Audit vs allowlist    🟡  (the gating go/no-go decision)
7. Mainnet publish       🟡  (mechanical once 5+6 are settled; needs your auth)
```

**Start #5 (counsel) today** — it's the only item measured in weeks; everything else is hours. Do #1–#4 while counsel reviews.

---

## 1. 🟢 Sentry error tracking — DO FIRST

**What:** Real-time error/crash reporting for server API routes and client crashes. **Why it blocks:** verified absent on prod (no DSN in the client bundle). With real money moving, a 500 in the fund path or a client crash is invisible beyond raw Vercel logs — you'd learn about failures from angry users, not a dashboard.

**Options:**
- **A (recommended): Sentry free tier.** 5k errors/mo, more than enough for a soft beta. Zero cost.
- B: Skip and rely on Vercel logs. Not acceptable for real money — no alerting, no grouping, no client-side crashes.

**Steps:**
1. Create a project at sentry.io → Next.js platform. Copy the **DSN** (a URL like `https://xxx@yyy.ingest.sentry.io/zzz`).
2. Set on Vercel (Production): `SENTRY_DSN` (server) + `NEXT_PUBLIC_SENTRY_DSN` (client, same value). Optional for source-maps: `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`.
3. Redeploy. DSNs are write-only ingest keys — safe as `NEXT_PUBLIC_`. Keep `sendDefaultPii: false` (already the default).
4. Verify: trigger a test error; confirm it lands in the Sentry dashboard.

---

## 2. 🟢 Rotate the leaked Enoki key — SECURITY + unblocks #4

**What:** The Enoki API key (zkLogin salt/zkProof + soon gas sponsorship) was historically committed as a `NEXT_PUBLIC_ENOKI_*` var, which ships it to the browser. **Confirmed still live:** prod has `NEXT_PUBLIC_ENOKI_TESTNET` / `NEXT_PUBLIC_ENOKI_MAINNET`, not the server-only vars. **Why it blocks:** a client-exposed key is already a leak; once gas sponsorship is on (#4) that key can **spend your gas budget**, turning the leak into a direct cost/DoS vector. Must rotate before enabling sponsorship.

**Steps:**
1. In the Enoki portal (enoki.mystenlabs.com), **revoke** the current key and generate a **new private API key** per network.
2. On Vercel, set the new value as **server-only** vars (NO `NEXT_PUBLIC_` prefix): `ENOKI_API_KEY_TESTNET`, `ENOKI_API_KEY_MAINNET`. The code already prefers these over the deprecated public ones (public-env.ts canonical-or-legacy resolution).
3. **Delete** `NEXT_PUBLIC_ENOKI_TESTNET` and `NEXT_PUBLIC_ENOKI_MAINNET` from Vercel so the browser bundle stops carrying a key.
4. Redeploy. Verify login still works (salt/zkProof runs server-side behind `/api/zkLogin`) and confirm no `enoki` key string appears in the client bundle.

---

## 3. 🟢 Stripe 4242 test round-trip (sandbox)

**What:** A full checkout with Stripe's test card `4242 4242 4242 4242` to prove the billing path end-to-end. **Why it blocks:** billing is enabled in sandbox but the checkout→webhook→entitlement loop has never been exercised against live prod. This is browser-only, so it's yours to run.

**Steps (all in sandbox / test mode):**
1. Sign in on njangionchain.com, go to /pricing → upgrade to Premium.
2. Pay with `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP.
3. Confirm redirect to `/dashboard?billing=success`.
4. Confirm the subscription shows premium: as a free user, try a 4th circle member → expect the upgrade prompt; as premium, it's allowed.
5. Dunning check (optional): card `4000 0000 0000 0341` → confirm premium is retained on `payment_failed`.
6. **Never blocked (verify):** contribute / claim / withdraw / recover stay free for everyone — the fund path is never paywalled.

---

## 4. 🟡 Enable gas sponsorship (admin-billed) — depends on #2

**What:** Turn on Enoki-sponsored gas so members transact without holding SUI, funded by the circle admin's Premium subscription. Code is shipped and gated OFF behind `GAS_SPONSORSHIP_ENABLED`. **Why it matters:** this is the mechanism that makes "just transfer USDC from your exchange" actually work for a zero-SUI first-timer.

**Your subscription-cost decision:** Enoki Professional is **$120/mo** (100k sponsored txns + up to $100 SUI gas budget; $0.001/txn overage). At ~0.002–0.005 SUI per action that's fractions of a cent per member action. Premium is $9.99/mo, so one premium admin's subscription covers ~12 admins' worth of the base fee — the unit economics work as long as you're not carrying many premium admins each driving <$120 of value. Options:
- **A (recommended): enable now, Professional plan.** Fair-use caps are already coded (per-user daily + global monthly). Predictable ceiling.
- B: Stay off for the very first cohort; members withdraw a little SUI too (dual-withdrawal, documented). Zero cost, worse UX. Fine only if the first cohort is crypto-comfortable.
- C: Self-hosted gas station — only worth it past ~400–500k txns/mo. Not now.

**Steps (after #2 rotation):**
1. Sign up for Enoki Professional.
2. In the Enoki portal: allowlist **move-call targets** to your published package's entry functions only (never Cetus router targets); set a **monthly gas budget cap**; enable only the intended network.
3. Set Vercel `GAS_SPONSORSHIP_ENABLED=true` (optionally tune `GAS_SPONSORSHIP_DAILY_CAP_PER_USER`, `GAS_SPONSORSHIP_MONTHLY_CAP_GLOBAL`).
4. Redeploy. Test: a premium admin's circle → a member with 0 SUI contributes successfully (sponsored); a free admin's circle → member self-pays (falls back gracefully, never blocked).

---

## 5. 🔴 Counsel sign-off on legal drafts — START TODAY (longest pole)

**What:** A lawyer reviews the ToS / Privacy / Risk drafts and fills 6 placeholders: `{{COMPANY_LEGAL_NAME}}`, `{{COMPANY_ADDRESS}}`, `{{GOVERNING_LAW}}`, `{{CONTROLLING_LANGUAGE}}`, `{{PRIVACY_CONTACT}}`, `{{EFFECTIVE_DATE}}`. Then remove the DRAFT banner. **Why it blocks:** you cannot take real money from real users on unreviewed consumer-finance terms. This is the gate for real-money users and it's measured in days-to-weeks, so it sets the launch date.

**Options:**
- **A (recommended): a crypto/fintech-literate lawyer in your incorporation jurisdiction.** They'll also advise on the entity + the CEMAC positioning. This doubles as the licensing-posture conversation (see #6).
- B: A general-practice lawyer for a lighter ToS/Privacy review — cheaper/faster, but won't cover the VASP/licensing question.
- C: Template services (e.g. Termly/iubenda) — NOT sufficient alone for a crypto-adjacent consumer product handling savings; use only as a starting draft the lawyer edits.

**Steps:**
1. Decide the **legal entity + jurisdiction** (this fills `COMPANY_LEGAL_NAME`/`ADDRESS`/`GOVERNING_LAW`). If not incorporated yet, that's the real first step.
2. Send counsel: the three drafts in `docs/legal-drafts/`, plus the one-paragraph product description (non-custodial ROSCA coordinator, CEX-transfer funding, CEMAC + diaspora, Premium SaaS subscription — no fund-flow fees).
3. Get the 6 values + any redlines. Apply them; remove the DRAFT banner.
4. Confirm the legal-acceptance gate blocks contribute/join until accepted (already hardened this session).

---

## 6. 🟡 Audit vs allowlist — the gating go/no-go

**What:** The escrow/compliance Move contracts are new code that will hold real funds, reviewed internally (120 Move tests + multi-agent adversarial passes) but never by an external auditor. **Why it blocks:** decide how you bound the risk before real money.

**Options:**
- **A (recommended for launch): hard-capped allowlist beta.** ≤10–15 known users, per-circle fund caps, short pilot window. Treat it as bounded bug-bounty exposure. Commission the paid audit **in parallel** and gate the move from allowlist → open public on the audit passing. Fastest safe path to real usage.
- B: Full paid Move audit before ANY real money. Safest, but weeks + $$$ (typically $15k–$50k for a scope this size) before a single user.
- C: Open public launch on internal review only. Not recommended — unbounded exposure on unaudited fund-holding code.

**Steps (if A):**
1. Define the allowlist mechanism + caps (I can wire an allowlist gate + per-circle fund cap — small change).
2. Line up the audit shop now (Move-specialist: OtterSec, Zellic, MoveBit, etc.); scope = the 4 new modules.
3. Launch capped; open the gates only after the audit clears.

---

## 7. 🟡 Mainnet publish — mechanical, needs your explicit auth

**What:** Publish the contracts to mainnet and cut prod over. **Why it's last:** it's a small, reversible-by-routing step, but it must follow #5 (legal) and #6 (audit decision), and it requires master-key custody hygiene.

**Key decisions baked in:**
- **Multisig custody** for the AttestorCap (forge any KYC pass) and UpgradeCap (rewrite contracts) — must move off the hot deployer key. Decide the signer set/threshold.
- **Cap-pin sequencing** (load-bearing): the new UpgradeCap object id must be pinned in `move/config/mainnet.toml` immediately post-publish, before any upgrade.
- Publish **behind the allowlist** so no real users are routed until you open the gates.

**Steps:** the full mechanical runbook already exists in `docs/mainnet-publish-scope.md` (15 steps). I drive it with you when 5+6 are settled and you give the word. Rollback = flip `NEXT_PUBLIC_SUI_NETWORK` back to testnet (the published package just goes dormant).

---

## Fast-follows (not launch blockers — track, don't gate)

- **Yellow Card off-ramp** for CEMAC mobile-money cash-out — the top fast-follow (payout moment = off-ramp moment for a ROSCA). First question to the partner: native USDC on Sui support.
- **Coinbase Offramp** for diaspora USDC→bank.
- WhatsApp business-initiated templates (Meta approval) — the 24h-window sends work today.
- Client-signer sponsor endpoints (the server path already covers members; admins self-pay and hold SUI).
- Externalize rate-limit state past the first traffic spike.

---

## Where I can act vs where I can't

**I can drive:** all engineering (allowlist gate + fund caps, any redlines to legal copy, mainnet publish mechanics, sponsorship config verification), plus the redeploys and live verification for #1–#4.
**Only you can:** create the Sentry/Enoki/Stripe accounts and paste keys, run the browser 4242 checkout, engage counsel, choose the audit path, and authorize the mainnet publish.
