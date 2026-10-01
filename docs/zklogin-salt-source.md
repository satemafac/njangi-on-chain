# zkLogin Salt Source (internal)

_Last updated: 2026-10-01. Replaces the root-level `ENOKI_MIGRATION.md`.
Companion: CLAUDE.md, "Address-affecting configuration"._

## Today: Enoki only

`getUserSalt` in `src/services/enokiZkLoginService.ts` sends the Enoki API key
and the user's JWT to `GET https://api.enoki.mystenlabs.com/v1/zklogin` and
uses the salt Enoki returns. There is no other salt source and no fallback.
zkProofs come from Enoki too (`/v1/zklogin/zkp`). Enoki derives the salt per
user per Enoki application, so rotating a key within the application moves no
address. Changing the application, an OAuth client id or the provider does.

The key lives in the server-only `ENOKI_API_KEY_TESTNET` /
`ENOKI_API_KEY_MAINNET`. `ENOKI_MIGRATION.md` told readers to set
`NEXT_PUBLIC_ENOKI` instead. Never do that: a `NEXT_PUBLIC_*` value is inlined
into the browser bundle, which is how the `9b2ce…` key leaked.

If an old `.env` still sets `NEXT_PUBLIC_SALT_SERVICE_URL`,
`NEXT_PUBLIC_PROVER_FRONTEND_URL`, `SALT_SERVICE_URL` or
`SALT_ALLOWED_AUDIENCES`, delete them. Nothing reads them.

## Before Enoki (all deleted)

The app has taken salts only from Enoki since 2025-05-24 (`11b5e7b`).

| Implementation | Added | Deleted |
|---|---|---|
| `src/services/salt-service.ts` | `876a9d8` 2025-01-16 | `6ed7320` 2026-06-12 |
| `/api/salt` + `src/services/local-salt-service.ts` (in-memory) | `7cf86e8` 2025-03-04 | `6ed7320` 2026-06-12 |
| Root `index.ts`: the entrypoint of the Heroku salt service | `9c85ef6` 2025-05-05 | `3390a01` 2026-08-29 |
| `src/services/persistent-salt-service.ts` + `postgres-adapter.ts`, `Procfile.zklogin`, `Dockerfile.salt`, `heroku.yml` | `9965fb7` / `9eb5a42` 2025-05-05 | with this page |
| `start-local-salt-service.sh`, `db-check.cjs` + `package-db-check.json` | `7cf86e8` 2025-03-04 | with this page |
| `zklogin-switch.sh`, `zklogin-services.md`, `ZKLOGIN-SERVICES-README.md` | `a91da60` 2025-05-05 | with this page |

## Kept on purpose: the `salts` and `recovery_codes` tables

`npm run migrate:postgres` still creates both tables, and nothing writes to
them. `scripts/process-deletion-request.mjs` still deletes the legacy rows of a
verified identity, so keep both tables while that is true.

Deleting a row there does not touch the salt Enoki holds, so it cannot lock a
live wallet. The deletion form, the privacy policy and
`records-of-processing.md` still call this step erasing the wallet's salt.
That copy predates Enoki and needs owner and counsel review before it changes.

## Outside the repo: three Heroku apps

On 2026-10-01, `zklogin-salt-service`, `zklogin-backend-fix3` and
`zklogin-frontend-fix3` answered with Heroku's "Application Error" page
(HTTP 503). A deleted app answers "No such app" (404) instead, so all three
still exist even though nothing runs on them.

The salt service ran with `USE_POSTGRES=true`, so check
`heroku addons -a zklogin-salt-service` for a Postgres database. Its legacy
`salts` / `recovery_codes` rows are keyed by real OAuth subs. Handle those rows
the way the deletion policy requires, then run `heroku apps:destroy` on all
three apps. `ENOKI_MIGRATION.md` already listed these apps for removal "after
testing".
