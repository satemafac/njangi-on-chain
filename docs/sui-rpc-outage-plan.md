# Surviving a Sui JSON-RPC outage

_Written 2026-10-15, during one. Owner: founder. Companions:
[incident-playbook.md](incident-playbook.md) ("Reads that lie"),
[environment.md](environment.md)._

## What happened

On 2026-10-15 (sign-in failing in production logs at 12:20Z, still down when this was written)
every testnet JSON-RPC endpoint the app knows was unusable at once:

| endpoint | answer |
|---|---|
| `sui-testnet-rpc.publicnode.com` (primary) | HTTP 503 `-32701 no available nodes found for platform sui-testnet-rpc` |
| `sui-testnet-endpoint.blockvision.org` (fallback) | `-32603 Internal error` on every method, or `Your request is too frequent` |
| `fullnode.testnet.sui.io` | `-32601 JSON-RPC on public fullnodes has been deprecated` (since 2026-08) |
| `rpc-testnet.suiscan.xyz` | HTTP 404 |
| ankr, blockpi | need an API key |
| Blast | shut down |

Mainnet publicnode kept answering. Sui itself was healthy: its GraphQL and
gRPC services answered every probe below.

Users saw it first as **"I can't sign in"**: `beginLogin` reads the epoch
before it can build the OAuth nonce, and that read was JSON-RPC only, so
`/api/zkLogin` returned 500 before Google ever opened. That is fixed on
branch `fix/login-epoch-graphql-fallback` (`src/lib/sui-epoch.ts`: GraphQL
first, JSON-RPC fallback, never a guessed epoch). Everything after sign-in
still speaks only JSON-RPC.

## What Sui still serves (live evidence, 2026-10-15)

Probed against the activation-test circle `0x7beabc6c…0130ff6c`, its open
escrow `0x991287f5…2c556f14` and the admin address `0xe833deaa…1f9de17d`.

### GraphQL — `https://graphql.testnet.sui.io/graphql`

Server `x-sui-rpc-version: 1.82.1`. CORS: `access-control-allow-origin: *`,
so the browser can call it directly.

| need | GraphQL | result |
|---|---|---|
| object read | `object(address)` / `multiGetObjects(keys)` | OK, ~90 ms; `contents.json` + `type.layout` |
| dynamic fields | `object { dynamicFields }` | OK: `escrow_history`, `open_round`, `circle_config`, `wallet_id`, … |
| owned objects | `address { objects }` | OK, paginated (CircleMembership receipts visible) |
| balances | `address { balances }` | OK: SUI 4331941081, USDC 1975922 |
| epoch / gas price | `epoch { epochId referenceGasPrice }` | OK: 1253 / 1000 |
| event history | `events(filter: { type })` | OK, back to **2026-07-04** (oldest event in `njangi_circles`) |
| tx history by object | `transactions(filter: { affectedObject })` | OK |
| simulate (dry run / devInspect) | `simulateTransaction` | OK via SDK, see below |
| execute | mutation `executeTransaction(transactionDataBcs, signatures)` | reachable; rejects a dummy signature correctly |

### gRPC — `https://fullnode.testnet.sui.io:443` (gRPC-web)

CORS `*` as well. Object reads, balances, dynamic fields, owned objects and
gas price all OK (23–166 ms). **Transaction history is pruned**: a 9-day-old
digest (`3guGM8Mf…`) answers "not found". Fine for current state and
execution, not for history — history goes to GraphQL.

### The SDK

The repo has `@mysten/sui` **1.30.1**. Its `SuiGraphQLClient` targets Sui's
old GraphQL schema: against today's endpoint every real read fails
(`getObjects`, `getBalance`, `getOwnedObjects`, `getTransaction`; only gas
price "succeeds", with an empty body). It has no gRPC client.

| SDK | GraphQL core client | gRPC core client |
|---|---|---|
| 1.30.1 (installed) | broken on the new schema | absent |
| 1.45.2 (last 1.x, 2025-12) | reads OK except `getBalance` (query-definition bug against the new schema) | reads OK; `getTransaction` pruned |
| 2.36.0 (latest, 2026-10-13) | every probe OK | every probe OK except pruned history |

With **2.36.0**, a transaction with the shared Clock and the live escrow as
inputs **built** (gas coin, price and budget resolved) and **simulated**
`success` on both GraphQL and gRPC while JSON-RPC was down, and
`executeTransaction` on both rejected a zero-filled signature with
"Required Signature from 0xe833… is absent". Nothing was signed or executed.

### The shape problem

The app reads JSON-RPC shapes: `data.content.fields.<name>`. GraphQL's
`contents.json` and the SDK's `core` API do not produce them:

