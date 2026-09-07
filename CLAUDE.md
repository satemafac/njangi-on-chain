# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Compliance invariants (check EVERY money-touching PR)

The legal posture ("non-custodial coordination software" — see
`docs/compliance-roadmap-cex-dex-non-kyc.md` §0) rests on five invariants.
A PR that breaks one is a regulatory event, not a feature:

1. **No custody** — no operator/admin function may direct user funds.
2. **No fiat** — funding is CEX transfer or partner-hosted ramps only.
3. **No fees on fund flows** — revenue is the coordination SaaS
   subscription, never a cut/spread on contributions, payouts, or swaps.
4. **No yield/investment features** — the yield module was retired;
   "grow your pot" features require counsel review BEFORE design.
5. **Neutral DEX routing** — member-initiated swaps only, no routing fee.

Also: user-facing copy must pass `npm run check:copy` (no
interest/returns/yield vocabulary — enforced in preflight), and the OFAC
screen (`src/lib/sanctions.ts`, `docs/sanctions-program.md`) must stay
default-ON.

## Development Commands

### Move Smart Contracts
```bash
# Build contracts
cd move && sui move build

# Run tests
cd move && sui move test

# Build and publish (interactive script)
cd move && ./build_and_test.sh

# Build only (skip publishing)
cd move && ./build_and_test.sh --build-only
```

### Frontend Development
```bash
# Development server with Turbopack
npm run dev

# Production build
npm run build

# Start production server
npm start

# Linting
npm run lint
```

### zkLogin Services (Docker)
```bash
# Start zkLogin prover services
docker-compose up -d

# Alternative: Local zkLogin services
./start-zklogin-services.sh
```

## Architecture Overview

### Core System Integration
This is a **non-custodial rotational savings coordinator** built on Sui blockchain.
Phase 1 ships three subsystems:

1. **zkLogin Authentication**: Social OAuth (Google/Facebook/Apple) → zkProofs → Sui addresses via Enoki service. Server holds no persistent ephemeral key material.
2. **Move Smart Contracts**: Per-circle escrow + permissionless `trigger_payout`/`claim_payout`. No admin discretionary fund movement; member-initiated recovery only.
3. **Partner-led fiat ramps**: Coinbase Onramp, MoonPay, and Transak hosted widgets. Njangi never settles fiat directly.

### Key Components

**Move Contracts (move/sources/)**:
- `njangi_core.move`: Time utilities, decimal scaling, currency conversion
- `njangi_circles.move`: Circle lifecycle, rotation logic, treasury management
- `njangi_payments.move`: Permissionless `trigger_payout` + recipient-pull `claim_payout<T>`
- `njangi_custody.move`: Wallet primitives; only package-internal code can move funds
- `njangi_price_validator.move`: Exact-type AssetRegistry; no substring oracle matching
- `whatsapp_integration.move`: On-chain anchors for Walrus-encrypted PII (no plaintext)

**Frontend Services (src/services/)**:
- `enokiZkLoginService.ts`: zkLogin auth + zkProof-backed transaction signing
  (no gas sponsorship today — the user's own zkLogin account pays gas; the
  Enoki private key is used only server-side for salt/zkProof, behind
  `/api/zkLogin`)
- `coinbase-onramp-service.ts`, `moonpay-service.ts`, `transak-service.ts`: Fiat ramp adapters
- `whatsapp-registry-service.ts`: Off-chain index for the on-chain Walrus pointers

**PII Storage**:
- `src/lib/walrus-pii.ts`: AES-256-GCM encrypts WhatsApp routing data and uploads
  to Sui Walrus. Only the resulting blob ID + opaque nonce are anchored on chain.

### Transaction Flow Pattern
```
Frontend → zkLogin API (/api/zkLogin) → Move Contract → Event Parsing → UI Updates
```

### Development Workflow Rules

**Move Contract Development**:
- Always `cd move` before building/testing contracts
- Use `./build_and_test.sh` for comprehensive build/publish/test cycle
- Package ID updates automatically sync to `.env.local` as `NEXT_PUBLIC_PACKAGE_ID`
- Never hand-edit `move/Move.toml` — it is a copy of `move/config/{testnet,mainnet}.toml`.
  Switch networks with `bash move/scripts/switch-network.sh {testnet|mainnet}` and
  verify the active manifest with `npm run validate:move-network` (CI guard).
