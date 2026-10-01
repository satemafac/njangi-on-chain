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

- Server-only secrets (`ZKLOGIN_SECRET`, `WALRUS_PII_MASTER_KEY`,
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
