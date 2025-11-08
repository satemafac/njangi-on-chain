# Heroku WhatsApp Webhook Deployment Checklist

## Pre-Deployment ✅

- [ ] Have your WhatsApp credentials ready
- [ ] Have Heroku CLI installed (`heroku --version`)
- [ ] Logged into Heroku (`heroku auth:whoami`)
- [ ] Heroku app created (`njangi-on-chain`)
- [ ] Git remote configured (`git remote -v | grep heroku`)
- [ ] All code committed to main branch
- [ ] Updated `.env` registry ID from previous step

## Procfile Setup ✅

- [ ] `Procfile` exists in root directory
- [ ] Contains both `web` and `bot` processes
  ```
  web: npm start
  bot: cd whatsapp-bot-backend && npm start
  ```
- [ ] Committed to git

## Environment Variables ✅

### Sui Network (All Processes)
- [ ] `NEXT_PUBLIC_TESTNET_RPC_URL`
- [ ] `NEXT_PUBLIC_MAINNET_RPC_URL`
- [ ] `NEXT_PUBLIC_TESTNET_PACKAGE_ID`
- [ ] `NEXT_PUBLIC_MAINNET_PACKAGE_ID`
- [ ] `NEXT_PUBLIC_PACKAGE_ID`

### WhatsApp Registry (All Processes)
- [ ] `NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID=0x2ee55011e9d3c27a2743f83fb9f4498de8cdb6078cc175bec03362326f9ec1a1`
- [ ] `NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID=0x65fad7ceeb6a960af0702280052c85b9e4e467f33531e9b8d3f08c6244bf0150`

### zkLogin / Enoki (All Processes)
- [ ] `NEXT_PUBLIC_TESTNET_ENOKI`
- [ ] `NEXT_PUBLIC_MAINNET_ENOKI`
- [ ] `NEXT_PUBLIC_ENOKI`
- [ ] `ZKLOGIN_TESTNET_ENOKI_KEY`
- [ ] `ZKLOGIN_MAINNET_ENOKI_KEY`
- [ ] `ZKLOGIN_DEFAULT_ENOKI_KEY`

### OAuth (Frontend & Backend)
- [ ] `NEXT_PUBLIC_ZKLOGIN_GOOGLE_CLIENT_ID`
- [ ] `ZKLOGIN_GOOGLE_CLIENT_SECRET`
- [ ] `NEXT_PUBLIC_ZKLOGIN_FACEBOOK_CLIENT_ID`
- [ ] `ZKLOGIN_FACEBOOK_CLIENT_SECRET`
- [ ] `NEXT_PUBLIC_ZKLOGIN_APPLE_CLIENT_ID`
- [ ] `ZKLOGIN_APPLE_CLIENT_SECRET`

### WhatsApp Cloud API (Backend Only)
- [ ] `WHATSAPP_PHONE_NUMBER_ID=981828818344477`
- [ ] `WHATSAPP_ACCESS_TOKEN=EAAKXb13PeesBP0KAQ...`
- [ ] `WHATSAPP_BUSINESS_ACCOUNT_ID=698579130000`
- [ ] `WHATSAPP_VERIFY_TOKEN` (random string)
- [ ] `WHATSAPP_APP_SECRET`
- [ ] `WHATSAPP_WEBHOOK_URL=https://njangi-on-chain.herokuapp.com/api/whatsapp/webhook`

### Server Config
- [ ] `NODE_ENV=production`
- [ ] `LOG_LEVEL=info`
- [ ] `ENABLE_MESSAGE_SENDER=true`
- [ ] `ENABLE_EVENT_LISTENER=true`
- [ ] `ENABLE_ON_CHAIN_LOGGING=true`

## Setting Variables on Heroku

Choose ONE method:

### Method 1: CLI (Recommended)
```bash
# Option A: Individual commands
heroku config:set NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID=0x65fad7ceeb6a960af0702280052c85b9e4e467f33531e9b8d3f08c6244bf0150 -a njangi-on-chain

# Option B: From file
cat > /tmp/heroku.env << 'ENVEOF'
NEXT_PUBLIC_TESTNET_PACKAGE_ID=0x...
WHATSAPP_PHONE_NUMBER_ID=981828818344477
ENVEOF

heroku config:set --app njangi-on-chain $(cat /tmp/heroku.env | grep -v '^#' | grep -v '^$' | tr '\n' ' ')
```

