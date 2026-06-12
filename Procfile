# Heroku Procfile - Multi-process deployment
# Web process:    Next.js frontend on default port
# Bot process:    WhatsApp bot backend on port 3001
# Notifier:       Phase 7 CycleFinalized → WhatsApp nudge worker. Requires
#                 PACKAGE_ID, NOTIFY_ENDPOINT, and INTERNAL_NOTIFY_SECRET
#                 on the worker dyno (NOTIFY_ENDPOINT should point at the
#                 web dyno's /api/whatsapp/notify/your-turn path).

web: npm start
bot: cd whatsapp-bot-backend && (npm ci --legacy-peer-deps 2>/dev/null || npm install --legacy-peer-deps) && npm start
notifier: npm run notifier:cycle-finalized
