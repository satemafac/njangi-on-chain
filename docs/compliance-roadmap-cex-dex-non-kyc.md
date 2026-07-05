# Compliance Roadmap — CEX/DEX-Funded, Non-KYC Model

_Last updated: 2026-07-05. Owner: founder. Companion docs:
[counsel-brief.md](counsel-brief.md) (the ask to counsel),
[cex-transfer-asset-strategy.md](cex-transfer-asset-strategy.md) (funding
model), [gtm-readiness-review-2026-06-12.md](gtm-readiness-review-2026-06-12.md)._

This is the plan for **becoming and staying compliant** while operating the
launch model: users fund wallets by transferring USDC/SUI from centralized
exchanges (with DEX swaps via Cetus routing for asset conversion), **no
user-facing KYC**, actively marketed to US/EU/UK diaspora and the
Cameroon/CEMAC home market.

Not legal advice. Every item marked **[counsel]** goes into the engagement
described in `counsel-brief.md`.

---

## 0. The position we defend (and its load-bearing walls)

Our compliance posture is a single sentence:

> **Njangi On-Chain is non-custodial coordination software. It never holds
> or moves user funds, never touches fiat, and never takes a fee from a
> fund flow — so it is not a money transmitter (US), not a CASP (EU MiCA),
> and not an FCA-registrable cryptoasset firm (UK).**

We do **not** argue "our users are KYC'd because they came from a CEX."
Exchange KYC discharges the exchange's obligations, not ours, and we cannot
verify it on-chain. Our position is that we have **no KYC obligation**,
because we are outside the obliged-entity perimeter entirely.

That position rests on five invariants. Breaking any one of them collapses
the whole posture and triggers a full re-analysis:

| # | Invariant | What would break it |
|---|-----------|---------------------|
| 1 | **No custody.** Funds live in per-cycle smart-contract escrow; payouts are permissionless (`trigger_payout`/`claim_payout`); recovery is member-initiated. No operator key can move funds. | Any admin/operator function that can direct funds; a hosted wallet; holding keys server-side. |
| 2 | **No fiat.** Funding is CEX transfer; fiat ramps, when enabled, are partner-hosted under partner licenses. | Operating our own on/off-ramp; settling fiat; agent-of-payee arrangements. |
| 3 | **No fees on fund flows.** Revenue is the coordination SaaS subscription (Stripe, billed to admins). | Taking any percentage/spread/fee from contributions, payouts, swaps, or gas sponsorship recovery from the pot. |
| 4 | **No yield / investment features.** The yield module was retired in the Phase 1 redesign. Contributions rotate among members; nobody earns from anyone else's effort. | Reintroducing NAVI/vault deposits, staking idle pots, "grow your savings" features — instant securities/MiCA analysis event. |
| 5 | **DEX routing is client-side and neutral.** Cetus is used for member-initiated swaps only; we never take positive slippage or routing fees. | Server-side swap execution, a routing fee, or an embedded market-making position. |

**Rule: any PR that touches money movement gets checked against this table
before merge.** This table also goes verbatim into the counsel brief.

---

## Phase A — Become compliant (pre-mainnet blockers)

Everything here completes **before mainnet carries real funds**. Estimated
total: ~2 engineer-weeks part-time + one external counsel engagement.

### A1. Sanctions program (OFAC) — eng, ~2 days ✅ highest priority

The one obligation that applies regardless of custody status, with strict
liability and heavy US nexus (US users, Stripe, Vercel). Cameroon is not
sanctioned — the core corridor is clean — so this is hygiene, not a
business threat.

