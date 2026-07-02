# CEX/DEX transfer funding strategy — supported assets on Sui

_2026-07-01. Multi-agent research (codebase capability, Sui asset landscape, live CEX API matrix, deposit UX) with adversarial verification; final rulings by the reviewer. Supersedes the fiat-ramp-first funding plan for launch; fiat ramps become a fast-follow._

## Decision

**Support exactly two user-facing assets: native Circle USDC (the savings/settlement asset) and SUI (gas + alternate deposit path). Accept a small set of swap-in assets (Sui Bridge USDT, wBTC/xBTC, ETH) that auto-convert to USDC via Cetus. Register nothing else.**

## Why USDC is the only viable settlement asset (verified)

- **CEX rails over the Sui network are near-universal for USDC and exist for NOTHING else.** Live public-API + official-doc verification (2026-07-01): Binance (dep+wd, since 2025-02-27, API-verified), Coinbase (since Oct 2024), OKX (Feb 2025), Bybit (Oct 2025, zero-fee), KuCoin, Gate.io, Kraken — all support USDC over Sui. Gaps: **Bitget has NO USDC-Sui rail** (live API), **MEXC** deposits only (withdrawals unconfirmed).
- **USDT does not exist on Sui from any exchange.** Tether does not issue on Sui; every major CEX's USDT chain list omits Sui. The on-chain "USDT" (`0x375f70cf…::usdt::USDT`) is Sui-Bridge-wrapped, CEX-unreachable, swap-input only (USDT/USDC pools do $3-5M/day at 0.001% fees — cheap conversion).
- **Liquidity:** USDC is ~$295M of Sui's ~$469M stablecoin float (~63%) and the universal quote asset. Deepest pair on the chain is SUI/USDC (multi-DEX, $10M+ aggregate).
- **No XAF/African-currency stablecoin exists on Sui** (confirmed against DefiLlama/GeckoTerminal/ecosystem announcements). XAF remains a display-conversion layer only.

## Rejected assets (with reasons — do not register)

