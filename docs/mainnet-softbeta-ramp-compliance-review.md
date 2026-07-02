# Mainnet soft-beta readiness — ramp & compliance review

_2026-07-01. Two-model-route review: worker audits (deepseek-v4-pro) over the full ramp + compliance surfaces, findings adversarially verified against current sources and live prod probes. Final verdicts are the reviewer's (Claude), not the workers'._

## Verdict

**CONDITIONAL GO for a hard-capped, allowlisted mainnet soft beta — with one strategic gap the user must decide on: the product has NO off-ramp, and no current partner can off-ramp Sui-network assets for CEMAC users.** The on-ramp layer and the on-chain compliance gate are in materially better shape than the June scoping docs assumed (the former webhook/geo blockers are verified fixed). The remaining blockers are operator config, key custody, counsel sign-off, and a handful of small eng hardening items.

## Off-ramp reality (the headline)

The entire ramp surface is **buy-only** — verified: no sell/off-ramp code exists in any provider service, API route, or UI (`productsAvailed` is hardcoded `'BUY'` at `transak-service.ts:106`; the `'SELL'` union member is interface-only).

External capability check (2026-07):

| Provider | Off-ramp exists | Sui network | CEMAC/XAF payout | Notes |
|---|---|---|---|---|
| MoonPay Sell | Yes | **NO** — BTC/ETH/XRP/TRX/SOL + EVM chains only | No | Dead end for Sui assets |
| Transak Off-Ramp | Yes (64+ countries) | **NO** — "40+ cryptos across 4 major chains" | Unconfirmed, unlikely | Dead end for Sui assets |
| Coinbase Offramp | Yes (zero-fee USDC) | **YES — native USDC on Sui** (Slush wallet precedent) | **NO** — requires full Coinbase account + linked bank; US/EU-centric geos | Serves the **diaspora** side only |
| Yellow Card | Yes (20 African countries incl. Cameroon) | **UNCONFIRMED** — USDC on "30+ blockchains", Sui not listed | **YES** — MTN MoMo / Orange Money / bank, licensed, widget + API | The CEMAC candidate; must verify Sui support with partner |

**Recommended two-sided strategy:**
1. **Launch (Phase A):** ship mainnet with on-ramp only + self-custody crypto-out (wallet withdraw already exists). Add in-app cash-out guidance: diaspora → Coinbase Offramp (USDC-on-Sui, reuses existing CDP keys/session infra — moderate build); CEMAC → documented CEX path (e.g. Binance P2P XAF) until a native rail lands. Do NOT market "cash out to mobile money" at launch.
2. **Fast-follow (Phase B):** open a Yellow Card partner conversation now (widget or Payments API). First question: native USDC on Sui support. If unsupported, options are (a) wait for support, (b) swap/bridge hop (adds custody+complexity — not recommended), (c) their supported-chain USDC via a user-visible bridge step.
3. **Strategic note:** in a rotational-savings product the payout moment IS the off-ramp moment. For CEMAC recipients this gap hits the core value loop — prioritize Phase B right after beta stabilizes.
4. USDC becomes the load-bearing asset for off-ramp: **pin `NEXT_PUBLIC_MAINNET_USDC` to native Circle USDC explicitly** — code silently defaults to wormhole-legacy if unset (`network-config.ts:117`), which Coinbase Offramp will NOT accept.

## What is verified READY (my own spot-checks, not worker claims)

- **Webhook integrity (former June blockers — FIXED):** Coinbase verifies HMAC over the raw body with `timingSafeEqual`, fails closed 503 on missing secret (`api/onramp/coinbase/webhook.ts:107-176,277-324`); MoonPay v2 signature with 5-minute replay window (`moonpay-service.ts:120-155`); Transak fail-closed JWT verify with `exp` (`transak-service.ts:159-206`).
- **Geo routing wired:** CEMAC → [transak, moonpay] in XAF (`ramp-geo.ts:77-78,150-151`); RampPicker live in dashboard + contribute (no longer dead code).
- **On-chain compliance gate EXISTS (worker false-positive corrected):** per-circle `requires_attestation` (`njangi_circles.move:783,840`), cannot be disabled after members join, escrow paths pin the exact `ComplianceConfig` object + issuer, enforce revocation/expiry (`njangi_cycle_escrow.move:303-323`), legacy path blocked when gated (`njangi_circles.move:2126`). Gate is **opt-in per circle** — the accepted CEMAC posture per the deferred-gaps decision (2026-04-28); mandatory gating remains a pre-regulated-markets item.
- **Secrets:** no server secret carries `NEXT_PUBLIC_`; signed URLs and Coinbase session tokens are server-side only.
- **Legal acceptance:** Postgres append-only, (sub,aud)-bound, IP-hashed, refuses in-memory in prod; `/api/legal/doc` traced into the lambda and verified 200 live.
- **Fund-access invariant holds:** no fund flow is gated on subscription; billing stack sandbox-verified.