| Move value | JSON-RPC `content.fields` | GraphQL `contents.json` |
|---|---|---|
| nested struct (`snapshot`) | `{ type, fields: {…} }` | flat `{…}` |
| `UID` | `{ id: "0x…" }` | `"0x…"` |
| `Table` (`members`) | `{ type, fields: { id: { id }, size } }` | `{ id, size }` |
| `vector<u8>` (`asset_type`) | array of numbers | base64 string |
| `Balance<T>` | `"200000"` | `"200000"` |
| `Option<T>` | value or `null` | value or `null` |

`core` returns BCS, not JSON at all. So no endpoint swap keeps the app
working: either every read site moves to a new shape, or an adapter rebuilds
the JSON-RPC shape. GraphQL's `type { layout }` carries the full struct
layout (field names, nested struct types), which is exactly what such an
adapter needs.

## Which flows break today

Inventory of `origin/main` (`a9d0e30`), 2026-10-15: about 197 JSON-RPC call
lines in `src` plus 41 calls through the `sui-read.ts` helpers. By method:
`getObject` 64, `queryEvents` 37, `getDynamicFields` 23,
`getDynamicFieldObject` 23, `getCoins` 10, `waitForTransaction` 9,
`getTransactionBlock` 9, `queryTransactionBlocks` 5, `getOwnedObjects` 4,
`getBalance` 4, `multiGetObjects` 3, everything else 1–2 each. The browser
calls the RPC endpoints directly; no API route proxies them. With the
defaults, testnet has **two** distinct JSON-RPC endpoints (publicnode, then
blockvision), so "both down" is one bad afternoon away, as today showed.

