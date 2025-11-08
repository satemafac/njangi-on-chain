# Heroku Environment Variables Setup

## Quick Start

```bash
# 1. Create your env file
cp .env.heroku.example .env.heroku

# 2. Edit with your values
nano .env.heroku

# 3. Set on Heroku (one command)
heroku config:set --app njangi-on-chain $(cat .env.heroku | grep -v '^#' | grep -v '^$' | tr '\n' ' ')

# 4. Verify
heroku config -a njangi-on-chain
```

## Environment Variables by Process

### Frontend (Web Process - Next.js)
Variables visible in browser must use `NEXT_PUBLIC_` prefix:
- `NEXT_PUBLIC_*_RPC_URL`
- `NEXT_PUBLIC_*_PACKAGE_ID`
- `NEXT_PUBLIC_*_ENOKI`
- `NEXT_PUBLIC_ZKLOGIN_*_CLIENT_ID` (public IDs only!)

### Backend (Bot Process - Node.js)
All variables available (including secrets):
- `ZKLOGIN_*_ENOKI_KEY` (server-side keys)
- `ZKLOGIN_*_CLIENT_SECRET` (never in frontend!)
- `WHATSAPP_*` (API credentials)

## Getting Your Credentials

### 1. Sui Network Packages
From your deployments:
```bash
# See what you deployed
git log --oneline | head -5

# Your current testnet packages:
NEXT_PUBLIC_TESTNET_PACKAGE_ID=0xd530bfd7511ac2d343646a8ca4e2e14ffb89e1ec69a38ff8fb99c415706d6154
NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID=0x2ee55011e9d3c27a2743f83fb9f4498de8cdb6078cc175bec03362326f9ec1a1
NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID=0x65fad7ceeb6a960af0702280052c85b9e4e467f33531e9b8d3f08c6244bf0150
```

### 2. zkLogin / Enoki Keys
From https://dev.enoki.mystenlabs.com:
```bash
# Testnet Enoki key
ZKLOGIN_TESTNET_ENOKI_KEY=ek_...

# Mainnet Enoki key  
ZKLOGIN_MAINNET_ENOKI_KEY=ek_...

# Default (usually testnet for dev)
ZKLOGIN_DEFAULT_ENOKI_KEY=ek_...
```

### 3. OAuth Provider Credentials
**Google:**
- Go to: https://console.cloud.google.com
- Create OAuth 2.0 credentials
- Redirect URI: `https://njangi-on-chain.herokuapp.com/api/auth/callback`
- Get: `ZKLOGIN_GOOGLE_CLIENT_ID` and `ZKLOGIN_GOOGLE_CLIENT_SECRET`

**Facebook:**
- Go to: https://developers.facebook.com
- Create app > Facebook Login
- Redirect URI: `https://njangi-on-chain.herokuapp.com/api/auth/callback`
- Get: `ZKLOGIN_FACEBOOK_CLIENT_ID` and `ZKLOGIN_FACEBOOK_CLIENT_SECRET`

**Apple:**
- Go to: https://developer.apple.com
- Create Sign in with Apple app
- Redirect URI: `https://njangi-on-chain.herokuapp.com/api/auth/callback`
- Get: `ZKLOGIN_APPLE_CLIENT_ID` and `ZKLOGIN_APPLE_CLIENT_SECRET`

### 4. WhatsApp Cloud API Credentials
From Meta Business Platform > WhatsApp:
- Phone Number ID: Shows in Settings > API Setup
- Access Token: Generate under System User
- Business Account ID: In Account Settings
- Verify Token: Create your own (random string)
- App Secret: From App Settings

```bash
# Your credentials (from the screenshot):
WHATSAPP_PHONE_NUMBER_ID=981828818344477
WHATSAPP_ACCESS_TOKEN=EAAKXb13PeesBP0KAQ...
WHATSAPP_BUSINESS_ACCOUNT_ID=698579130000
WHATSAPP_VERIFY_TOKEN=ABC123
```

## Heroku Deployment Flow

```
Your Local Machine
  ├─ .env.local (frontend)
  ├─ whatsapp-bot-backend/.env.local (backend)
  └─ Procfile (process definitions)
        ↓
        git push heroku main
        ↓
Heroku Config Variables (shared by all processes)
  ├─ NEXT_PUBLIC_* (frontend + backend can read)
  ├─ ZKLOGIN_* (backend only)
  └─ WHATSAPP_* (backend only)
        ↓
    ┌─────────────────┬─────────────────┐
    │   Web Process   │   Bot Process   │
    │   (Next.js)     │  (Node.js)      │
    │   Port 3000     │  Port 3001      │
    └─────────────────┴─────────────────┘
```

## Setting Variables on Heroku

### Option 1: CLI (Recommended)
```bash
# Set multiple at once
heroku config:set \
  NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID=0x65fad7ceeb6a960af0702280052c85b9e4e467f33531e9b8d3f08c6244bf0150 \
  WHATSAPP_PHONE_NUMBER_ID=981828818344477 \
  --app njangi-on-chain
```

### Option 2: From File
```bash
# Create env file with KEY=VALUE format (no comments)
cat > .env.heroku << 'ENVEOF'
NEXT_PUBLIC_TESTNET_PACKAGE_ID=0x...
WHATSAPP_PHONE_NUMBER_ID=981828818344477
ENVEOF

# Set all at once
heroku config:set --app njangi-on-chain $(cat .env.heroku | tr '\n' ' ')
```

### Option 3: Dashboard
https://dashboard.heroku.com/apps/njangi-on-chain/settings
- Reveal Config Vars
- Add Key/Value pairs manually

## Verifying Setup

```bash
# View all config
heroku config -a njangi-on-chain

# Get specific variable
heroku config:get NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID -a njangi-on-chain

# Check both processes started
heroku ps -a njangi-on-chain

# Monitor logs
heroku logs -a njangi-on-chain --tail

# Test webhook
# Send message to WhatsApp bot → should see in logs
```

## Troubleshooting

### Variables Not Loading
```bash
# Variables are case-sensitive
# Make sure names match exactly

# Check if set correctly
heroku config:get VARIABLE_NAME -a njangi-on-chain

# If empty, needs to be set
heroku config:set VARIABLE_NAME=value -a njangi-on-chain
```

### Bot Process Failing
```bash
# Check logs
heroku logs -a njangi-on-chain --dyno=bot --tail

# Common issues:
# 1. Missing WHATSAPP_* variables → bot can't start
# 2. Missing ZKLOGIN_*_ENOKI_KEY → event listener fails
# 3. Database connection → not needed for bot

# Restart process
heroku ps:restart bot -a njangi-on-chain
```

### Webhook Not Receiving Messages
1. **Check webhook URL** (should match in WhatsApp dashboard)
   - Should be: `https://njangi-on-chain.herokuapp.com/api/whatsapp/webhook`

2. **Check verify token** (must match in WhatsApp dashboard)
   ```bash
   heroku config:get WHATSAPP_VERIFY_TOKEN -a njangi-on-chain
   ```

3. **Check logs** (should see incoming requests)
   ```bash
   heroku logs -a njangi-on-chain --tail | grep webhook
   ```

4. **Resend subscription** (WhatsApp dashboard > Configure Webhooks)

## Next Steps

1. ✅ Fill in `.env.heroku` with your credentials
2. ✅ Set all variables on Heroku
3. ✅ Deploy: `git push heroku main`
4. ✅ Verify both processes running: `heroku ps`
5. ✅ Check logs: `heroku logs --tail`
6. ✅ Test webhook by sending WhatsApp message

Good luck! 🚀
