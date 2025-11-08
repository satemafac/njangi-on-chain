# Heroku Procfile - Multi-process deployment
# Web process: Next.js frontend on default port
# Bot process: WhatsApp bot backend on port 3001

web: npm start
bot: cd whatsapp-bot-backend && npm ci --legacy-peer-deps || npm install --legacy-peer-deps && npm start
