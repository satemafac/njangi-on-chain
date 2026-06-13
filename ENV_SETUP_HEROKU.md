# Heroku Env Setup — retired (Vercel migration, June 2026)

> **Legacy.** Njangi deploys on **Vercel**, not Heroku. The old
> `scripts/heroku/sync-config.sh` config-sync workflow has been removed.

Set environment variables directly in the Vercel project dashboard
(Project → Settings → Environment Variables). There is no sync script.

- Canonical env guide: [`docs/environment.md`](/Volumes/Developing/njangi-on-chain/docs/environment.md)
- Vercel deploy runbook: [`README.md`](/Volumes/Developing/njangi-on-chain/README.md)
  and [`CLAUDE.md`](/Volumes/Developing/njangi-on-chain/CLAUDE.md) ("Vercel deploy")

Constraints carried over from the old workflow:

- `NEXT_PUBLIC_*` values must be present at build time, before `next build`.
- Server-only secrets must **not** carry the `NEXT_PUBLIC_` prefix, so Next.js
  keeps them off the client bundle.

Validate the local env before deploying:

```bash
npm run validate:env
```