| Asset | Verdict | Why |
|---|---|---|
| USDsui (Bridge/Stripe, $67M, #2 stable) | **Watchlist** | Credible issuer, growing fast — but 4 months old, no CEX Sui rails, no retail redemption. Revisit at 6-12 months peg history. |
| Sui Bridge USDT | Swap-input only | No CEX rails, bridge trust, no issuer redemption on Sui |
| FDUSD | Reject | $43M paper float but ~$52K real DEX depth; Apr 2025 depeg scare |
| AUSD (Agora) | Reject | Drained: $1.9M float, dust pools |
| USDY (Ondo) | Reject | Yield-drifting price breaks fixed-contribution accounting; **Reg S — restricted from US persons, conflicts with diaspora audience** |
| BUCK/USDB | Reject | CDP peg risk + **9 decimals** (breaks the 6-dp assumption at njangi_circles.move:1925-1930) |
| suiUSDe (Ethena) | Reject | Synthetic perp-basis dollar; wrong risk profile for community savings |
| wBTC/xBTC/LBTC/TBTC/ETH | Swap-input only | Volatility defeats the savings purpose; thin depth; custody trust varies |
| SUI as denomination | Reject (keep as gas) | −73% y/y; a SUI-denominated circle pays out less fiat value than contributed. Circles already default to USDC settlement. |

## The funding flows

**Cameroon (primary):** XAF → USDT on Binance P2P (live 2026-07-01: 62 buy/141 sell ads, MTN MoMo + Orange Money; OKX 89 ads, Bybit + Bitget thinner fallbacks) → convert USDT→USDC on-exchange (spot, ~free) → **withdraw USDC over the Sui network**. USDC P2P XAF is dead (1 ad) — the USDT→USDC on-exchange conversion step is mandatory in the guide.

**Diaspora (US/EU):** buy USDC on Coinbase/Kraken/Binance → withdraw over Sui directly. (Coinbase Offramp also gives diaspora a native USDC-on-Sui cash-out — see docs/mainnet-softbeta-ramp-compliance-review.md.)

**Alternate path (Bitget/MEXC/long-tail users):** withdraw SUI (supported essentially everywhere) → in-app auto-swap SUI→USDC via existing Cetus path, always auto-reserving ~0.2 SUI for gas.

**Cash-out mirror:** in-app send USDC → CEX deposit address (network=Sui, no memo/tag) → sell P2P XAF / bank. Sui's protocol-level **gasless stablecoin transfers** (mainnet ~May 2026; allowlist includes native USDC; plain transfers only, min 0.01) guarantee even a zero-SUI wallet can always move USDC out — but MUST live-test per-CEX crediting of address-balance-style transfers before defaulting to them; fallback is a sponsored ordinary transfer.

## The gas bootstrap problem & resolution

A fresh zkLogin address holding only USDC cannot execute ANY Move call (no sponsorship exists today; the in-app rescue swap itself needs gas; faucet is testnet-only). Gasless stablecoin transfers cover plain sends only — NOT contribute/join/claim.

**Resolution: enable Enoki sponsored transactions** for njangi-package Move calls only (contribute, join, claim_payout, advance_circle):
- Cost: Professional $120/mo = 100K sponsored txns (~fractions of a cent per member action); $0.001/txn overage.
- Server already holds the Enoki private key behind /api/zkLogin — trust model unchanged; add a session-authenticated `/api/zkLogin/sponsor` route.
- Abuse controls: Enoki portal move-call-target allowlist pinned to our package (never Cetus router targets), per-zkLogin-sub daily caps, portal budget cap, rate limits.
- **Pre-req: rotate the leaked NEXT_PUBLIC_ENOKI_* key first** (pending per memory) — it becomes a spend vector once sponsorship is on.
- Self-hosted sui-gas-pool / Shinami: revisit only past ~400-500K txns/month.

## Engineering punch list

1. **[CRITICAL — in flight, task_0753d930]** Replace Wormhole USDC mainnet defaults with native Circle USDC (`0xdba34672…::usdc::USDC`) in network-config.ts:117/136, constants.ts:21, wallet.ts:74; reconcile testnet coinTypes.USDC vs tokens.USDC mismatch (network-config.ts:70 vs 89); re-verify Cetus pool ids target native pairs. Without this, every CEX deposit of native USDC is invisible to balances and rejected by the escrow's exact-type check (njangi_cycle_escrow.move:461-462).
2. **Enoki sponsorship** (above). 
3. **Receive/Fund screen** (nothing exists today — no QR, no network warning, no arrival detection): QR + tap-to-copy zkLogin address, permanent "Send only USDC via the Sui network" line, per-CEX screenshot guides (Binance first) with min-withdrawal + fee shown, test-small-first two-step default, arrival watcher (poll `suix_getBalance` 5-10s on rpc-failover, success toast + WhatsApp notify), unexpected-coin-type detection (wormhole variants) with a recovery path instead of silent zero balance.
4. **Cash-out screen**: paste-only destination, first/last-4 checksum echo, "network = Sui, no memo" confirm, test-small default, P2P last-mile guidance (merchant ratings, confirm MoMo receipt before release).
5. **Keep swap-in**: existing SUI↔USDC CTAs + add USDT→USDC routing (pools configured, UI hardcodes SUI/USDC today — cetus-service.ts:38-40, contribute/index.tsx:2144-2586).
6. **AssetRegistry hygiene**: currently vestigial (only SUI seeded; nothing on the active money path consults it). When multisig lands, register USDC with its Pyth feed and treat the registry as the governance allowlist.
7. **Fee guidance**: steer "fund monthly, not per-contribution" (~1 USDC CEX withdrawal fee is 10% of a 10 USDC transfer).

## What does NOT need to change

- **Move contracts: zero changes.** Escrow is generic (`open_cycle_stable<T>`); USDC settlement is the default path for every new circle (auto_swap=false → USDC, circle-settlement.ts:38).
- Settlement-model refactor (on-chain settlement-coin field) is only needed for a THIRD asset — out of scope for launch.

## Compliance notes

- Dropping fiat ramps at launch removes the ramp-partner webhook/attestation surface from the critical path; CEX KYC happens at the exchange under its license.
- Keep CEX/P2P guides educational and disclaimed — COBAC's 2022 restriction targets regulated institutions; do not position the app as brokering P2P trades (aligns with deferred-compliance posture).
- Gasless-transfer fragility: allowlist "can change across protocol versions"; deprioritized under congestion — never make cash-out depend on it exclusively.

## Gas sponsorship — implementation & unit economics (shipped 2026-07-01)

The zero-SUI gas bootstrap is solved with **Enoki sponsored transactions**, billed to the **circle admin's Premium subscription** (per product decision — keep it in the subscription cost model).

**How it works (non-custodial):** the member still signs with their own zkLogin key; Enoki only supplies + pays for the gas coin. Sponsorship fires only when: the feature flag is on, the circle's on-chain admin holds a premium entitlement, the action's value is NOT drawn from `txb.gas` (USDC/stable paths only — a SUI contribution split from gas would spend the sponsor's coin), and the fair-use caps aren't exceeded. Any failure falls back to self-paid gas — a member is never blocked.

**Wired actions:** `contributeToCycleEscrow` and the USDC branch of `paySecurityDeposit` (the two actions a brand-new zero-SUI member hits). The allowlist (`SPONSORABLE_MOVE_FUNCTIONS`) also covers finalize/redeem, advance, recovery, and open_cycle_stable for future wiring. Cetus/swap targets are deliberately excluded.

**Code:** `src/lib/gas-sponsorship.ts` (policy + Postgres metering), `src/lib/gas-sponsorship-eligibility.ts` (admin-premium + circle resolution), `enokiZkLoginService.sendSponsoredTransaction`, `gas_sponsorship_usage` migration. Env: `GAS_SPONSORSHIP_ENABLED`, `GAS_SPONSORSHIP_DAILY_CAP_PER_USER` (30), `GAS_SPONSORSHIP_MONTHLY_CAP_GLOBAL` (100k).

**Unit economics for the subscription model:**
- Enoki Professional ≈ $120/mo base → ~100K sponsored txns + up to ~$100 SUI-equiv gas budget; overage ~$0.001/txn.
- Per member action gas ≈ 0.002–0.005 SUI → fractions of a US cent.
- A typical member does ~2 sponsored actions/cycle (join deposit once + monthly contribute). At $9.99/mo, one Premium admin running a 20-member circle generates ~20–40 sponsored txns/mo → well under a dollar of gas against $9.99 revenue. Gas sponsorship is a rounding error in COGS; the base Enoki platform fee is the real line item, amortized across all premium admins.
- Fair-use caps exist to stop a single circle from abusing the global budget; the Enoki portal budget cap is the hard backstop.

**Operator pre-flight before `GAS_SPONSORSHIP_ENABLED=true`:** rotate the leaked `NEXT_PUBLIC_ENOKI_*` key (now a spend vector); in the Enoki portal allowlist this package's move-call targets + set a monthly budget cap; run `npm run migrate:postgres` (adds `gas_sponsorship_usage`).

## Verification status

Live-API verified (Binance/KuCoin/Gate/Bitget network lists, Binance/OKX/Bybit/Bitget/KuCoin/MEXC P2P XAF books, GeckoTerminal pools, Sui RPC coin metadata) + official announcements for Coinbase/OKX/Bybit/Kraken. Independent skeptic pass confirmed: native USDC coin type, Binance USDC-over-Sui, and the May 2026 gasless stablecoin transfer feature. 7 of 10 skeptic re-checks were cut short by session limits — the unverified remainder all trace to primary sources (exchange APIs/official docs) already cited above.
