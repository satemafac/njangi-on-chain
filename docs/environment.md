# Environment Configuration

The repo now uses one canonical local env file:

- local source of truth: [`/.env.local`](/Volumes/Developing/njangi-on-chain/.env.local)
- template: [`/.env.example`](/Volumes/Developing/njangi-on-chain/.env.example)

## Local development

1. Copy [`/.env.example`](/Volumes/Developing/njangi-on-chain/.env.example) to `/.env.local`.
2. Fill in the canonical keys only.
3. Run `npm run validate:env`.

The WhatsApp bot backend auto-loads the repo root `/.env.local`. `whatsapp-bot-backend/.env.local` is no longer the default source and can be removed after you migrate.

If you explicitly need a different file for the bot, set `NJANGI_ENV_FILE=/abs/path/to/file`.

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
- `NEXT_PUBLIC_ENOKI_TESTNET`
- `NEXT_PUBLIC_ENOKI_MAINNET`

Keep server/runtime keys unprefixed:

- `WHATSAPP_*`
- `DATABASE_URL`
- `BACKEND_AUTH_TOKEN`
- `FRONTEND_URL`
- `WHATSAPP_BACKEND_URL`
- `CIRCLE_BACKEND_URL`
- `ANALYTICS_URL`

## Deprecated aliases

The app still tolerates these as one-release shims and warns when it uses them:

- `NEXT_PUBLIC_PACKAGE_ID`
- `NEXT_PUBLIC_WHATSAPP_PACKAGE_ID`
- `NEXT_PUBLIC_WHATSAPP_REGISTRY_ID`
- `SUI_WHATSAPP_LINKS_REGISTRY_ID`
- `NEXT_PUBLIC_ENOKI`
- `NEXT_PUBLIC_SUI_RPC_URL`
- `NEXT_PUBLIC_SUI_GRAPHQL_URL`
- `SUI_GRAPHQL_URL`
- `TESTNET_GRAPHQL_URL`
- `MAINNET_GRAPHQL_URL`

If a canonical key and a legacy alias are both set with different values, startup fails.

## Hosted environment (Vercel)

The app deploys on **Vercel**; production Postgres is **Neon**. There is no
per-app config-sync script — set environment variables directly in the Vercel
project dashboard (Project → Settings → Environment Variables).

- Server-only secrets (`ZKLOGIN_SECRET`, `WALRUS_PII_MASTER_KEY`,
  `INTERNAL_NOTIFY_SECRET`, `CRON_SECRET`, ramp secrets, etc.) must **not**
  carry the `NEXT_PUBLIC_` prefix, so Next.js keeps them off the client bundle.
- `NEXT_PUBLIC_*` values must be present at build time, before `next build`.
- Cron jobs (your-turn nudges, circle-event relays, Walrus renewal) are
  declared in [`vercel.json`](/Volumes/Developing/njangi-on-chain/vercel.json)
  and authenticate with `CRON_SECRET`.

Validate the local env before deploying:

```bash
npm run validate:env
```