- [ ] **SDN address screen.** Server-side check of wallet addresses against
      OFAC's published SDN crypto-address list at the three entry choke
      points: circle create, circle join, WhatsApp admin link. Refuse with a
      themed, non-accusatory message ("This wallet can't use Njangi
      On-Chain"). List cached in Postgres.
- [ ] **List refresh cron.** New `/api/cron/sanctions-refresh` (weekly)
      following the existing `vercel.json` cron pattern (CRON_SECRET bearer
      auth, same as `attestation-expiry`).
- [ ] **Embargoed-jurisdiction geo-block.** Extend `src/middleware.ts` using
      Vercel geo headers: block IR, KP, SY, CU, and RU-occupied UA regions
      from app routes (marketing pages can stay visible). Log blocks.
- [ ] **ToS representation.** User affirms they are not an SDN party and not
      in an embargoed jurisdiction (goes in the legal-gate ToS, see A2).
- [ ] **Audit trail.** Screening results logged to Postgres (address, list
      version, result, timestamp) — this is the evidence the program exists.
- [ ] **One-page internal program doc** (`docs/sanctions-program.md`): what
      we screen, when, list source, refresh cadence, escalation on a hit
      (freeze nothing — we can't — but refuse service and document).

### A2. ToS / disclosures hardening — copy + eng, ~1 day

Drafts already exist in `docs/legal-drafts/` (EN+FR) and the legal-gate
enforcement shipped in `6e64df0`. Verify the served documents at
`/legal/[doc]` explicitly state:

- [ ] Not a bank; not deposit-taking; no FDIC/FSCS/deposit-guarantee cover.
- [ ] Not a money transmitter / VASP / CASP; non-custodial software; the
      operator cannot access, freeze, or recover funds.
- [ ] Users are responsible for local tax and legal obligations.
- [ ] Sanctions/eligibility representations (from A1).
- [ ] Smart-contract, key-loss, and stablecoin depeg risk disclosures.
- [ ] Right to refuse/terminate service (the lever regulators expect us to
      have and use on notice).

### A3. Marketing vocabulary standard — copy, ~1 day

Characterization risk lives in copy, not code. ROSCAs are legal, but the
wrong nouns invite banking/investment characterization.

- [ ] **Banned in all user-facing copy:** interest, returns, yield, deposit
      (as a noun for the pot), savings account, invest(ment), guaranteed,
      earn.
      *(Note: "security deposit" for the on-chain collateral is a distinct,
      accurate term — keep it, but never describe the rotating pot as a
      "deposit.")*
- [ ] **Approved framing:** rotating savings group / njangi / tontine,
      "your circle's own money," coordination software, schedule, payout
      turn.
- [ ] Sweep: landing page, /learn/*, /faq, OG share cards, WhatsApp message
      templates, App Store/Play copy when it exists.
- [ ] Add `npm run check:copy` — a CI grep of marketing pages for the banned
      list, so the standard survives future copywriting. (Cheap, keeps us
      honest.)

### A4. GDPR / UK-GDPR hygiene — eng + ops, ~2–3 days

Marketing to EU/UK makes this real. Architecture is already favorable
(minimal PII: optional WhatsApp number, AES-256-GCM encrypted on Walrus,
opaque on-chain pointer only).

- [ ] Privacy policy (drafted in `docs/legal-drafts/`) matches **actual**
      data flows: WhatsApp number → Walrus (encrypted) + Postgres index;
      zkLogin salt handling; Stripe billing data; Vercel/Neon hosting.
- [ ] End-to-end test of the deletion flow (`/legal/data-deletion` +
      backing API): confirm it removes the Postgres index row AND lets the
      Walrus blob expire (no renewal after deletion — check
      `walrus-renewal` cron exclusion).
- [ ] Records of Processing (one page, internal).
- [ ] DPA inventory: Vercel, Neon, Stripe, Meta/WhatsApp BSP — link each
      provider's standard DPA.
- [ ] **[counsel]** Whether an EU/UK Article 27 representative is required
      at our scale, or defensibly deferred.

### A5. UK financial promotions posture — ops decision now, counsel before spend

The sharpest marketing-specific rule: since 2023, promoting cryptoasset
activity to UK consumers without an approved promotion is a criminal
offence, and it reaches offshore firms.

- [ ] **Policy now:** product remains available to UK users; **no paid
      UK-targeted marketing** (ads, influencer spend, UK-specific landing
      pages) until counsel signs off the finprom analysis.
- [ ] **[counsel]** Is a ROSCA coordination app promoting "qualifying
      cryptoasset" activity at all? If yes, which exemption or approval
      route fits.

### A6. Counsel engagement — external, start now (longest lead time)

`docs/counsel-brief.md` is written. Extend its question list with:

- [ ] US: confirm non-MSB analysis under FinCEN 2019 guidance for this
      exact model (CEX-funded, subscription revenue, no fund-flow fees).
- [ ] NY BitLicense footnote: do we need to avoid targeting NY?
- [ ] UK finprom question (A5).
- [ ] EU: confirm MiCA CASP exclusion for non-custodial software given
      active diaspora marketing.
- [ ] CEMAC/COBAC/OHADA: tontine-practice reading for the home market.
- [ ] GDPR representative question (A4).

**Gate: mainnet does not take real family money before the opinion letter
lands.** (Consistent with the existing testnet-pilot-first policy.)

---

## Phase B — Stay compliant (operating cadence)

Recurring obligations once live. Total steady-state cost: ~2 hours/month
plus automated jobs.

| Cadence | Task | Owner |
|---------|------|-------|
| Weekly (automated) | Sanctions list refresh cron; alert on any screen hit | eng (cron) |
| On every money-touching PR | Check against the §0 invariants table | reviewer |
| Monthly | Review screening-hit log + geo-block log; confirm crons green | founder |
| Monthly | Marketing copy check (`npm run check:copy` runs in CI anyway) | CI |
| Quarterly | Corridor matrix review (§D): any new market being marketed? Any regime change (MiCA guidance, FCA updates, FinCEN rulemaking)? | founder |
| Quarterly | Data-deletion flow smoke test | eng |
| Annually | Refresh counsel letter if product surface changed; review DPAs | founder |

**Operational levers inventory** (things we can do when put on notice, and
document that we did):

1. Refuse/terminate service (ToS right, A2) — the primary lever.
2. Attestation gate (`open_cycle_*_with_gate`) — battle-tested 2026-07-04;
   can be flipped per-circle today, per-corridor with ~1 week of work.
3. Geo-blocking (middleware) — extensible to any jurisdiction in hours.
4. WhatsApp/notification suspension — separable from on-chain access.

**Abuse/inquiry playbook** (write once, ~half a day):

- [ ] `docs/incident-playbook.md`: what to do on (a) an OFAC screen hit,
      (b) a law-enforcement/regulator contact, (c) a takedown/complaint
      about a specific circle. Core sequence: acknowledge, don't improvise,
      call counsel, use levers, document everything. We cannot freeze funds
      — say so early and accurately in any response.

---

## Phase C — Triggers that change the posture

The "if this, then that" map. Each row is a tripwire; none of them are
today's work.

| Trigger | Required response |
|---------|-------------------|
| Any feature that takes custody, touches fiat, or fees a fund flow | **Stop.** Full §0 re-analysis + counsel before build. Default answer is "don't build it." |
| Yield/staking/"grow your pot" feature request | Securities/MiCA analysis event. Same as above. |
| Paid UK marketing wanted | A5 counsel sign-off first. |
| A regulator, bank, or partner (Stripe, ramp, CEX) demands KYC for a corridor | Flip the lever: attestation gate mandatory for that corridor + build the self-serve IDV flow (Smile ID class provider → webhook → server-side `njangi_compliance::issue`; requires moving the AttestorCap off the CLI wallet to an ops signer). ~2–3 weeks. Scoped, not started. |
| Aggregate monthly on-chain flow exceeds ~$1M-equivalent | Counsel check-in; revisit whether scale changes any analysis (e.g., MAS-style small-scale thresholds elsewhere). |
| Fiat ramps re-enabled (Coinbase/MoonPay/Transak) | Confirm partner agreements put KYC/AML squarely on the partner; update ToS + privacy policy; no change to our perimeter if hosted-widget model is kept. |
| Marketing into a NEW jurisdiction (SG, CA, AU, CH…) | Add to corridor matrix; 1-page regime scan before spend. |
| EU MiCA level-2 guidance narrows the software exclusion | Reassess CASP question with counsel. |
| An SDN hit or embargoed-jurisdiction pattern in logs | Incident playbook; document refusal; counsel if recurring. |

---

## D. Corridor matrix (living table — review quarterly)

| Corridor | Product available | Active marketing | Controls active | Notes |
|----------|-------------------|------------------|-----------------|-------|
| Cameroon / CEMAC | ✅ | ✅ | Sanctions screen, ToS gate | Home market; tontine practice recognized; funding via Binance P2P → USDC transfer |
| US diaspora | ✅ | ✅ (post-A1/A2) | Sanctions screen, ToS gate, vocabulary standard | Non-MSB posture **[counsel]**; avoid NY targeting until footnote answered |
| EU diaspora | ✅ | ✅ (post-A4) | + GDPR hygiene | MiCA software exclusion **[counsel]** |
| UK diaspora | ✅ | ⛔ paid marketing held | + finprom hold | Organic availability OK; paid promotion gated on A5 |
| Embargoed (IR, KP, SY, CU, occupied UA) | ⛔ geo-blocked | ⛔ | Middleware block + ToS rep | A1 |
| Everywhere else | ✅ (passive) | ⛔ until scanned | Sanctions screen, ToS gate | 1-page scan before any targeted spend |

---

## E. What we deliberately do NOT do (and why that's the point)

For the next person who asks "where's the KYC?":

- **No user KYC / IDV** — we are not an obliged entity; identity collection
  would add risk (PII honeypot) without adding a legal defense we need.
- **No travel rule capture** — applies to VASPs/CASPs; we are neither.
- **No formal AML transaction-monitoring program** — same reason. We keep
  informal internal red-flag awareness (unusual circle sizes/velocity in
  existing Postgres/event data) because having levers and demonstrably
  reasonable behavior is cheap; a formal program would imply obligations we
  don't have.
- **No custody, ever** — see §0.

The attestation stack (compliance gate + `njangi_compliance` + issuance
console) stays in the codebase, off by default: it is the pre-built lever
for the day a corridor demands gating, and a future premium trust feature
("verified circles") — not a launch requirement.

---

## F. Sequencing summary

```
Now ──────────────► Mainnet cut ──────────────► Steady state
 A6 counsel (start immediately — longest lead)
 A1 sanctions program (2 days, eng)     ┐
 A2 ToS hardening (1 day)               ├─ all block mainnet
 A3 copy standard + CI check (1 day)    │
 A4 GDPR hygiene (2–3 days)             ┘
 A5 UK marketing hold (policy: in force from today)
                                         B cadence begins at launch
                                         C triggers monitored continuously
```
