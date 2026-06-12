# Heroku Procfile - legacy deployment (Vercel migration in progress, June 2026)
# Web process:    Next.js frontend on default port (cutover to Vercel pending)
# Bot process:    WhatsApp bot backend on port 3001
#
# The former `notifier` process (scripts/cycle-finalized-notifier.mjs) was
# replaced by the Vercel cron at /api/cron/cycle-finalized (see vercel.json);
# the script remains for local development only.

web: npm start
bot: cd whatsapp-bot-backend && (npm ci --legacy-peer-deps 2>/dev/null || npm install --legacy-peer-deps) && npm start
