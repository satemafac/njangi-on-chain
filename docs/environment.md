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

## Hosted environments

Heroku config vars remain app-scoped. The repo standardizes on one schema, not one physical hosted file.

- single Heroku app with `web` + `bot` dynos: sync the full root env
- separate frontend and bot apps: sync filtered subsets from the same root env

Use [`scripts/heroku/sync-config.sh`](/Volumes/Developing/njangi-on-chain/scripts/heroku/sync-config.sh):

```bash
# One Heroku app
./scripts/heroku/sync-config.sh --app njangi-on-chain --dry-run

# Separate frontend and bot apps
./scripts/heroku/sync-config.sh --frontend-app njangi-web --bot-app njangi-bot --dry-run
```