### Method 2: Dashboard
1. Go to: https://dashboard.heroku.com/apps/njangi-on-chain/settings
2. Click "Reveal Config Vars"
3. Add each KEY=VALUE pair
4. Save

## Verification ✅

```bash
# Check all variables set
heroku config -a njangi-on-chain

# Check critical ones
heroku config:get NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID -a njangi-on-chain
heroku config:get WHATSAPP_PHONE_NUMBER_ID -a njangi-on-chain
```

- [ ] All critical variables present
- [ ] No typos in variable names

## Deploy ✅

```bash
# Make sure on main branch
git checkout main

# Commit all changes
git add .
git commit -m "chore: deploy whatsapp bot with heroku webhook"

# Push to Heroku
git push heroku main
```

- [ ] Deployment started
- [ ] No compilation errors
- [ ] Both processes building

## Post-Deployment ✅

```bash
# Check processes
heroku ps -a njangi-on-chain

# Monitor logs
heroku logs -a njangi-on-chain --tail
```

- [ ] `web` process running (state: up)
- [ ] `bot` process running (state: up)
- [ ] No errors in startup logs

## WhatsApp Webhook Configuration ✅

1. Go to Meta Business Platform > WhatsApp > Settings
2. Under "Webhook" section:
   - [ ] Callback URL: `https://njangi-on-chain.herokuapp.com/api/whatsapp/webhook`
   - [ ] Verify Token: Matches `WHATSAPP_VERIFY_TOKEN` on Heroku
   - [ ] Click "Verify and Save"
   - [ ] Should show "Webhook verified"

## Testing ✅

```bash
# Watch logs in real-time
heroku logs -a njangi-on-chain --tail

# In another terminal, send test message to bot
# (use WhatsApp on phone, send to the test number)
```

- [ ] Sent test WhatsApp message
- [ ] Webhook received message (see in logs)
- [ ] Backend processed message
- [ ] Bot responded (or queued message)

## Troubleshooting ✅

If processes fail:
```bash
# Check web process logs
heroku logs -a njangi-on-chain --dyno=web --tail

# Check bot process logs
heroku logs -a njangi-on-chain --dyno=bot --tail

# Restart if needed
heroku ps:restart web -a njangi-on-chain
heroku ps:restart bot -a njangi-on-chain
```

- [ ] Identified issue
- [ ] Fixed in code or env vars
- [ ] Redeployed if needed

## Common Issues ✅

### Bot process won't start
- Check: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `ZKLOGIN_*_ENOKI_KEY`
- All must be set!

### Webhook not receiving messages
- Verify: Callback URL matches exactly in WhatsApp dashboard
- Verify: Token matches `WHATSAPP_VERIFY_TOKEN`
- Check: Webhook verification shows "✓ Verified"

### Messages not sending
- Check: Bot process logs for errors
- Verify: `WHATSAPP_ACCESS_TOKEN` is valid
- Verify: Phone number format is correct (E.164)

## Success! 🎉

- [ ] Both web and bot processes running
- [ ] WhatsApp webhook verified
- [ ] Received and responded to test message
- [ ] Logs show no errors
- [ ] Ready for production!

## Next Steps

1. Monitor logs: `heroku logs -a njangi-on-chain --tail`
2. Scale if needed: `heroku ps:scale bot=2 -a njangi-on-chain`
3. Add alerting: Configure Heroku alerts
4. Keep backups: Save env vars somewhere safe
5. Document: Update team wiki with setup

## Rollback Plan

If something goes wrong:
```bash
# Revert last deploy
git revert HEAD
git push heroku main

# Or rollback to previous version
heroku releases -a njangi-on-chain
heroku releases:rollback v123 -a njangi-on-chain
```

---

**Deployment Date:** _______________  
**Deployed By:** _______________  
**Notes:** _______________
