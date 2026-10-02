# Environment Configuration

The repo now uses one canonical local env file:

- local source of truth: `.env.local` in the repo root (git-ignored)
- template: [`.env.example`](../.env.example)

## Local development

1. Copy [`.env.example`](../.env.example) to `.env.local` in the repo root.
2. Fill in the canonical keys only.
3. Run `npm run validate:env`.

The standalone WhatsApp bot backend (`whatsapp-bot-backend/`) is retired. The
app itself now serves the WhatsApp webhook and runs the WhatsApp notification
crons; see [`whatsapp-bot-backend/DEPRECATED.md`](../whatsapp-bot-backend/DEPRECATED.md).
The app never reads `whatsapp-bot-backend/.env.local`, and
`npm run validate:env` warns while that file exists. Move any value you still
need into the root `.env.local`, then delete the file.

## Canonical naming

Use these network-specific public keys:

- `NEXT_PUBLIC_SUI_NETWORK`
- `NEXT_PUBLIC_TESTNET_RPC_URL`
- `NEXT_PUBLIC_MAINNET_RPC_URL`
- `NEXT_PUBLIC_TESTNET_RPC_ALT`
- `NEXT_PUBLIC_MAINNET_RPC_ALT`
- `NEXT_PUBLIC_TESTNET_GRAPHQL_URL`
- `NEXT_PUBLIC_MAINNET_GRAPHQL_URL`
- `NEXT_PUBLIC_TESTNET_PACKAGE_ID`
- `NEXT_PUBLIC_MAINNET_PACKAGE_ID`
- `NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID`
- `NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID`
- `NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID`
- `NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID`

Keep server/runtime keys unprefixed:

- `ENOKI_API_KEY_TESTNET`, `ENOKI_API_KEY_MAINNET`: the Enoki private key that
  fetches zkLogin salts and zkProofs. Never give it a `NEXT_PUBLIC_` prefix;
  Next.js inlines those values into the browser bundle.
- `WHATSAPP_*`
- `DATABASE_URL`
- `FRONTEND_URL`: the base URL for links in WhatsApp circle-event messages
  (defaults to `https://njangionchain.com`).

`BACKEND_AUTH_TOKEN`, `WHATSAPP_BACKEND_URL`, `CIRCLE_BACKEND_URL` and
`ANALYTICS_URL` were removed in June 2026 along with the bot backend. No app
code reads them; `npm run validate:env` warns when one is set in `.env.local`.
Delete any that are still set, locally or in Vercel. `.env.example` lists the
other variables that were removed with the bot.

## Deprecated aliases

The app still tolerates these as one-release shims and warns when it uses them:

- `NEXT_PUBLIC_PACKAGE_ID`
- `NEXT_PUBLIC_WHATSAPP_PACKAGE_ID`
- `NEXT_PUBLIC_WHATSAPP_REGISTRY_ID`
- `SUI_WHATSAPP_LINKS_REGISTRY_ID`
- `NEXT_PUBLIC_ENOKI_TESTNET`, `NEXT_PUBLIC_ENOKI_MAINNET`, `NEXT_PUBLIC_ENOKI`
- `NEXT_PUBLIC_SUI_RPC_URL`
- `NEXT_PUBLIC_SUI_GRAPHQL_URL`
- `SUI_GRAPHQL_URL`
- `TESTNET_GRAPHQL_URL`
- `MAINNET_GRAPHQL_URL`

If a canonical key and a legacy alias are both set with different values, startup fails.

The three `NEXT_PUBLIC_ENOKI*` aliases are more than old names. Next.js
inlines their values into the browser bundle, so a key stored in one is public.
`npm run validate:env` fails while any of them holds an `enoki_private_*` key.
Move the key to `ENOKI_API_KEY_*`, rotate it in the Enoki portal (a new key in
the same Enoki app keeps every address), then delete the alias.

## Hosted environment (Vercel)

The app deploys on **Vercel**; production Postgres is **Neon**. There is no
per-app config-sync script — set environment variables directly in the Vercel
project dashboard (Project → Settings → Environment Variables).

- Server-only secrets (`ZKLOGIN_SECRET`, `WALRUS_PII_MASTER_KEY` and, during
  a key rotation, `WALRUS_PII_PREVIOUS_MASTER_KEY`,
  `INTERNAL_NOTIFY_SECRET`, `CRON_SECRET`,
  `ENOKI_API_KEY_TESTNET`/`ENOKI_API_KEY_MAINNET`, ramp secrets, etc.) must
  **not** carry the `NEXT_PUBLIC_` prefix, so Next.js keeps them off the client
  bundle.
- `NEXT_PUBLIC_*` values must be present at build time, before `next build`.
- Cron jobs (your-turn nudges, circle-event relays, Walrus renewal) are
  declared in [`vercel.json`](../vercel.json)
  and authenticate with `CRON_SECRET`.

Validate the local env before deploying:

```bash
npm run validate:env
```

