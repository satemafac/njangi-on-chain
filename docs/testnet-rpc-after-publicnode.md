# Testnet RPC after publicnode retired JSON-RPC

_Written 2026-10-17. Owner: founder (the provider decision below is yours).
Companions: [sui-rpc-outage-plan.md](sui-rpc-outage-plan.md) (call-site
inventory, ranked plan), [incident-playbook.md](incident-playbook.md)
(Scenario 6)._

## What changed

| when | what |
|---|---|
| 2026-08 | Sui's own fullnodes stop serving JSON-RPC (`-32601 … JSON-RPC on public fullnodes has been deprecated`). |
| 2026-10-15 | Every testnet JSON-RPC provider fails for hours: publicnode 503 "no available nodes", blockvision `-32603` / 429. Sign-in moves to GraphQL (#128). |
| 2026-10-16 03:51Z | publicnode testnet answers every call with HTTP 200 and `-32000 Sui JSON-RPC endpoint has been deprecated. Please use the gRPC endpoint instead: https://sui-testnet-grpc.publicnode.com:443`. It is a retirement, not an outage. |
| 2026-10-17 03:58Z | Still retired. blockvision testnet: `-32603 Internal error`, or 429 on object reads. Mainnet publicnode and mainnet blockvision both still serve JSON-RPC. |

publicnode was the app's testnet primary (the production
`NEXT_PUBLIC_TESTNET_RPC_URL`) and the first shared fallback. Blockvision is now
the **only keyless testnet JSON-RPC** left, and it is failing too. **Every
testnet read and transaction in the app is down.** Sign-in still works,
because it reads the epoch from GraphQL.

Until this branch, the failover made it worse: it recognised only two exact
deprecation phrasings, so publicnode's message counted as a terminal error and
no request ever reached blockvision. That is fixed on
`fix/jsonrpc-deprecation-failover`: a retired JSON-RPC surface now fails over
and is skipped for 10 minutes. With publicnode first, as in production, the
live result was:
- `main`: publicnode → stop.
- branch: publicnode → blockvision, and later requests go straight to
  blockvision.

That restores failover, not reads, because blockvision is failing too.

## What still works (live, 2026-10-17)

The same probe ran against each endpoint: the activation-test circle
`0x7beabc6c…`, its escrow `0x991287f5…`, and the testnet admin `0xe833…9de17d`
(balance 4331941081 MIST). It covered reads, building a transaction with that
escrow as an input, simulating it, and submitting it with a zero-filled
signature, which must be rejected. Nothing was signed or executed.

| endpoint | SDK 2.36 | SDK 1.45.2 |
|---|---|---|
| **Sui fullnode gRPC** `https://fullnode.testnet.sui.io:443` | reads ✓ (object, balance, owned objects, dynamic fields, gas price), build ✓, simulate ✓, execute ✓ (bad signature rejected). A 10-day-old transaction is **not found**: history is pruned | reads ✓; **can't build** ("Transaction resolution is not supported with the GRPC client") |
| **Sui GraphQL** `https://graphql.testnet.sui.io/graphql` | everything ✓, including the 10-day-old transaction and event history (back to 2026-07-04) | reads mostly ✓, `getBalance` broken against today's schema; **can't build** |
| **publicnode gRPC** `https://sui-testnet-grpc.publicnode.com:443` | ✗ every call: `invalid gRPC request content-type "application/grpc-web-text"`. It speaks native gRPC only, not gRPC-web, so **browsers can't use it** | ✗ same |
| **blockvision JSON-RPC** (testnet) | n/a | n/a. `-32603 Internal error` / 429 |
| the app's SDK, **1.30.1** | n/a | no gRPC client; its GraphQL client targets the old schema and fails every read |

Two more facts decide the migration's shape:

- **SDK 2.x returns parsed JSON** for object contents (`include: { json: true }`),
  not just BCS. Moving off JSON-RPC is therefore mechanical, a change of read
  shape: `content.fields.x` becomes `json.x`, nested structs lose their
  `{ type, fields }` wrapper, and a `UID` is a plain string.
- **That JSON is identical over gRPC and GraphQL.** Compared key by key for
  the circle and the escrow above: identical. So one migration gets fast gRPC
  for current state and execution, GraphQL for history, and failover between
  them, all with the same shapes.

Both Sui endpoints answer browser requests (`access-control-allow-origin: *`)
and need no key.