## Blockers before real money (P0)

| # | Owner | Item |
|---|---|---|
| 1 | user | **Audit decision:** third-party Move audit vs hard-capped allowlist beta (per mainnet-publish-scope). Recommend: allowlist ≤15 users, per-circle fund caps, treat beta as bounded exposure; commission the audit in parallel before public open. |
| 2 | both | **Master-key custody:** AttestorCap + UpgradeCap → multisig, with the `mainnet.toml` upgrade-cap pin replaced immediately post-publish (runbook steps 6/8 — sequencing is load-bearing). |
| 3 | user | **Counsel sign-off** on ToS/Privacy/Risk (6 placeholders open) + remove DRAFT banner. Hard gate for real-money users. |
| 4 | user | **Enable money-in:** Transak production XAF keys (prod probe 2026-07-01: all three providers still disabled, even sandbox). Confirm partner account covers Cameroon/XAF. |
| 5 | eng | **Narrow the legal-gate exemption:** `/circle/*` is fully exempt (`legal-acceptance.ts:89-95`), so a deep-linked user can contribute without ever accepting terms. Keep recovery/claim exempt (funds must never lock); require acceptance on contribute/join. Small fix, big compliance-defensibility win. |
| 6 | user | **Sentry DSN** — still a no-op; unacceptable blind spot with real money. |
| 7 | eng | **Pin native USDC** (`NEXT_PUBLIC_MAINNET_USDC`) — see off-ramp section. |

## Hardening (P1 — small eng items from this review, verified real)

1. **OFAC jurisdiction blocklist** in `providerOrderForCountry` + all three session endpoints (IR/KP/CU/SY + Crimea). Currently zero jurisdiction blocking; cheap, defensible, and RampPicker already renders an empty provider list gracefully.
2. **Transak JWT `alg` allowlist** — manual verify doesn't check the JOSE header (`transak-service.ts:172-182`). Current length-check incidentally blocks `alg:none`, but pin `HS256` explicitly.
3. **Remove `INTERNAL_NOTIFY_SECRET` fallback** in `compliance-auth.ts:14-16` — one line; stops the notify secret from granting compliance-API access.
4. **Fix `options.ts` client-IP detection** (`options.ts:101-104` uses socket IP only) — on Vercel every request shares the proxy IP, so per-IP/per-wallet rate limiting is one shared bucket. Reuse `session.ts`'s forwarded-header logic.
5. **Coinbase webhook replay:** no timestamped signature scheme; dedupe store is the only defense — confirm it's Postgres-backed in prod and alert on registration failures.
6. **Attestation expiry cron** — auto-nudge before expiry instead of the manual console "stale list" flow (expired attestation mid-cycle blocks a member's contribution window).
7. **Consolidate the 4× duplicated CORS/security-header logic** in the onramp routes; `options.ts` uses `private, max-age=60` while the rest use `no-store`.

## Explicitly deferred for CEMAC (re-confirmed, unchanged from 2026-04-28 decision)

Protocol-layer sanctions screening, travel rule capture, AML velocity monitoring, mandatory (non-opt-in) compliance gate, queue case-ID hashing, gate-decision audit logging. All remain pre-conditions for EU/UK/US/SG — none newly blocks the CEMAC beta.

## Worker findings REJECTED after verification (do not act on)

- "Coinbase defaults to sandbox API" — **false**; `api.developer.coinbase.com` is the production CDP host and `pay.coinbase.com` the production widget.
- "No on-chain compliance enforcement / no per-circle gating" — **false**; misled by the stale `compliance-gate.ts:17-19` comment (cleanup task spawned).

## Sequence

1. User decisions: audit-vs-allowlist, beta caps, multisig signer set (this week).
2. Eng P0 #5/#7 + P1 #1-#4 (≈1 day) → testnet deploy → smoke.
3. User: counsel sign-off, Transak production keys, Sentry DSN, Coinbase Offramp partner check + Yellow Card outreach.
4. Mainnet publish per runbook (explicit user authorization required — publish behind the allowlist).
5. Real-money dogfood with small amounts → open the allowlist gradually.
