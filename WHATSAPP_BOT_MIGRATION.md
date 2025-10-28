# WhatsApp Bot Migration: Automation Service → Dedicated Backend

## Overview

The old in-process **Automation Service** (`automation-cron.service.ts`) has been **disabled** and replaced with a dedicated **WhatsApp Bot Backend Service** (`whatsapp-bot-backend/`).

## Why Migrate?

### Old System (Automation Service)
- ❌ Ran in-process with the main Next.js app
- ❌ Required `ADMIN_PRIVATE_KEY` in main app environment
- ❌ Monolithic - all logic coupled together
- ❌ Limited observability
- ❌ Hard to scale independently
- ❌ Performance impact on main app

### New System (WhatsApp Bot Backend)
- ✅ Runs as **independent microservice**
- ✅ Separate environment & configuration
- ✅ **Event-driven architecture** (blockchain events → WhatsApp)
- ✅ Comprehensive monitoring & logging
- ✅ Scales independently
- ✅ No impact on main Next.js app performance

## What Changed

### Disabled
```typescript
// src/pages/_app.tsx (lines 55-74)
// ❌ DISABLED: fetch('/api/automation/start', { method: 'POST' })
```

**Reason**: The automation service tried to start on page load, requiring `ADMIN_PRIVATE_KEY` in the main app environment. This is no longer needed.

### New Architecture

**Event Flow:**
```
Sui Blockchain Events
    ↓
WhatsApp Bot Backend Service (separate process)
    ├─ Fetches on-chain data
    ├─ Formats messages
    ├─ Enforces rate limits
    ├─ Sends via WhatsApp API
    └─ Logs on-chain
    ↓
WhatsApp Notifications
```

## Migration Steps

### 1. Remove Automation Service from Main App ✅
- Disabled the auto-start in `_app.tsx`
- Main app no longer requires `ADMIN_PRIVATE_KEY`

### 2. Run WhatsApp Bot Backend Service
```bash
cd whatsapp-bot-backend
npm install
npm start
```

### 3. Configure Environment
```bash
# whatsapp-bot-backend/.env.local
SUI_TESTNET_RPC_URL=https://testnet-rpc.sui.io
SUI_MAINNET_RPC_URL=https://fullnode.mainnet.sui.io
# ... other vars (see .env.example)
```

### 4. Verify Health Checks
```bash
# Main app (Next.js) - should be healthy
curl http://localhost:3000/health

# Bot backend - should be healthy
curl http://localhost:3001/health
```

## Files Modified

### src/pages/_app.tsx
- Disabled `fetch('/api/automation/start', { method: 'POST' })`
- Added explanatory comments about migration

### Files NOT Deleted (kept for reference)
- `src/services/automation-*.ts` - Old automation services
- `src/pages/api/automation/` - Old automation endpoints
- `AUTOMATION_SETUP.md` - Old setup docs

**Note**: These can be deleted in a future cleanup task if no longer needed.

## Environment Variables

### Main App (Next.js) - NO LONGER NEEDS
```
❌ ADMIN_PRIVATE_KEY  ← This is now handled by whatsapp-bot-backend
```

### WhatsApp Bot Backend - REQUIRES
```
SUI_TESTNET_PACKAGE_ID=0x...
SUI_MAINNET_PACKAGE_ID=0x...
SUI_TESTNET_RPC_URL=https://...
SUI_MAINNET_RPC_URL=https://...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_BUSINESS_ACCOUNT_ID=...
WHATSAPP_PHONE_NUMBER_ID=...
# ... etc
```

See `whatsapp-bot-backend/.env.example` for complete list.

## Health Check Endpoints

### Main App Health
```
GET http://localhost:3000/health
Response:
{
  "status": "healthy",
  "timestamp": "2025-01-XX...",
  "uptime": 123.45,
  "environment": "production"
}
```

### Bot Backend Health
```
GET http://localhost:3001/health
Response:
{
  "status": "healthy",
  "timestamp": "2025-01-XX...",
  "uptime": 123.45,
  "environment": "production"
}
```

### Bot Backend Status
```
GET http://localhost:3001/api/status
Response:
{
  "service": "WhatsApp Bot Backend",
  "version": "0.1.0",
  "environment": "production",
  "timestamp": "2025-01-XX...",
  "config": {
    "eventListenerEnabled": true,
    "messageSenderEnabled": true,
    "onChainLoggingEnabled": true,
    "whatsappConfigured": true,
    "suiConfigured": true,
    "zkLoginConfigured": true
  }
}
```

## Monitoring

### Main App (Next.js)
```bash
npm run dev
# or
npm start
```

### Bot Backend
```bash
cd whatsapp-bot-backend
npm start
```

### Docker Deployment
```bash
cd whatsapp-bot-backend
docker-compose up
```

## Troubleshooting

### Main App Errors
**Problem**: `Cannot find module 'automation-cron.service'`
- ✅ **FIXED**: Service is disabled in `_app.tsx`, no longer loaded

**Problem**: Missing `ADMIN_PRIVATE_KEY`
- ✅ **FIXED**: No longer required in main app

### Bot Backend Errors
**Problem**: Health check fails at `localhost:3001/health`
- Check if bot backend is running
- Verify `.env.local` has required variables
- Check logs: `whatsapp-bot-backend/logs/`

## Next Steps

1. ✅ Disable automation in main app (DONE)
2. ⏳ Task 5: Develop Data Fetcher Service
3. ⏳ Task 6: Build Message Builder Service
4. ⏳ Task 7-9: Complete notification pipeline
5. ⏳ Task 10-11: APIs & Frontend
6. ⏳ Task 12: Monitoring & Testnet Validation

## Future Cleanup

In a future sprint, consider:
- Removing old `src/services/automation-*.ts` files
- Removing `src/pages/api/automation/` endpoints
- Updating/removing `AUTOMATION_SETUP.md`

---

**Migration Date**: 2025-01-XX
**Status**: ✅ Complete
**Impact**: Main app no longer impacted by automation service