Dependency note: the current `@mysten/enoki` (1.3.0, used server-side for
gas sponsorship) requires `@mysten/sui` ^2.36, so the SDK and Enoki move
together. `@mysten/dapp-kit` (installed, unused) also requires 2.x and can
simply be removed, as can the unused `@mysten/sui.js` 0.54 code.

## Options

**A. A keyed JSON-RPC provider for testnet (bridge).** Put a paid or keyed
provider in `NEXT_PUBLIC_TESTNET_RPC_URL` (Vercel, all environments):
QuickNode, Shinami, Ankr, BlockPI or Chainstack. There's no code change, and
the app works again within hours.
- *Against:* it buys more of an API that is being retired. Sui's own nodes
  dropped it, and publicnode followed eight weeks later. Expect providers to
  keep narrowing it.
- *Against:* it costs money, and a key in a `NEXT_PUBLIC_*` variable is
  visible in the browser. Use a provider with origin allowlisting, or a
  key-restricted plan.
- *Your call* (see "Owner actions").

**B. A GraphQL adapter that rebuilds JSON-RPC shapes (plan item 4).** No
longer recommended. SDK 2.x now gives the JSON directly, so the adapter would
be throwaway work. It would also not restore transactions: SDK 1.30's
transaction builder still needs JSON-RPC (`dryRunTransactionBlock`,
`getNormalizedMoveFunction`).

**C. Migrate to `@mysten/sui` 2.x `core` on Sui's gRPC + GraphQL (plan item 6).**
- Free, Mysten-run, browser-callable, verified above for every operation the
  app performs.
- It is also where the ecosystem is going, so it ends this class of incident
  rather than moving it to the next provider.
- Size: about 200 JSON-RPC call lines plus 41 calls through `sui-read.ts`
  (inventory in the outage plan), the Enoki 1.x upgrade, and the 37
  `queryEvents` sites moving to GraphQL events (or, better, to object reads).
- It can be staged. Install 2.x under an npm alias (`"@mysten/sui-v2":
  "npm:@mysten/sui@^2.36"`) so both versions coexist, and move one flow at a
  time.

## Recommendation

**Start C now, and use A only as a bridge if the testnet pilot needs to
transact before C's first stage lands.**

C is the only option that doesn't depend on a JSON-RPC provider surviving.
The evidence above shows Sui's own endpoints already do everything the app
needs, with identical shapes on both transports. A buys time. B is now
strictly worse than C.

Staged order for C, by user impact, each stage independently shippable:
1. **Signing and execution**: `getSigningSuiClient` and the zkLogin signer
   build, simulate and execute through a 2.x `core` client (gRPC, GraphQL
   fallback). Probably the smallest stage, because the build path is
   self-contained, and the most valuable: it brings deposits, contributions,
   collects and admin actions back.
2. **The shared read layer** (`sui-read.ts`: `readObject` / `readObjects`) on
   `core.getObjects({ include: { json: true } })`, then the round panel,
   contribute and manage pages.
3. Dashboard discovery (owned membership receipts, circles, balances).
4. Join flow, WhatsApp crons and webhook, sponsorship eligibility.
5. Event history to GraphQL `events(filter)` with cursors, or to object reads.
6. Remove 1.x, `@mysten/sui.js`, `dapp-kit`; upgrade Enoki.

## Owner actions

1. **Decide on A.** If yes, create the provider account and set
   `NEXT_PUBLIC_TESTNET_RPC_URL` in Vercel (Production, Preview, Development)
   to its testnet URL. Prefer one with origin restrictions. Redeploy, and
   confirm with a dashboard load.
2. **Approve C stage 1**, so signing works without JSON-RPC.
3. Optional, cosmetic: with the failover fix merged, the production
   `NEXT_PUBLIC_TESTNET_RPC_URL=publicnode` costs one wasted request per
   client every 10 minutes. Changing it to blockvision removes that hop, but
   restores nothing while blockvision is failing.

Ops scripts under `scripts/` still default to publicnode testnet. Point
their override at the chosen provider when running them:
- `SUI_RPC_URL`: `cycle-finalized-notifier.mjs`, `assert-not-recipient.mjs`,
  `assert-recovery-guards.mjs`, `e2e-compliance-check.mjs`
- `NJANGI_BOOTSTRAP_RPC_URL`: `bootstrap-package.mjs`, which otherwise reads
  `NEXT_PUBLIC_<NET>_RPC_URL`

- `NEXT_PUBLIC_<NET>_RPC_URL`: `v11-convert-circles.mjs`, the one-off v11
  migration