| flow | where it runs | what it needs | when every JSON-RPC endpoint is down |
|---|---|---|---|
| Sign-in | server | epoch | **works** after `fix/login-epoch-graphql-fallback` (GraphQL) |
| Post-login heartbeat refresh | browser | tx history, events, dynamic fields, then signing | fails quietly (fire-and-forget) |
| **Every transaction**: deposit, contribute, collect, refund, recovery, open/resume/cancel round, admin edits, create circle, send tokens | browser | `Transaction.build` (gas price, `dryRunTransactionBlock`, `getCoins`, `multiGetObjects`, `getNormalizedMoveFunction`) then `executeTransactionBlock` | **fails**. Until this branch the five signing clients were single-endpoint, so they failed even when only the primary was down |
| Round panel (`CycleEscrowPanel`), contribute, manage | browser | escrow history and open-round dynamic fields, escrow object, contributors table, chain clock, circle config | fails; mostly reported honestly ("couldn't reach the network", `loadError`) |
| Dashboard | browser | membership receipts (`getOwnedObjects`), circles (`multiGetObjects`), balances, events, tx history | fails; the circles list says "We couldn't reach the network"; some sub-reads swallow (below) |
| Circle detail `/circle/<id>` | browser | circle, members table, events, recovery state | fails |
| Join `/circle/<id>/join` | server SSR + browser | circle object + config (SSR, **single-endpoint client**), then circle details | link card degrades to generic copy (verified on production: no circle name); page fails to load details |
| WhatsApp crons and webhook | server | registry and circle objects, events | notifications stall; `cron-event-probe` treats a failed probe as "run the full pass", which then fails |
| Landing stats `/api/circle-stats` | server | paginated `queryEvents` | fails |
| Admin compliance console | browser | `getOwnedObjects`, signing | fails |
| Sanctions screening | server | Postgres only | **unaffected** |
| Enoki salt / zkProof, sponsored execution | server → Enoki | Enoki API | **unaffected** (Enoki is not this app's RPC) |

Event history deserves its own line: the 37 `queryEvents` sites only ever
worked on blockvision (publicnode prunes events), so they are already one
endpoint deep on a good day. GraphQL serves the same history back to
2026-07-04.

### Reads that turn an outage into a falsehood

Found by the inventory, two spot-checked by hand (marked ✓). These are the
places where "the network is down" renders as a confident wrong answer, so
fix them before or alongside any fallback work:

- `dashboard.tsx` `userIsCurrentMemberOrAdmin` (~:247) returns `false` on a
  read error: a receipt-only circle is hidden.
- `dashboard.tsx` (~:3909) `getDynamicFields` failure becomes `{ data: [] }`.
- ✓ `compliance-gate.ts` `resolveComplianceConfigId` (:95–141) swallows
  every read error and returns `null`, the same value as "no config on this
  lineage"; callers add `.catch(() => null)`. Check whether the chain
  refuses an ungated open on a gated circle, so this fails as an abort and
  not as a silent downgrade.
- ✓ `circle-service.ts` `getCirclePackageId` (:270–341) returns the default
  package id when every read fails. Low risk for CALLS, which must target
  the latest version anyway; wrong for anything that keys on the defining
  package.
- `gas-sponsorship-eligibility.ts` (~:46) returns `null` on a read error, so
  sponsorship is declined and the member pays their own gas. That is a cost
  shift, not a safety issue.
- `goal-pool-discovery.ts` (~:135, ~:217) returns `[]`.

## Plan, ranked by user impact

**0. Sign-in. Done** on `fix/login-epoch-graphql-fallback`.

**1. Signing fails over across JSON-RPC endpoints. Done on this branch.**
`getSigningSuiClient(network)` (now `src/lib/signing-sui-client.ts`)
replaces the five `new SuiClient({ url: rpcUrl })` signing clients
(`zkLoginClient.ts` ×3, `useZkLoginSigner.ts`, `AuthContext.tsx`
send-tokens). Healthy behaviour is unchanged: the configured primary is still
tried first. Resubmitting is safe because the retry carries the same signed
bytes, so the same digest, and Sui executes a digest at most once. A
source-scan test keeps `new SuiClient(` out of the signing files. Verified
live on mainnet with a dead primary: the kind-only build, `devInspect`, gas
price and a (garbage) submission all moved to the healthy node. **It does
not help when every JSON-RPC endpoint is down, as on 2026-10-15.** It closes
the more common case, where only the primary fails.

**2. Stop the falsehoods above.** Small, independent PRs, one per site, each
turning "error → absent" into "error → unknown", with the UI saying it
couldn't check. No new endpoints are needed. This is the cheapest way to
make an outage *honest*, and it pays off on every flaky day, not only
outages.

**3. Stop-gap option (owner decision): a keyed JSON-RPC provider.** The
fastest way to make *everything* survive is a third JSON-RPC endpoint that
is not publicnode or blockvision, ideally archival (events). QuickNode,
Shinami, Ankr and BlockPI all require keys and accounts; the brief rules out
adding one without the owner. It slots into `NEXT_PUBLIC_TESTNET_RPC_ALT`
with no code change. The app's existing "buy archival RPC before launch"
risk is the same item.

**4. GraphQL fallback for the hot reads, behind the existing transport.**
Teach `SuiFailoverTransport` a last-resort candidate that answers a fixed
set of JSON-RPC methods from GraphQL and rebuilds the JSON-RPC response
shape: `sui_getObject`, `sui_multiGetObjects`, `suix_getDynamicFieldObject`,
`suix_getDynamicFields`, `suix_getOwnedObjects`, `suix_getBalance`,
`suix_getAllBalances`, `suix_getCoins`, `suix_getReferenceGasPrice`. Call
sites stay untouched. The work is the shape adapter: GraphQL's
`type { layout }` gives every struct's fields and full type, so the
JSON-RPC `{ type, fields }` wrapping, `UID → { id }` and
`vector<u8> → number[]` can be rebuilt deterministically. **Gate:** a
differential test that reads the same live objects (circle, members table
entry, escrow, config, membership receipt) through publicnode and through
the adapter and requires byte-identical `content`. Until that passes on
real data the adapter does not ship, because a wrong shape on a money page
is worse than an outage. This makes every *page* survive a total JSON-RPC
outage. It does not make transactions survive: the SDK 1.30 resolver still
calls `dryRunTransactionBlock` and `getNormalizedMoveFunction`.

**5. Events over GraphQL.** Move the 37 `queryEvents` sites, or the
`queryEventsCached` helper they mostly share, onto GraphQL `events(filter:
{ type })` with cursor pagination. This removes the blockvision single point
on every day, not just outage days. Same "object reads first" rule: most of
these should become object reads instead (see the RPC scalability memo).

**6. The durable fix: `@mysten/sui` 2.x on gRPC + GraphQL, JSON-RPC
retired.** Sui deprecated JSON-RPC; the 2.x `core` API is transport-neutral
and, per the probes above, builds, simulates and executes over gRPC
(current state, fast) with GraphQL for history. It is a major-version
upgrade touching every read site (BCS / `core` shapes instead of
`content.fields`), plus `@mysten/enoki`, `@mysten/zklogin` and the wallet
packages that pin their own nested `@mysten/sui`. Plan it as its own
project. Items 4 and 5 are the bridge that keeps the app alive meanwhile,
not a substitute.

Order: 1 now; 2 next (small, safe, independent); 3 is the owner's call and
can happen any day; 4 and 5 in either order; 6 as a planned migration. The
1.45.2 minor bump is **not** recommended as a shortcut: it brings gRPC, but
its GraphQL client still breaks on `getBalance` against today's schema, and
it does not change the response shapes the app reads.

## Rules that hold throughout

- **A read failure is not an answer.** During an outage the dangerous
  output is a confident empty state: "you have no circles", "$0",
  "nobody has paid". Every fallback must keep `unknown` distinct from
  `absent` (see "Reads that lie" in the incident playbook).
- **Never move money on a guessed read.** A fallback that reshapes data
  wrongly is worse than an outage. Anything on a money path gets a
  differential test (same object, JSON-RPC shape vs adapter shape) on
  real chain data before it ships.
- **Object reads over event scans** stays the rule. GraphQL's event
  history is the better archive, but current state belongs to objects.
- **No paid or keyed provider without the owner's call.** It is the fastest
  stop-gap and it is listed below as an option, not done.