## Rotating the WhatsApp PII keys

`WALRUS_PII_MASTER_KEY` encrypts each linked WhatsApp number or group id
(AES-256-GCM) before the app uploads it to Walrus. The encrypted envelope
doesn't say which key sealed it, and a Walrus blob can't be changed once it is
stored, so a blob opens only with the key that was current when it was written.
Replacing the key on its own makes every existing link unreadable: circle
notifications, member lookups, the webhook's fallback scan and the daily blob
renewal all fail, and the blobs then lapse unrenewed.

`WALRUS_PII_PREVIOUS_MASTER_KEY` makes a rotation safe. While it is set, the app
decrypts with the current key first and falls back to the previous one (the GCM
authentication tag shows which key sealed an envelope). Everything the app
encrypts, renewals included, uses the current key. The renewal cron
(`/api/cron/walrus-renewal`, daily at 03:00 UTC) re-stores each blob before its
lease runs out, so every blob moves to the new key within one lease. Leave the
variable empty outside a rotation. `npm run validate:env` rejects a previous key
that equals the master key or doesn't decode to 32 bytes.

### Rotating `WALRUS_PII_MASTER_KEY`

1. Get the current key's value. Vercel doesn't show a Sensitive variable's value
   again, so it has to come from wherever you stored it. Without it, the
   existing links can't be read.
2. Generate the new key: `openssl rand -hex 32`.
3. In every Vercel environment whose database holds linked numbers (Production
   at least), set both variables before you redeploy:
   - `WALRUS_PII_PREVIOUS_MASTER_KEY`: the current (old) key
   - `WALRUS_PII_MASTER_KEY`: the new key

   Both are server-only secrets: mark them Sensitive, and never give either a
   `NEXT_PUBLIC_` name.
4. Redeploy. Vercel applies environment changes only to new deployments. Note
   the first 03:00 UTC after the new deployment went live: every renewal from
   that cron run on uses the new key.
5. Wait until both of these hold:
   - At least `WALRUS_STORAGE_EPOCHS` Walrus epochs have passed since that time
     (5 by default, or the largest value the app has used; a Walrus epoch is a
     day on testnet and two weeks on mainnet). Every blob sealed with the old
     key was stored for at most that long, so by then none of them is served.
     That includes the original blobs the on-chain link anchors point at:
     renewal updates only `whatsapp_phone_index`, and the app's on-chain
     fallbacks still read the anchors.
   - This query, run against the production database with your timestamp,
     returns no rows. It lists the index rows with no renewal since that cron
     run, each recorded in `walrus_renewal_audit`:

     ```sql
     SELECT idx.id, idx.circle_id
       FROM whatsapp_phone_index idx
      WHERE NOT EXISTS (
              SELECT 1
                FROM walrus_renewal_audit audit
               WHERE audit.index_row_id = idx.id
                 AND audit.renewed_at >= TIMESTAMPTZ '2026-10-03 03:00:00+00'
            );
     ```

     A row linked after the deploy is already on the new key and drops off the
     list at its first renewal. A row that never drops off is one the cron
     fails to re-store; its `[walrus-renewal] blob renewal failed` log line
     names the row id and the error. If that blob's lease has already run out,
     the link is broken with or without the old key, and the circle admin has to
     link WhatsApp again.
6. Delete `WALRUS_PII_PREVIOUS_MASTER_KEY` and redeploy. Then destroy your
   copies of the old key.

To back out part-way, swap the two values instead of deleting one: blobs
written since the deploy are sealed with the new key. A log line saying a PII
envelope "opens with neither WALRUS_PII_MASTER_KEY nor
WALRUS_PII_PREVIOUS_MASTER_KEY" means the previous key isn't the one that
sealed that blob.

A rotation protects what the app encrypts from then on. It doesn't take back
what the old key already sealed: Walrus blobs are public and their ids are on
chain, so anyone with the old key and a copy of an old blob can read the number
in it. If the old key leaked, treat every number linked before the rotation as
disclosed.

### `WALRUS_LOOKUP_SALT` has no rotation path

The salt keys the HMAC in `whatsapp_phone_index.phone_hmac`, the column an
inbound message is matched on. No job re-keys that column, so a new salt leaves
every existing row unmatchable by phone:

- Messages from numbers linked before the change don't find their circles in
  the index. The webhook falls back to scanning the on-chain anchors, whose
  original blobs have usually lapsed.
- `scripts/process-deletion-request.mjs` can't find those rows by phone.

Rotating the salt safely needs that job written first. For each index row it
would decrypt the blob, compute the HMAC of the normalized number or group id
under the new salt, and update `phone_hmac`. It would also have to keep honoring
completed deletion requests: they recorded `phone_hmac` under the old salt, and
the renewal cron skips the rows that match one. Until the job exists, don't
change the salt. It matters only together with a copy of the index table (with
both, someone can test candidate numbers against `phone_hmac`), and a new salt
wouldn't protect a table that has already leaked.
