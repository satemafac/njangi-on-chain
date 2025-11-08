# Heroku WhatsApp Webhook Setup

This guide explains how to deploy both your main Next.js app and WhatsApp bot backend to Heroku with separate environments.

## Architecture

```
Heroku App: njangi-on-chain
├── Web Process (Port 3000)
│   └── Next.js Frontend + Admin Dashboard
│       ├── Reads: NEXT_PUBLIC_* variables
│       └── Serves: /api/whatsapp/* endpoints
│
└── Bot Process (Port 3001)
    └── WhatsApp Bot Backend
        ├── Reads: All config variables
        ├── Runs: Event listener, message sender
        └── Listens: WebSocket for blockchain events
```

## Step 1: Configure Heroku Config Variables

You need to set environment variables on Heroku that both processes will share. However, since the bot backend needs DIFFERENT variables than the frontend, we use a naming convention.

### Frontend Variables (Next.js / `npm start`)

These use `NEXT_PUBLIC_` prefix (browser-accessible):

```bash
# Sui Network Config
NEXT_PUBLIC_TESTNET_RPC_URL=https://fullnode.testnet.sui.io:443
NEXT_PUBLIC_MAINNET_RPC_URL=https://fullnode.mainnet.sui.io:443
NEXT_PUBLIC_TESTNET_PACKAGE_ID=0xd530bfd7511ac2d343646a8ca4e2e14ffb89e1ec69a38ff8fb99c415706d6154
NEXT_PUBLIC_MAINNET_PACKAGE_ID=0x...

# WhatsApp Registry (Frontend)
NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID=0x2ee55011e9d3c27a2743f83fb9f4498de8cdb6078cc175bec03362326f9ec1a1
NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID=0x65fad7ceeb6a960af0702280052c85b9e4e467f33531e9b8d3f08c6244bf0150

# zkLogin / Enoki
NEXT_PUBLIC_TESTNET_ENOKI=your_testnet_enoki_key
NEXT_PUBLIC_MAINNET_ENOKI=your_mainnet_enoki_key
NEXT_PUBLIC_ENOKI=your_default_enoki_key

# OAuth Providers
NEXT_PUBLIC_ZKLOGIN_GOOGLE_CLIENT_ID=...
NEXT_PUBLIC_ZKLOGIN_FACEBOOK_CLIENT_ID=...
NEXT_PUBLIC_ZKLOGIN_APPLE_CLIENT_ID=...
```

### Bot Backend Variables (Node.js / `whatsapp-bot-backend`)

These DO NOT have `NEXT_PUBLIC_` prefix (server-side only):

```bash
# Sui Network Config (Bot Backend)
NEXT_PUBLIC_TESTNET_RPC_URL=https://fullnode.testnet.sui.io:443
NEXT_PUBLIC_MAINNET_RPC_URL=https://fullnode.mainnet.sui.io:443
NEXT_PUBLIC_TESTNET_PACKAGE_ID=0xd530bfd7511ac2d343646a8ca4e2e14ffb89e1ec69a38ff8fb99c415706d6154
NEXT_PUBLIC_MAINNET_PACKAGE_ID=0x...

# WhatsApp Registry (Backend - same as frontend)
NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID=0x2ee55011e9d3c27a2743f83fb9f4498de8cdb6078cc175bec03362326f9ec1a1
NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID=0x65fad7ceeb6a960af0702280052c85b9e4e467f33531e9b8d3f08c6244bf0150

# zkLogin / Enoki (Backend needs all keys)
ZKLOGIN_TESTNET_ENOKI_KEY=your_testnet_enoki_key
ZKLOGIN_MAINNET_ENOKI_KEY=your_mainnet_enoki_key
ZKLOGIN_DEFAULT_ENOKI_KEY=your_default_enoki_key

# OAuth - Client Secrets (only on backend!)
ZKLOGIN_GOOGLE_CLIENT_ID=...
ZKLOGIN_GOOGLE_CLIENT_SECRET=...
ZKLOGIN_FACEBOOK_CLIENT_ID=...
ZKLOGIN_FACEBOOK_CLIENT_SECRET=...
ZKLOGIN_APPLE_CLIENT_ID=...
ZKLOGIN_APPLE_CLIENT_SECRET=...

# WhatsApp Cloud API
WHATSAPP_PHONE_NUMBER_ID=981828818344477
WHATSAPP_ACCESS_TOKEN=EAAKXb13PeesBP0KAQ...
WHATSAPP_VERIFY_TOKEN=ABC123
WHATSAPP_APP_SECRET=53b58922cb5bfe562af7
WHATSAPP_WEBHOOK_URL=https://njangiionchain.com/api/whatsapp/webhook
WHATSAPP_BUSINESS_ACCOUNT_ID=698579130000

# Server Config
PORT=3000
LOG_LEVEL=info
ENABLE_MESSAGE_SENDER=true
ENABLE_EVENT_LISTENER=true
ENABLE_ON_CHAIN_LOGGING=true
```

### Set Variables on Heroku (CLI):

```bash
# Set all at once from a file
heroku config:set --app njangi-on-chain $(cat env-heroku.txt | tr '\n' ' ')

# Or one by one
heroku config:set -a njangi-on-chain NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID=0x65fad7ceeb6a960af0702280052c85b9e4e467f33531e9b8d3f08c6244bf0150
```

## Step 2: Update Procfile

Your current Procfile is good! Both processes will share the same environment variables:

```procfile
# Heroku Procfile - Multi-process deployment
web: npm start
bot: cd whatsapp-bot-backend && npm start
```

**How Heroku uses this:**
- `web` process: Runs `npm start` from root (Next.js)
- `bot` process: Runs `npm start` from `whatsapp-bot-backend/` (Node.js backend)
- Both can read all `NEXT_PUBLIC_*` and other env variables

