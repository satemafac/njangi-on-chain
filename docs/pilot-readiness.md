# Pilot readiness — blocker-by-blocker, fastest path to GTM

_2026-06-14. Strategy: **two-phase launch**. Phase 1 = testnet pilot on the live
Vercel app NOW (zero real-fund risk, none of the mainnet governance blockers).
Phase 2 = mainnet, after the pilot validates the product. This sequencing is the
fastest responsible route to real users._

Prod is live: **https://njangi-on-chain.vercel.app** (testnet, latest code, DB healthy).

---

## The big unlock: testnet pilot removes most blockers

Most "blockers" are **mainnet-only** (real money) or **revenue-only** (Stripe).
A testnet pilot lets you put the real product in front of real CEMAC users to
validate the funnel, WhatsApp, ramps (sandbox), and smart goals — while every
mainnet governance/audit item simply doesn't apply yet. Ship the pilot, learn,
then publish mainnet with confidence.

| # | Blocker | Applies to | Status / fix | Fastest-pilot recommendation |
|---|---|---|---|---|
| 1 | **Gas for onboarding** — no sponsorship; zkLogin users pay their own gas | Testnet **and** mainnet | Not wired (verified: no `sponsorTransaction` in code) | **Testnet:** add a small server-side faucet-drip on first login (or document "get testnet SUI"). **Mainnet:** wire Enoki sponsorship before public — it's the #1 onboarding friction for non-crypto CEMAC users. _This is the most important pilot UX item._ |
| 2 | **External contract audit** | Mainnet only | Internal adversarial review + 120 Move tests; fund-logic criticals verified fixed | Testnet pilot needs none. For mainnet: **capped allowlist pilot** (low per-circle caps, invited users) as controlled bug-bounty exposure — far faster than waiting on a paid audit. Commission the audit in parallel; it gates the move from allowlist → open public. |
| 3 | **Master-key custody** — AttestorCap + UpgradeCap on hot deployer | Mainnet only | N/A on testnet | Set up a Sui 2-of-3 multisig before the mainnet publish; publish from it or transfer immediately after bootstrap (runbook step 8). Needs your co-signers. |
| 4 | **`njangi_upgrade_cap` pin sequencing** | Mainnet publish mechanics | I handle in the runbook | No action — mechanical step at publish time (docs/mainnet-publish-scope.md step 6). |
| 5 | **Legal: ToS / Privacy / Risk** | Any real launch | Acceptance gate **built + live**; content is **DRAFT** (counsel placeholders) | **Testnet:** drafts + a prominent "Pilot / test network — no real funds" banner are fine. **Mainnet:** counsel sign-off + fill governing-law/company placeholders before real money. Send drafts to counsel now (parallel track). |
| 6 | **Money-in for CEMAC** | Any launch | RampPicker wired (Transak XAF), webhooks fixed | **Testnet:** ramps in sandbox/test mode, or crypto-in via faucet. **Mainnet:** real Transak (XAF) keys + `NEXT_PUBLIC_TRANSAK_ENABLED=true`. Decide: fiat-on-ramp at launch, or crypto-in-only with ramp as fast-follow. |
| 7 | **PII in git history** | Done | History scrubbed, 5 secrets rotated | ✅ closed. |
| 8 | **Enoki private key exposed client-side** | Any launch | Code now sources `ENOKI_API_KEY_*` server-side; `NEXT_PUBLIC_ENOKI_*` deprecated | **Do now (cheap):** rotate the key in the Enoki dashboard, set `ENOKI_API_KEY_TESTNET` (server-only) in Vercel, remove `NEXT_PUBLIC_ENOKI_TESTNET`. validate-env errors if a private key stays public. |
| 9 | **Stripe billing** | Revenue only | Built, off by default (`NEXT_PUBLIC_BILLING_ENABLED=false`) | Not a pilot blocker — pilot is free, every premium feature (incl. smart goals) is unlocked. Send Stripe the business-classification inquiry now; flip billing on post-pilot once approved. |
| 10 | **Meta WhatsApp approved templates** | Production notifications | Template mode built (`WHATSAPP_TEMPLATES_ENABLED`), off → freeform | Freeform works inside the 24h window for testing. Submit the templates (names in whatsapp-bot-backend/DEPRECATED.md) for approval now; flip on before relying on out-of-window business-initiated sends. |
| 11 | **Compliance gate (KYC) on/off** | Any launch | On-chain gate built + authoritative | **Testnet pilot:** advisory/off. **Mainnet CEMAC:** decide — partner-KYC-via-ramp + capped pilot may suffice initially; sanctions/travel-rule remain deferred (CEMAC-only scope). |
| 12 | **Observability** | Any launch | `/api/health` live; uptime cron live; Sentry no-op without DSN | Add `SENTRY_DSN` (free tier) for error visibility during the pilot — 5-min setup, high value for catching real-user breakage. |
| 13 | **Walrus PII blob renewal** | Any launch with WhatsApp links | Renewal cron built (daily) | Verify it's scheduled on Vercel (it is) before any WhatsApp link is created in the pilot. ✅ ready. |

---

## Phase 1 — testnet pilot checklist (fastest to real users)

Do these, then invite pilot users:
1. **Gas:** decide faucet-drip vs "bring testnet SUI" (blocker #1) — pick faucet-drip for a real consumer test.
2. **Pilot banner:** add a site-wide "Pilot on test network — funds are not real" notice (honest + sets expectations).
3. **Enoki key:** rotate + move server-side (#8) — do this regardless, it's a live secret exposure.
4. **Sentry DSN** (#12) — so you see what breaks.
5. **Ramps:** sandbox mode, or crypto-in-only for the pilot (#6).
6. Invite a small cohort; watch the funnel (signup → create circle → contribute → smart goal → payout → WhatsApp nudge).

Everything else (legal counsel, Stripe approval, Meta templates, audit, multisig)
runs as **parallel tracks** that don't block the testnet pilot but gate mainnet.

## Phase 2 — mainnet (after pilot validates)

Trigger when you're ready: the publish is fully scoped and de-risked
(empirical gas 0.68 SUI; deployer's 1.46 SUI is sufficient). Pre-reqs that must
land first: counsel sign-off (#5), multisig (#3), audit-or-capped-allowlist
decision (#2), real ramp keys (#6). Then run docs/mainnet-publish-scope.md
(publish → pin → bootstrap → cap transfer → env cutover → deploy → smoke).

---

## What I need from you to keep moving

- **Pick the pilot gas model** (faucet-drip recommended) — it's the one real UX gap.
- **Confirm ramp posture for the pilot** (sandbox ramp vs crypto-in-only).
- Kick off the parallel tracks on your side: **counsel** (legal drafts), **Stripe**
  (business inquiry), **Meta** (template submission), **Enoki** (key rotation).

I can build the faucet-drip, the pilot banner, and wire Sentry right now on your word.
