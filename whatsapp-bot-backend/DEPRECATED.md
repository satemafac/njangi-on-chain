# DEPRECATED — folded into the Next.js app (June 2026)

This standalone Express service is retired. It was an HTTP server on
`:3001` that the June 2026 ops-readiness audit verified as **unreachable
in the deploy layout** (a non-`web` Heroku process type receives no
routed traffic; on Vercel a second server cannot exist at all), with a
non-reproducible build (gitignored `package-lock.json` + `dist/`,
`@mysten/sui.js` pinned to a different major than the root) and handlers
written against an on-chain registry schema that no longer exists
(plaintext `admin_phone_number`; the chain now anchors only Walrus blob
ids).

Everything it actually did now lives in the main app. **This directory
is kept only until cutover and will then be deleted** (also remove
`whatsapp-bot-backend/src` from `jest.config.cjs` `roots` at that time).
Do not add code here.

## Where the functionality went

| Bot backend | Replacement |
| --- | --- |
| `circle-link-listener.service.ts` (5s polling daemon over 11 event streams, started by `server.ts`) | `GET /api/cron/whatsapp-circle-events` (Vercel cron, every minute) + `src/lib/whatsapp-bot/circle-events.ts` (stream definitions/messages) + `src/lib/whatsapp-bot/circle-phone.ts` (circle → phone via Postgres index → Walrus decrypt → registry scan) |
| In-memory `processedEvents` / `sentMessages` dedupe | Durable Postgres state: per-stream cursors + fenced run leases in `cycle_finalized_cursor` (namespaced keys), per-notification claims in `whatsapp_notifications` (`kind = 'circle_event'`) via `src/lib/whatsapp-notifier.ts` |
| `whatsapp-sender.service.ts` (own Graph API client, Meta templates + text fallback) | `sendMemberNotification` in `src/lib/whatsapp-notifier.ts` — the single Graph API client. Bodies are the bot's text fallbacks; re-introducing Meta template sends is a deliberate follow-up, not a port blocker |
| `lookupMemberName` (HTTP call to `/api/join-requests/lookup-user`) | In-process `joinRequestDatabase.getUserByAddress` import inside the cron |
| `GET /api/whatsapp/webhook` (hub verification), `POST /api/whatsapp/webhook` (empty stub) | `src/pages/api/whatsapp/webhook.ts` — already handled verification, HMAC-enforced signatures, and `/status` + `help` command dispatch before the fold-in |
| `POST /api/whatsapp/send` (stub: returned a fake message id, sent nothing) | Not ported — it had no behavior. Real sends go through `sendMemberNotification` |
| `GET /health`, `GET /api/status`, `GET /api/whatsapp/{integration,analytics,queue}` (hardcoded zeros/status strings) | Not ported — stub data, no consumers. Send outcomes are queryable in the `whatsapp_notifications` audit table |
| `src/pages/api/**` (Next-style routes inside the bot) | Dead code — never mounted by `server.ts`; the main app's routes under `src/pages/api/whatsapp/` are the live equivalents |
| Remaining services (`cycle-reminder`, `message-queue`, `analytics`, `action-link-manager`, `webhook-handler`, …) | Dead code — only imported by the unmounted routes above. The cycle-finalized → "your turn" nudge is `/api/cron/cycle-finalized` |

## Caller cleanup

* `src/services/event-forwarder.service.ts` — deleted. It was the only
  app-side caller of `:3001` (via `WHATSAPP_BACKEND_URL`,
  `CIRCLE_BACKEND_URL`, `ANALYTICS_URL`), was imported by nothing, and
  targeted `/api/events/*` routes this server never registered.
* `package.json` — `build:bot` removed; `npm run build` is `next build`
  again.
* `Procfile` — the `bot` process entry removed.
* `.env.example` / `scripts/validate-env.mjs` — bot-only vars
  (`BACKEND_AUTH_TOKEN`, `*_BACKEND_URL`, `ANALYTICS_URL`, `REDIS_URL`,
  `LOG_LEVEL`, `LOG_FILE`, `ENABLE_*`) removed/flagged;
  `WHATSAPP_WEBHOOK_URL` now points at the app's own webhook;
  `WHATSAPP_EVENTS_MAX_EVENT_AGE_MS` documented for the new cron.