## Step 3: Configure WhatsApp Webhook

Your WhatsApp webhook URL is already configured in the dashboard:

```
Callback URL: https://njangionchain.com/api/whatsapp/webhook
Verify token: ABC123 (set in WHATSAPP_VERIFY_TOKEN)
```

The webhook endpoint is defined in:
- **Frontend**: `/src/pages/api/whatsapp/webhook.ts` (handles verification & incoming messages)
- **Backend**: `whatsapp-bot-backend/src/server.ts` (also has `/api/whatsapp/webhook`)

### Which endpoint gets called?

**From WhatsApp Cloud API → Heroku:**
1. WhatsApp sends POST to `https://njangionchain.com/api/whatsapp/webhook`
2. Heroku routes to `web` process (Next.js) on port 3000
3. Next.js handles it in `/src/pages/api/whatsapp/webhook.ts`

The `bot` process (backend) runs independently and:
- Listens for Sui blockchain events
- Processes messages
- Doesn't directly receive WhatsApp webhooks (it's async)

## Step 4: Deploy to Heroku

```bash
# Make sure you're on main branch
git checkout main

# Add all changes
git add .

# Commit
git commit -m "chore: deploy whatsapp bot to heroku with dual processes"

# Push to Heroku
git push heroku main

# Monitor both processes
heroku logs -a njangi-on-chain --tail

# Check process status
heroku ps -a njangi-on-chain

# Scale processes
heroku ps:scale web=1 bot=1 -a njangi-on-chain
```

## Step 5: Verify Deployment

### Check Web Process (Frontend):
```bash
# Visit your app
https://njangi-on-chain.herokuapp.com/

# Check API
curl https://njangi-on-chain.herokuapp.com/health
```

### Check Bot Process (Backend):
```bash
# View logs
heroku logs -a njangi-on-chain --dyno=bot --tail

# Should see:
# 📋 Loading configuration...
# ✅ Configuration loaded successfully
# 🚀 Server listening on port 3001
```

### Test WhatsApp Webhook:
```bash
# WhatsApp will send verification request
# Check logs for "Webhook verified" message

# Send test message
heroku logs -a njangi-on-chain --tail

# Should see incoming message logged
```

## Environment Variable Mapping

| Variable Name | Used By | Purpose | Example |
|---|---|---|---|
| `NEXT_PUBLIC_*` | Frontend + Backend | Public config | Package IDs, RPC URLs |
| `ZKLOGIN_*_ENOKI_KEY` | Backend only | Enoki keys | Private - for transaction signing |
| `ZKLOGIN_*_CLIENT_SECRET` | Backend only | OAuth secrets | Private - never to frontend |
| `WHATSAPP_*` | Backend only | WhatsApp credentials | Private API tokens |
| `PORT` | Backend | Server port (3001 via Procfile) | 3000 for web, 3001 for bot |

## Troubleshooting

### Bot Process Not Starting
```bash
# Check logs
heroku logs -a njangi-on-chain --dyno=bot --tail

# Common issues:
# 1. Missing environment variables
# 2. Port already in use (shouldn't happen on Heroku)
# 3. Dependencies not installed

# Redeploy
git push heroku main
```

### WhatsApp Webhook Not Receiving Messages
1. Check bot process is running: `heroku ps -a njangi-on-chain`
2. Check webhook URL in WhatsApp dashboard matches your Heroku domain
3. Check logs: `heroku logs -a njangi-on-chain --tail`
4. Verify token matches: `echo $WHATSAPP_VERIFY_TOKEN`

### Config Variables Not Loading
```bash
# View all config
heroku config -a njangi-on-chain

# Check specific variable
heroku config:get NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID -a njangi-on-chain

# Add missing variable
heroku config:set VARIABLE_NAME=value -a njangi-on-chain
```

### Port Conflicts
- Frontend: Heroku automatically assigns port (we use `npm start`)
- Backend: Listens on port 3001 (internal to Heroku dyno)
- Both processes run on separate dyos, so no conflict

## Local Development vs Heroku

| Setting | Local Dev | Heroku |
|---|---|---|
| Frontend env | `.env.local` | Heroku config vars |
| Backend env | `whatsapp-bot-backend/.env.local` | Heroku config vars (same) |
| Port (Web) | 3000 | Assigned by Heroku |
| Port (Bot) | 3001 | Internal, not exposed |
| Webhook URL | `http://localhost:3000/api/whatsapp/webhook` | `https://njangi-on-chain.herokuapp.com/api/whatsapp/webhook` |

## Best Practices

1. ✅ Use `NEXT_PUBLIC_` prefix for variables that need to be in browser
2. ✅ Keep secrets (API keys, secrets) without the prefix
3. ✅ Use same `Procfile` for development and production
4. ✅ Test locally with same environment variable names as Heroku
5. ✅ Scale processes based on traffic: `heroku ps:scale bot=2 -a njangi-on-chain`
6. ✅ Monitor both processes: `heroku logs -a njangi-on-chain --tail`

7. ❌ Don't commit `.env.local` files
8. ❌ Don't use different env var names locally vs Heroku
9. ❌ Don't forget to set `WHATSAPP_WEBHOOK_URL` to production URL
10. ❌ Don't run both web and bot on same dyno (use separate dyos via Procfile)

## Next Steps

1. Create `env-heroku.txt` with all production variables
2. Set all config on Heroku
3. Update `.gitignore` if needed
4. Commit `Procfile` changes
5. Deploy: `git push heroku main`
6. Monitor: `heroku logs -a njangi-on-chain --tail`
7. Test webhook via WhatsApp

Good luck! 🚀

