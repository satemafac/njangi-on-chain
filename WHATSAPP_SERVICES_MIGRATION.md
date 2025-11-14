# WhatsApp Services Migration Guide

## Overview

WhatsApp architecture has been migrated from a **command-based interactive system** to a **notification-only channel**. This document clarifies which services are active, deprecated, and where they live.

## Architecture Split

### Frontend (`src/`)
- Contains legacy/deprecated services
- OLD webhook endpoint (deprecated)
- Should NOT process WhatsApp webhooks

### Bot Backend (`whatsapp-bot-backend/src/`)
- Contains NEW active services
- NEW webhook endpoint (active)
- Handles all WhatsApp processing
- Receives all Meta webhooks

---

## Service Status

### ✅ ACTIVE SERVICES (Bot Backend)

#### 1. **circle-link-listener.service.ts**
**Location:** `whatsapp-bot-backend/src/services/`

**Purpose:** Listen for `CircleLinked` blockchain events and send link confirmations

**Key Functions:**
- `start()` / `stop()` - Manage event listener
- `getCircleIdForPhone(phoneNumber)` - Retrieve stored circle ID
- `sendLinkConfirmation(phoneNumber, circleId)` - Send template message
- `sendWelcomeMessage(phoneNumber, circleId)` - Send welcome after confirmation

**Usage:** Automatically started in `whatsapp-bot-backend/src/server.ts`

#### 2. **whatsapp-sender.service.ts**
**Location:** `whatsapp-bot-backend/src/services/`

**Purpose:** Low-level WhatsApp API interaction

**Key Functions:**
- `sendMessage(request)` - Send single message
- `sendWithRetry(request, maxRetries)` - Send with retry logic
- `healthCheck()` - Verify API connectivity

**Correct Endpoint:** `https://graph.facebook.com/` (NOT instagram)

#### 3. **whatsapp-notification-handler.service.ts**
**Location:** `whatsapp-bot-backend/src/services/`

**Purpose:** Format and send circle update notifications

**Supported Notifications:**
- `cycle_started` - New cycle notification
- `contribution_received` - Contribution alert
- `deadline_approaching` - Deadline reminder
- `payout_ready` - Payout notification
- `member_joined` - Member joined alert
- `custom` - Custom message

**Key Functions:**
- `sendCircleUpdate(phoneNumber, circleId, notification)` - Send update
- `notifyCycleStarted()`, `notifyContributionReceived()`, etc. - Typed methods
- `sendBatchNotifications()` - Send multiple at once

---

### ⚠️ DEPRECATED SERVICES (Frontend - Do NOT Use)

#### 1. **whatsapp-command-executor.service.ts**
**Location:** `src/services/`

**Status:** ⚠️ DEPRECATED

**Reason:** Commands are no longer processed. Kept for historical reference.

**Do NOT use for:** Processing user commands, interaction flows

**Can be:** Archived/deleted in future cleanup

#### 2. **whatsapp-command-parser.service.ts**
**Location:** `src/services/`

**Status:** ⚠️ DEPRECATED

**Reason:** Commands are not parsed anymore

#### 3. **whatsapp-conversation-flow.service.ts**
**Location:** `src/services/`

**Status:** ⚠️ DEPRECATED

**Reason:** No multi-step user flows in notification-only mode

#### 4. **whatsapp-circle-manager.service.ts**
**Location:** `src/services/`

**Status:** ⚠️ DEPRECATED

**Reason:** User circle management via WhatsApp no longer supported

#### 5. **whatsapp-auth-bridge.service.ts** & **whatsapp-auth-bridge-secure.service.ts**
**Location:** `src/services/`

**Status:** ⚠️ DEPRECATED

**Reason:** Auth flow handled via web app, not WhatsApp

#### 6. **whatsapp-stateless-auth.service.ts**
**Location:** `src/services/`

**Status:** ⚠️ DEPRECATED

**Reason:** No authentication via WhatsApp commands

#### 7. **whatsapp-notification.service.ts**
**Location:** `src/services/`

**Status:** ⚠️ DEPRECATED

**Reason:** Replaced by `whatsapp-notification-handler.service.ts` in bot backend

#### 8. **whatsapp.service.ts**
**Location:** `src/services/`

**Status:** ⚠️ PARTIALLY DEPRECATED

**Note:** This is the OLD WhatsApp service used by deprecated services. The new `whatsapp-sender.service.ts` in bot backend is the replacement.

---

### ❓ UNCERTAIN STATUS

#### 1. **whatsapp-rate-limiter.service.ts**
**Location:** `src/services/`

**Status:** May be useful for bot backend, but needs review

**Recommendation:** Consider migrating to bot backend if needed

#### 2. **whatsapp-audit.service.ts**
**Location:** `src/services/`

**Status:** May be useful for logging, but check if still needed

---

## API Endpoints

### ✅ ACTIVE (Bot Backend)

```
POST /api/whatsapp/webhook
- Receive and process incoming messages
- Handle link confirmations
- Send acknowledgments

POST /api/whatsapp/send-notification
- Send circle update notifications
- Supports 6 notification types

GET/POST /api/whatsapp/health
- Check bot backend health
```

### ⚠️ DEPRECATED (Frontend)