- **Package lineage**: object TYPES stay pinned to the ORIGINAL package id
  (testnet `0x89cddf4d…`); CALLS and `devInspect` must target the LATEST
  version (`NEXT_PUBLIC_TESTNET_PACKAGE_ID`). The authoritative "what is live"
  is the UpgradeCap `0xc590f7b3…` (`package` / `version` fields), not
  `move/Published.toml` — a publish does not update that file by itself.
- **After ANY Move upgrade, five things must move together or chain and
  source drift**: merge the branch you published from, bump
  `move/Published.toml` (`published-at`, `version`), bump the in-code
  lineage table in `src/lib/circle-chain.ts` (`publishedAt`; keep every
  version that DEFINED types/events reachable — `getPackageLookupIds` feeds
  event filters keyed by defining package), set the new id in `.env.local`
  AND the Vercel Production env (a Move publish never redeploys the web app —
  verify with a bundle fingerprint), then run any repair entrypoints the
  release introduced. On 2026-09-06 v7 (`0x9250490b…`, PR #19)
  was published ~1h before the merge and the env flip; the gap is recorded in
  the `testnet-package-v7-drift` memory.
- Publish one PR per upgrade and merge it before the next one: building v8
  from a tree that never contained v7's code is how upgrades get lost.

**zkLogin Integration**:
- Development uses Docker services (ports 5001, 5003)
- zkLogin session state persists across OAuth flows
- Address generation is deterministic based on social identity

**Cetus Integration** (swap routing only):
- Used for non-custodial token swaps when a member needs to convert one
  asset into the circle's contribution currency. Not used for yield.

**Fiat ramps**:
- Partner-led; Coinbase + MoonPay + Transak. See `src/components/RampPicker.tsx`
  for geo-aware selection. The protocol contract is non-custodial; ramps run
  KYC and AML checks under their own licenses.

### Database Integration
- Primary: Sui blockchain (financial data, circle state)
- Secondary: SQLite/PostgreSQL (join requests, UI preferences)
- Session persistence via file-based zkLogin state

### Testing Strategy
- Move contracts: `sui move test` for unit tests
- Frontend: Uses real testnet integration for development
- zkLogin: Docker services provide isolated auth environment
- Live E2E on production testnet follows `docs/e2e-browser-runbook.md` with
  three Google-signed-in accounts (admin, MEMBER-1, MEMBER-2 on circle
  `0xa3fada18…`). Hard-won rules:
  - A healthy signature is ZERO `/api/zkLogin` POSTs; the signer lives in
    tab-scoped `sessionStorage['njangi.zklogin.signer']`. In the Browser pane
    the `navigate` tool re-creates the tab and wipes it — move between pages
    with `location.assign(...)` from `javascript_tool` instead. Google's
    account chooser only takes coordinate clicks at `preset: desktop`.
  - Open a round ONCE and wait: `open_cycle_*` has no already-open guard until
    PR #20 ships, and a second click makes an orphan escrow (this circle's
    #4). When polling, read the LAST entry of the circle's `escrow_history`
    dynamic field, never an escrow id captured earlier.
  - Admin round controls live on `/circle/<id>/manage` (the contribute page
    never passes `showAdminOpenButton`). The open button is gated on deposits
    HELD (`src/lib/deposit-status.ts`), because `resume_cycle` on v6 clears
    `deposit_paid` while balances stay in custody and the contract refuses a
    re-deposit (abort 21); contributions and claims never check the flag.
  - `current_cycle` counts laps, not rounds; `current_position` is the
    recipient pointer; `paused_after_cycle` flips when the last member of a
    lap collects and the pointer stays on them. Admin flow at end of lap:
    Resume Cycle → Open the next round.
  - Assert contract behaviour without signing via
    `devInspectTransactionBlock` (abort codes: 21 deposit already paid,
    55 circle active, 58 not paused, 205/206 already finalized/claimed,
    207 not recipient, 221 already advanced, 222 not finalized, 223 claim
    not expired). Read chain state from publicnode (object reads only —
    `queryEvents` 429s/fails there and blockvision rate-limits the app).

### Environment Configuration
Key environment variables:
- `NEXT_PUBLIC_PACKAGE_ID`: Auto-updated by build script
- `ZKLOGIN_SECRET`: Session encryption
- Various API keys for Cetus, NAVI, zkLogin services

## Claude Code Skills

Project-specific slash commands available in `.claude/skills/`:

- `/test-contracts` - Run Move contract test suite
- `/build-deploy` - Build and optionally deploy contracts
- `/verify-circle` - Check circle state on-chain
- `/start-zklogin` - Start Docker zkLogin services
- `/check-env` - Validate environment configuration
- `/deploy-testnet` - Full testnet deployment workflow

(The yield module and its skill were retired in the Phase 1 compliance redesign.)

## Troubleshooting Guide

### Move Contract Issues

**Build Failures**:
- Ensure you're in the `move/` directory
- Check Sui CLI version: `sui --version` (requires v1.0+)
- Verify dependencies in `Move.toml`
- Clear build cache: `rm -rf build/`

**Test Failures**:
- Time-related tests may fail due to clock synchronization
- Check test constants match contract parameters
- Verify test gas budget is sufficient
- Run individual tests: `sui move test --filter test_name`

**Deployment Issues**:
- Confirm wallet has sufficient SUI for gas
- Check network connectivity to Sui RPC
- Verify package dependencies are published
- Use `--skip-dependency-verification` only for testing

### Frontend Issues

**zkLogin Not Working**:
- Verify Docker services are running: `docker ps`
- Check ports 5001, 5003 are not in use
- Restart services: `docker-compose down && docker-compose up -d`
- Clear zkLogin session state in browser
- Check ZKLOGIN_SECRET in .env.local

**Fiat Ramp Errors**:
- Verify provider is enabled: `NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED`,
  `NEXT_PUBLIC_MOONPAY_ENABLED`, `NEXT_PUBLIC_TRANSAK_ENABLED`
- Check signed-URL secret keys are set server-side (`MOONPAY_SECRET_KEY`,
  `TRANSAK_API_SECRET`)
- Inspect webhook payload signatures via `pages/api/onramp/<provider>/webhook.ts`

**RPC Connection Issues**:
- Use `sui-rpc-failover` service for reliability
- Check Sui testnet status: https://status.sui.io
- Verify RPC endpoints in configuration
- Implement retry logic for transient failures

### Operations

**⚠️ Address-affecting configuration (read before changing any)**:
A zkLogin address is derived from `(issuer, audience, sub, salt)`. Changing
any of these gives the same social login a DIFFERENT Sui address — silently,
with no error and no migration path:
- `NEXT_PUBLIC_{GOOGLE,FACEBOOK,APPLE}_CLIENT_ID` — becomes the JWT `aud`.
- The OAuth provider itself — Google, Facebook and Apple logins are three
  SEPARATE identities (different `iss`/`sub`) even for the same human, so
  each provider button resolves to its own wallet.
- The Enoki application — deleting/recreating the app resets its salts.

The old address keeps its circles, security deposits and funds, and no future
login reaches it. Recovery means restoring the previous salt source, which
re-orphans anyone onboarded since. **On mainnet this is permanent user fund
loss, not an inconvenience.**

**Rotating an Enoki API key does NOT change the salt.** Enoki derives the
salt per user per application, exactly as its docs say; keys within the same
app all resolve the same salt, so key rotation is a plain credential refresh.

An earlier version of this section claimed the opposite, from a 2026-08-02
misdiagnosis: circles created on rotation day (2026-07-04) belonged to
`…92b680` and everything after to `…9de17d`, which was read as the salt
moving with the key. The append-only `legal_acceptances` table later showed
those two addresses were NEVER the same identity — `…92b680` is the operator's
FACEBOOK login (15-digit numeric `sub`, Facebook `aud`) and `…9de17d` their
GOOGLE login; the rotation-day flip was a provider switch that coincided with
the new key's creation date. Cross-rotation stability is directly evidenced:
`…9de17d` was first recorded 2026-06-15 (old-key era) and resolves identically
today; `…92b680` has been continuously active since 2025-05-26 across the
rotation. When an unfamiliar address appears for "the same user", check the
provider first (sub/aud formats in `legal_acceptances` or
`zklogin_address_bindings` identify it) before suspecting salt drift.

Practical consequences:
1. A leaked key can be revoked without stranding anyone — rotation is safe.
   (The 2026-07-04 rotation of the leaked `9b2ce…` key stranded no addresses;
   that key can be deleted from the Enoki portal.)
2. Keep keys out of screenshots, bug reports, and support threads, and never
   put one in a `NEXT_PUBLIC_*` var — that inlines it into the browser bundle,
   which is exactly how `9b2ce…` leaked (fixed in `8165cd4`).
3. Address drift IS detected now: `src/lib/zklogin-address-bindings.ts`
   (shipped `8d8a149`) keeps an append-only (iss, sub) → address history,
   warns on login when a returning identity resolves to a new address, and
   fail-closes commitment surfaces (circle create/join, contribute, ramp
   sessions) while leaving claim/refund/recovery reachable. It deliberately
   treats providers as distinct identities, so Facebook-you and Google-you
   never trip it.
4. What users still lack is a provider badge next to the signed-in address —
   without it, one human with two provider logins reads their own second
   wallet as a stranger's.

**Vercel deploy (web app)**:
The app is hosted on **Vercel**; production Postgres is **Neon**. The Move
publish runbook below is separate (it ships contracts, not the web app).
0. After ANY database migration or swap, run `npm run bootstrap:sanctions`
   (or the cron-secret curl in `docs/sanctions-program.md`). `migrate:postgres`
   creates the sanctions tables but does not populate them, and an empty list
   means screening CANNOT RUN — every fail-closed surface (circle join, ramp
   session) refuses with `SCREENING_UNAVAILABLE` until the list is loaded.
1. Provision a Neon Postgres database; set `DATABASE_URL` (Neon URLs include
   `?sslmode=require`). Run `npm run migrate:postgres` against it before the
   first deploy — idempotent; it also adds the `walrus_end_epoch` column to
   `whatsapp_phone_index` and creates `walrus_renewal_audit`.
2. Set env vars in the Vercel project (see `.env.example`). Server-only secrets
   (`ZKLOGIN_SECRET`, `WALRUS_PII_MASTER_KEY`, `INTERNAL_NOTIFY_SECRET`,
   `CRON_SECRET`, `ENOKI_API_KEY_TESTNET`/`ENOKI_API_KEY_MAINNET`, ramp secrets)
   must NOT carry the `NEXT_PUBLIC_` prefix so Next.js keeps them off the client
   bundle. `RENEWAL_THRESHOLD_EPOCHS` (default 2) is an optional knob for the
   Walrus renewal cron.
3. Cron jobs are declared in `vercel.json` and run on Vercel's scheduler; each
   authenticates with `CRON_SECRET` via a timing-safe bearer check and uses the
   fenced-lease machinery in `src/lib/cycle-finalized-cron.ts`:
   - `/api/cron/cycle-finalized` (every minute) — your-turn WhatsApp nudges.
   - `/api/cron/whatsapp-circle-events` (every minute) — circle lifecycle relays.
   - `/api/cron/walrus-renewal` (daily, `0 3 * * *`) — renews Walrus PII blobs
     before expiry (tracked via `walrus_end_epoch` in Postgres).
4. Vercel runs `next build`; the active Sui network is `NEXT_PUBLIC_SUI_NETWORK`.

On Vercel the cron functions replace the standalone Heroku worker dyno described
under "Cycle-finalized WhatsApp notifier" below — that section is retained only
for the legacy worker-process deployment.

**Publish runbook (testnet)**:
1. `npm run validate:move-network` — Move.toml byte-equal to canonical
   testnet config.
2. `npm run preflight` — TypeScript + lint + Move build clean.
3. `npm run migrate:postgres` — creates the seven application tables.
   Idempotent; safe on a fresh DB or an existing one.
4. `npm run generate:secrets` — fills any missing
   `WALRUS_PII_MASTER_KEY`, `WALRUS_LOOKUP_SALT`,
   `COMPLIANCE_REF_HMAC_SALT`, `INTERNAL_NOTIFY_SECRET`,
   `COMPLIANCE_ISSUANCE_SECRET` in `.env.local`. Existing values are
   preserved.
5. `bash move/scripts/switch-network.sh testnet` if not already there.
6. `bash move/build_and_test.sh` — builds, publishes, captures the
   package id into `.env.local`, then prompts to run the post-publish
   bootstrap. Answer `y` so the script auto-calls
   `whatsapp_integration::init_registry`,
   `njangi_price_validator::init_registry`, and captures the
   `AttestorCap` object id minted by `njangi_compliance::init`.
7. `npm run validate:env` — confirms every required active-network id is
   populated, including the new `NEXT_PUBLIC_TESTNET_NJANGI_ATTESTOR_CAP_ID`
   and `NEXT_PUBLIC_TESTNET_NJANGI_ASSET_REGISTRY_ID`.
8. Start the app (`npm run dev`) and run `npm run smoke:testnet` against
   it. Six steps; expect all PASS.
9. Manual UX walk-through: open `/admin/compliance`, confirm the queue
   + stale list + recent notifications render. Open
   `/circle/<id>/contribute`, confirm the "Link your WhatsApp" prompt
   shows when the circle has no link.
10. Re-run `npm run preflight` once more before pushing.

**Testnet package versions** (read the UpgradeCap `0xc590f7b3…` for truth):
| version | package id | contents / status |
|---|---|---|
| 1 | `0x89cddf4d…` (original; all object types) | — |
| 6 | `0x859e3add…` | superseded 2026-09-06 |
| 7 | `0x9250490b…` | PR #19 (`resume_cycle` keeps deposits, `reconcile_deposit_paid`); published 2026-09-06 19:14Z, tx `HXPdLZJB…`; superseded the same night |
| 8 | `0x401ed420…` | PR #20 (open-round marker, abort 234 `E_ROUND_ALREADY_OPEN`, `release_open_round`); published 2026-09-06 ~20:20Z, tx `H87Dirpn…`; guard verified live in lap 5; `NEXT_PUBLIC_ESCROW_ROUND_GUARD_ENABLED=true`; superseded by v9 the same night |
| 9 | `0xf8afd3df…` | PR #14 (`create_circle` stores the real custody `wallet_id`; `create_custody_wallet_returning_id`); published 2026-09-06 with `sui` 1.79.0, tx `Ap9Xpvx2…`, from `main` 5864d5f; all references point here |
No Move PR is waiting on a publish. Upgrade with the CLI: `suiup install
sui@testnet -y` when it lags the network, then `sui client upgrade
--upgrade-capability <cap from Published.toml>` from `move/` — the CLI holds
the deployer key and rewrites `Published.toml` itself.

**Re-running the bootstrap manually**:
`node scripts/bootstrap-package.mjs <packageId>` — re-issues the registry
inits if the env file got out of sync. Skips inits for any registry env
var that's already populated, so it's safe to re-run.

**Cycle-finalized WhatsApp notifier** (legacy worker-dyno path; superseded by
the Vercel `/api/cron/cycle-finalized` job on the Vercel deploy above):
- Worker script: `scripts/cycle-finalized-notifier.mjs`. Launches via
  `npm run notifier:cycle-finalized` or the `notifier` process in
  `Procfile`. Polls `CycleFinalized` events every `POLL_INTERVAL_MS`
  (default 60s), persists its cursor to `.cycle-finalized-cursor.json`
  (git-ignored), and POSTs to `/api/whatsapp/notify/your-turn` for each
  new recipient.
- Required env on the worker dyno:
  `PACKAGE_ID`, `NOTIFY_ENDPOINT` (points at the web dyno),
  `INTERNAL_NOTIFY_SECRET` (must match the web dyno),
  `NETWORK` (`testnet`/`mainnet`), `SUI_RPC_URL` (optional override),
  `COIN_DECIMALS`, `COIN_SYMBOL`.
- Deploying on Heroku: `heroku ps:scale notifier=1 -a <app>` after pushing
  this Procfile. Rotate `INTERNAL_NOTIFY_SECRET` by setting the new value
  on both the web and notifier dynos in the same release.

**Compliance attestor console**:
- Page: `/admin/compliance`. Uses the Phase 2 client-side signer, so the
  operator never posts their ephemeral key to the server.
- Required env:
  `COMPLIANCE_REF_HMAC_SALT` (server),
  `COMPLIANCE_ISSUANCE_SECRET` (server, sent by the console as
  `x-internal-auth`; the old `INTERNAL_NOTIFY_SECRET` fallback was removed
  2026-07 — the two secrets are separate concerns now),
  `NJANGI_ATTESTOR_CAP_ID` (ops-side reference of the AttestorCap object),
  `NEXT_PUBLIC_NJANGI_ATTESTATION_ISSUER` (browser-visible issuer pin).
- Flow: enter AttestorCap id + subject + provider case id + TTL → the page
  calls `/api/compliance/prepare-issuance` to hash the policy server-side,
  then signs `njangi_compliance::issue(cap, subject, policy_hash,
  ref_hash, ttl, clock)` locally.

**Build Errors**:
- Clear Next.js cache: `rm -rf .next/`
- Reinstall dependencies: `rm -rf node_modules && npm install`
- Check TypeScript errors: `npm run type-check`
- Verify environment variables are loaded

### Common Patterns

**Adding a New Circle Function**:
1. Update Move contract in `move/sources/njangi_circles.move`
2. Add tests in contract file
3. Run `sui move test` to verify
4. Deploy with `./build_and_test.sh`
5. Update frontend service in `src/services/circle-service.ts`
6. Add UI component in `src/pages/circle/[id]/`
7. Test end-to-end flow

**Adding a Fiat Ramp Provider**:
1. Add `<provider>-service.ts` under `src/services/` with a signed-URL builder
2. Add `pages/api/onramp/<provider>/session.ts` and `webhook.ts`
3. Add `<provider>Launcher.tsx` under `src/components/`
4. Wire into `RampPicker.tsx` (geo-aware ordering)
5. Update `.env.example` with public + secret keys

**Debugging On-Chain State**:
1. Use Sui Explorer: https://suiexplorer.com
2. Query objects: `sui client object <OBJECT_ID>`
3. Check events: `sui client events --package <PACKAGE_ID>`
4. Use `/verify-circle` skill for quick checks

## Quick Reference

### File Locations

**Contracts**: `move/sources/`
- Core utilities: `njangi_core.move`
- Circle logic: `njangi_circles.move`
- Payments + payouts: `njangi_payments.move`
- Custody primitives: `njangi_custody.move`
- Asset registry / oracle gating: `njangi_price_validator.move`
- WhatsApp link anchors (Walrus-backed PII): `whatsapp_integration.move`

**Services**: `src/services/`
- Circle operations: `circle-service.ts`
- zkLogin: `enokiZkLoginService.ts`
- Fiat ramps: `coinbase-onramp-service.ts`, `moonpay-service.ts`, `transak-service.ts`
- RPC failover: `sui-rpc-failover.ts`

**Libraries**: `src/lib/`
- Walrus PII encryption: `walrus-pii.ts`
- Recovery liveness: `recovery-liveness.ts`

**Components**: `src/components/`
- Ramp launchers: `CoinbaseOnrampLauncher.tsx`, `MoonPayLauncher.tsx`, `TransakLauncher.tsx`, `RampPicker.tsx`
- Circle pages: `src/pages/circle/[id]/`

**Tests**:
- Move: In source files with `#[test]`
- Frontend: `src/**/__tests__/`

### Development Workflow

**Daily Development**:
1. Pull latest: `git pull`
2. Start zkLogin: `docker-compose up -d`
3. Run dev server: `npm run dev`
4. Check environment: `/check-env`
5. Run tests before committing

**Making Changes**:
1. Create feature branch
2. Make incremental changes
3. Run relevant tests frequently
4. Use `/test-contracts` for Move changes
5. Commit with descriptive messages
6. Create PR when ready

**Pre-Deployment Checklist**:
- [ ] All tests passing (`/test-contracts`)
- [ ] Linting passes (`npm run lint`)
- [ ] TypeScript compiles (`npm run build`)
- [ ] Manual testing completed
- [ ] Environment variables updated
- [ ] Deployment gas budget confirmed
- [ ] Backup of current package ID

## Best Practices

### Smart Contract Development
- Always test time-dependent logic thoroughly
- Use decimal scaling (1e9) for currency values
- Validate inputs at entry points
- Emit events for all state changes
- Document complex yield calculations
- Test edge cases (zero deposits, max members, etc.)

### Frontend Development
- Use TypeScript strictly
- Handle loading states for blockchain queries
- Implement error boundaries
- Cache RPC responses when appropriate
- Validate user inputs before transactions
- Show clear transaction feedback

### Security Considerations
- Never commit private keys or secrets
- Validate all on-chain data before using
- Implement proper access controls
- Test recovery/upgrade scenarios
- Monitor for unusual activity
- Keep dependencies updated

### Performance Tips
- Batch RPC calls when possible
- Use dynamic fields efficiently
- Implement pagination for large datasets
- Cache static data (pool addresses, etc.)
- Minimize re-renders in React components
- Profile transaction gas costs

## Resources

- Sui Documentation: https://docs.sui.io
- Cetus Protocol: https://cetus.zone
- NAVI Protocol: https://naviprotocol.io
- zkLogin Guide: https://docs.sui.io/build/zk_login
- Sui Explorer: https://suiexplorer.com
- Project Issues: Use GitHub Issues for tracking