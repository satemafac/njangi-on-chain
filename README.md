<img width="1714" alt="Njangi On-Chain" src="https://github.com/user-attachments/assets/9e928b07-3395-4cc6-9e17-b7b2b7950742" />

# Njangi On-Chain

A **non-custodial rotational savings coordinator** for community savings circles
(*njangi* / *tontine* / ROSCA), built on the [Sui](https://sui.io) blockchain.
Members pool a fixed contribution each cycle and take turns receiving the pot.
Njangi coordinates the rotation, the escrow, and the notifications — but it never
takes custody of member funds and never moves money at an operator's discretion.

> Built for Cameroon and the wider CEMAC region. Sign in with a social account
> (zkLogin), no seed phrase or wallet extension required.

## What Njangi is

A *njangi* (also called a tontine or ROSCA — Rotating Savings and Credit
Association) is a time-tested community finance model: a group agrees on a fixed
contribution and a rotation order, everyone pays in each cycle, and one member
collects the full pot per cycle until everyone has had a turn.

Njangi On-Chain puts that model on Sui so the treasury is transparent and the
rules are enforced by code instead of a treasurer:

- **Non-custodial.** Funds sit in a per-cycle escrow object. No operator key can
  drain it; there is no admin "send funds to X" lever.
- **Permissionless payout.** When a cycle's contributions are in, *anyone* can
  trigger the payout, and the designated recipient pulls their own funds. The
  protocol never pushes money to an address chosen by an operator.
- **Member-initiated recovery.** Stuck or abandoned circles are recovered by
  members through on-chain liveness flows — again, no operator discretion.
- **Social login.** zkLogin (Google / Facebook / Apple) maps a social identity
  to a deterministic Sui address. The server holds no persistent ephemeral key
  material.
- **WhatsApp coordination.** Opt-in "it's your turn" nudges via WhatsApp. Routing
  data (phone number) is AES-256-GCM encrypted off-chain on Sui Walrus; only an
  opaque blob pointer is anchored on chain — never plaintext PII.

## How it works

```
Create circle → members join → each cycle: members contribute to escrow
   → cycle fills → permissionless trigger → recipient claims (pull) → rotate
   → final cycle → security deposits released via member recovery / refund paths
```

1. **Create a circle.** The creator sets the contribution amount, member count,
   rotation order, and cycle duration.
2. **Join.** Members join and post a security deposit held in a per-circle wallet
   that no operator can drain.
3. **Contribute.** Each cycle, members deposit the fixed amount into the cycle
   escrow before the deadline.
4. **Trigger + claim.** Once the cycle is funded, the payout is *permissionless* —
   anyone can trigger it, and the cycle's recipient pulls (claims) the pot to
   their own address. There is no automatic, operator-pushed transfer.
5. **Rotate.** The circle advances to the next recipient.
6. **Refund & recovery paths.** Security deposits and any unclaimed balances are
   returned through member-initiated recovery and refund flows, not by admin
   action.

Contract sources live in [`move/sources/`](move/sources/):
`njangi_circles.move` (lifecycle/rotation), `njangi_cycle_escrow` (per-cycle
escrow), `njangi_payments.move` (permissionless `trigger_payout` + recipient-pull
`claim_payout`), `njangi_custody.move` (custody primitives, package-internal fund
movement only), `njangi_price_validator.move` (exact-type asset registry),
`njangi_compliance.move` (attestations), and `whatsapp_integration.move` (Walrus
PII anchors).

## Plans

| Tier | Price | Highlights |
| --- | --- | --- |
| **Free** | $0 | Up to 1 circle, 3 members per circle, core escrow / contribute / claim / recovery flows. |
| **Premium** | $9.99/mo | Unlimited circles & members, WhatsApp notification suite, smart-goals & milestones, priority coordination features. |

Billing is a SaaS subscription on **coordination features only** — Njangi never
charges a fee on fund flows. Contribute / claim / payout / recovery actions are
never gated behind payment; gating one's access to their own escrowed funds would
undermine the non-custodial posture.

## Tech stack

- **Smart contracts:** Move on Sui (per-cycle escrow, permissionless payouts,
  member recovery, on-chain compliance attestations).
- **Frontend:** Next.js (Pages Router) + TypeScript + Tailwind, deployed on
  Vercel.
- **Auth:** zkLogin via the Enoki service (server-side salt / zkProof /
  signing boundary at `/api/zkLogin`).
- **PII storage:** AES-256-GCM envelopes on Sui Walrus; only blob pointers
  anchored on chain (`src/lib/walrus-pii.ts`).
- **Database:** Sui is the source of truth for all financial state. Postgres
  (Neon in production) holds only off-chain coordination data — join requests,
  UI preferences, the WhatsApp routing index, and compliance references.
- **Fiat ramps:** Partner-led hosted widgets (Coinbase Onramp, MoonPay, Transak).
  Njangi never settles fiat directly; ramps run KYC/AML under their own licenses.
- **Swaps:** Cetus is used only for non-custodial token swaps when a member needs
  to convert an asset into the circle's contribution currency.

## Quickstart

Prerequisites: Node 18+, the [Sui CLI](https://docs.sui.io/references/cli)
(v1.0+), Docker (for local zkLogin prover services), and a Postgres database
(local or Neon).

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env.local
#    Fill in at minimum: NEXT_PUBLIC_SUI_NETWORK, NEXT_PUBLIC_*_PACKAGE_ID,
#    DATABASE_URL, ZKLOGIN_SECRET, WALRUS_PII_MASTER_KEY, INTERNAL_NOTIFY_SECRET.
#    See .env.example for the full annotated list. Generate the random secrets:
npm run generate:secrets

# 3. Create the application tables (idempotent; safe on fresh or existing DBs)
npm run migrate:postgres

# 4. (Optional) Start local zkLogin prover services
docker-compose up -d

# 5. Run the dev server
npm run dev          # http://localhost:3000
```

Useful checks:

```bash
npm run validate:env            # confirms required env for the active network
npm run validate:move-network   # Move.toml matches the canonical network config
npm run lint
npm run build
```

Move contracts:

```bash
cd move && sui move build       # build
cd move && sui move test        # unit tests
cd move && ./build_and_test.sh  # build + publish + bootstrap (interactive)
```

## Deploy (Vercel)

The app deploys to **Vercel**; production Postgres is **Neon**.

1. **Database.** Provision a Neon Postgres database and set `DATABASE_URL`
   (Neon URLs include `?sslmode=require`). Run `npm run migrate:postgres`
   against it before the first deploy.
2. **Environment.** Set the env vars from `.env.example` in the Vercel project.
   Server-only secrets (`ZKLOGIN_SECRET`, `WALRUS_PII_MASTER_KEY`,
   `INTERNAL_NOTIFY_SECRET`, `CRON_SECRET`, `ENOKI_API_KEY_*`, ramp secrets)
   must be set without the `NEXT_PUBLIC_` prefix so they stay off the client
   bundle.
3. **Cron jobs.** [`vercel.json`](vercel.json) registers the scheduled functions
   Vercel runs on a timer. Each authenticates with `CRON_SECRET` via a
   timing-safe bearer check:
   - `/api/cron/cycle-finalized` — dispatches "it's your turn" WhatsApp nudges
     as new cycles finalize.
   - `/api/cron/whatsapp-circle-events` — relays circle lifecycle events to
     WhatsApp.
   - `/api/cron/walrus-renewal` — renews Walrus PII blobs before they expire
     (daily; tune with `RENEWAL_THRESHOLD_EPOCHS`).
4. **Build & ship.** Vercel runs `next build`. The active Sui network is set by
   `NEXT_PUBLIC_SUI_NETWORK`.

The full annotated publish runbook (Move publish, bootstrap, smoke tests) lives
in [`CLAUDE.md`](CLAUDE.md).

## Contract addresses

The app defaults to **testnet**. Mainnet is not yet published from the current
branch (the Phase 1 escrow + compliance + WhatsApp module set has only shipped to
testnet); mainnet env vars are placeholders until a fresh mainnet publish.

| Network | Package ID | Status |
| --- | --- | --- |
| Testnet | `0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02` | Active (current module set) |
| Mainnet | — | Not yet published from this branch |

Source of truth: [`move/Published.toml`](move/Published.toml). Object IDs minted
at publish time (registries, AttestorCap, asset registry) are captured into
`.env.local` by the bootstrap step.

## Documentation

- [Deployment guide](docs/deployment-guide.md)
- [Environment configuration](docs/environment.md)
- [WhatsApp integration setup](docs/whatsapp-integration-setup.md)
- [Secure storage with Enoki / Walrus](docs/secure-storage-with-enoki.md)
- [Coinbase Onramp setup & operations](docs/coinbase-onramp-setup-operations.md)
- [Move contracts](move/README.md)
- [GTM readiness review](docs/gtm-readiness-review-2026-06-12.md)

## Support

Questions or issues: see the support address in the app footer (configurable via
`NEXT_PUBLIC_SUPPORT_EMAIL`), or open a GitHub issue.
