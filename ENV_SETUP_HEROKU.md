# Heroku Env Setup

The canonical env workflow is documented in [`docs/environment.md`](/Volumes/Developing/njangi-on-chain/docs/environment.md).

## Default deployment mode

The repo’s default hosted topology is one Heroku app with both dynos from the shared `Procfile`.

Sync the full root env:

```bash
./scripts/heroku/sync-config.sh --app njangi-on-chain --dry-run
./scripts/heroku/sync-config.sh --app njangi-on-chain
```

## Separate frontend and bot Heroku apps

Use the same root env schema, but sync filtered subsets to each app:

```bash
./scripts/heroku/sync-config.sh \
  --frontend-app njangi-web \
  --bot-app njangi-bot \
  --dry-run
```

Important platform constraints:

- `NEXT_PUBLIC_*` values must exist on the frontend app before `next build`
- Heroku config vars are app-scoped, so split apps share one schema and one sync workflow, not one hosted file

## Validate before syncing

```bash
npm run validate:env
```