```
GET/POST /api/whatsapp/webhook
- DEPRECATED
- Returns warnings in logs
- Silently accepts requests (backwards compat)
- Should NOT be used

POST /api/whatsapp/send
- OLD notification send
- Replaced by send-notification

POST /api/whatsapp/auth/*
- OLD auth flow endpoints
- No longer used
```

---

## Migration Checklist

### For Developers

- [ ] **DO NOT** import from `src/services/whatsapp-*` (deprecated)
- [ ] **DO** use bot backend services for new WhatsApp work
- [ ] **DO** use `whatsapp-notification-handler` for notifications
- [ ] **DO** ensure webhooks are configured for bot backend
- [ ] **DO** check `WHATSAPP_NOTIFICATION_CHANNEL.md` for current flow

### For Maintenance

- [ ] Remove unused command executor imports
- [ ] Archive deprecated services (don't delete yet)
- [ ] Update any references to old services
- [ ] Migrate rate limiter if needed
- [ ] Test bot backend webhook receives all messages

---

## Configuration

### Meta Business Suite Webhook

**Configure TO:** Bot backend endpoint (NOT frontend)

```
https://njangi-on-chain.herokuapp.com/api/whatsapp/webhook
(OR your bot backend domain)
```

**NOT:**
```
https://njangionchain.com/api/whatsapp/webhook (Frontend - deprecated)
```

### Environment Variables

#### Bot Backend (`.env`)
```
WHATSAPP_ACCESS_TOKEN=<permanent_token>
WHATSAPP_PHONE_NUMBER_ID=<your_number_id>
WHATSAPP_APP_SECRET=<your_app_secret>
WHATSAPP_VERIFY_TOKEN=<your_verify_token>
```

#### Frontend (`.env.local`)
```
NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID=<registry_id>
NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID=<registry_id>
(Only for circle linking, not for webhooks)
```

---

## Integration Points

### Circle Linking
1. User links via frontend UI (`WhatsAppCircleIntegration.tsx`)
2. Frontend calls `/api/whatsapp/admin-link-circle`
3. User confirms in WhatsApp (replies "OK")
4. Bot backend webhook processes confirmation
5. Welcome message sent

### Notifications
1. Event occurs on blockchain (cycle started, contribution, etc.)
2. Frontend/automation triggers `/api/whatsapp/send-notification` (bot backend)
3. Bot backend sends formatted message
4. User receives update on WhatsApp

### Event Listener
1. Bot backend `CircleLinkListenerService` continuously monitors blockchain
2. Detects `CircleLinked` events
3. Sends template message to new linked phone number
4. Waits for confirmation
5. Sends welcome message

---

## Testing

### Test Link Confirmation
```bash
# 1. Link circle via web app
# 2. Confirm in WhatsApp with "OK"
# 3. Check logs in bot backend:
heroku logs -a njangi-on-chain --tail | grep "Link confirmation"
```

### Test Notification
```bash
curl -X POST https://njangi-on-chain.herokuapp.com/api/whatsapp/send-notification \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "+13019790161",
    "circleId": "0x1234...",
    "circleName": "Test Circle",
    "notificationType": "cycle_started",
    "data": {"cycleNumber": 1, "dueDate": "2025-11-20"}
  }'
```

### Check Bot Backend Logs
```bash
heroku logs -a njangi-on-chain --dyno=bot --tail
```

---

## Summary Table

| Service | Location | Status | Replacement |
|---------|----------|--------|-------------|
| whatsapp-command-executor | `src/` | ❌ Deprecated | None (commands removed) |
| whatsapp-command-parser | `src/` | ❌ Deprecated | None |
| whatsapp-conversation-flow | `src/` | ❌ Deprecated | None |
| whatsapp-circle-manager | `src/` | ❌ Deprecated | None |
| whatsapp-auth-bridge* | `src/` | ❌ Deprecated | Web app auth |
| whatsapp-stateless-auth | `src/` | ❌ Deprecated | Web app auth |
| whatsapp-notification | `src/` | ❌ Deprecated | whatsapp-notification-handler (bot) |
| whatsapp.service | `src/` | ⚠️ Legacy | whatsapp-sender (bot) |
| **circle-link-listener** | `whatsapp-bot-backend/` | ✅ Active | — |
| **whatsapp-sender** | `whatsapp-bot-backend/` | ✅ Active | — |
| **whatsapp-notification-handler** | `whatsapp-bot-backend/` | ✅ Active | — |
| webhook.ts | `src/pages/api/whatsapp/` | ❌ Deprecated | whatsapp-bot-backend/webhook |
| health.ts | `src/pages/api/whatsapp/` | ⚠️ Legacy | health (bot) |

---

## Next Steps

1. ✅ Verify bot backend webhook is receiving all messages
2. ✅ Confirm Meta Business Suite points to bot backend
3. ⏳ Archive deprecated services (tag for cleanup)
4. ⏳ Migrate rate limiter if useful
5. ⏳ Remove old auth endpoints
6. ⏳ Document final service map

---

For questions, see:
- `WHATSAPP_NOTIFICATION_CHANNEL.md` - Current notification flow
- `whatsapp-bot-backend/` - Active code
- `src/services/whatsapp-command-executor.service.ts` - Deprecation notice

