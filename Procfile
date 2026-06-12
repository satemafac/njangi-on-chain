# Heroku Procfile - legacy deployment (Vercel migration in progress, June 2026)
# Web process:    Next.js frontend on default port (cutover to Vercel pending)
#
# The former `notifier` process (scripts/cycle-finalized-notifier.mjs) was
# replaced by the Vercel cron at /api/cron/cycle-finalized (see vercel.json).
# The former `bot` process (whatsapp-bot-backend) was folded into the app as
# the /api/cron/whatsapp-circle-events Vercel cron — see
# whatsapp-bot-backend/DEPRECATED.md.

web: npm start
