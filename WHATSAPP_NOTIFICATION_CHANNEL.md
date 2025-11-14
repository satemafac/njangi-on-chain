# WhatsApp Notification Channel Setup

## Overview

WhatsApp is now a **notification-only channel** for sending circle updates and insights to users. Users do NOT interact with the app via WhatsApp commands - they only receive important notifications.

## User Flow

### 1. **Circle Linking**
- User links their WhatsApp to a circle via the web app
- They receive a `circle_linked` template message asking for confirmation
- User replies with "OK", "confirm", or "yes"
- Bot sends a welcome message with circle link and update types

### 2. **Receiving Updates**
- Users receive notifications about:
  - 📅 Cycle started
  - 💰 Contribution received
  - ⏰ Deadline approaching
  - 💸 Payout ready
  - 👋 New member joined
  - 📱 Custom updates
- Any other messages: Simple acknowledgment (not processed as commands)

## API Endpoints

### Send Notification

**POST** `/api/whatsapp/send-notification`

Send a circle update notification to a user.

```bash
curl -X POST http://localhost:3000/api/whatsapp/send-notification \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "+1234567890",
    "circleId": "0x1234...",
    "circleName": "My Circle",
    "notificationType": "cycle_started",
    "data": {
      "cycleNumber": 1,
      "dueDate": "2025-11-20"
    }
  }'
```

**Request Body:**
```typescript
{
  phoneNumber: string;           // Recipient phone number (e.g., +1234567890)
  circleId: string;              // Circle ID being updated
  circleName?: string;           // Optional circle name for formatting
  notificationType: 'cycle_started' | 'contribution_received' | 'deadline_approaching' | 'payout_ready' | 'member_joined' | 'custom';
  data?: Record<string, any>;    // Optional event data (varies by type)
  customMessage?: string;        // For 'custom' type notifications
}
```

**Response:**
```typescript
{
  success: boolean;
  messageId?: string;    // WhatsApp message ID if sent
  error?: string;        // Error message if failed
}
```

### Notification Types

#### 1. **cycle_started**
New cycle has begun. Users should prepare to contribute.

```json
{
  "notificationType": "cycle_started",
  "data": {
    "cycleNumber": 1,
    "dueDate": "2025-11-20"
  }
}
```

**Output:**
```
🔄 New Cycle Started!

Cycle #1
💰 Contributions due by: 2025-11-20

Ready to contribute? 💪
```

#### 2. **contribution_received**
Member has made a contribution.

```json
{
  "notificationType": "contribution_received",
  "data": {
    "memberName": "Alice",
    "amount": "100",
    "currency": "USD"
  }
}
```

**Output:**
```
✅ Contribution Received

From: Alice
Amount: 100 USD

Keep the momentum going! 🚀
```

#### 3. **deadline_approaching**
Contribution deadline is approaching soon.

```json
{
  "notificationType": "deadline_approaching",
  "data": {
    "hoursRemaining": 12
  }
}
```

**Output:**
```
⏰ Deadline Approaching!

12 hours remaining

Don't miss this cycle! Submit your contribution now. 🏃
```

#### 4. **payout_ready**
A member's payout is ready.

```json
{
  "notificationType": "payout_ready",
  "data": {
    "recipientName": "Bob",
    "amount": "500",
    "currency": "USD"
  }
}
```

**Output:**
```
💸 Payout Ready!

Bob receives: 500 USD

Payout is being processed. 🎉
```

#### 5. **member_joined**
A new member has joined the circle.

```json
{
  "notificationType": "member_joined",
  "data": {
    "newMemberName": "Charlie"
  }
}
```

**Output:**
```
👋 New Member Joined

Welcome to Charlie! 🎉

We're growing stronger together! 💪
```

#### 6. **custom**
Send a custom message.

```json
{
  "notificationType": "custom",
  "customMessage": "Your custom message here with any details you want to share!"
}
```

## Integration Examples

### From Frontend (Circle Event)
When an event occurs (cycle started, contribution received, etc.), trigger a notification:

```typescript
// After circle event on blockchain
const response = await fetch('/api/whatsapp/send-notification', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    phoneNumber: userPhoneNumber,
    circleId: circleId,
    circleName: circleName,
    notificationType: 'cycle_started',
    data: {
      cycleNumber: 1,
      dueDate: '2025-11-20'
    }
  })
});
```

### From Backend (Automation)
When automated events trigger:

```typescript
import { whatsappNotificationHandler } from '../services/whatsapp-notification-handler.service';

// Send notification when cycle starts
await whatsappNotificationHandler.notifyCycleStarted(
  phoneNumber,
  circleId,
  circleName,
  cycleNumber,
  dueDate
);
```

### Batch Notifications
Send multiple notifications efficiently:

```typescript
const notifications = [
  {
    phoneNumber: '+1234567890',
    circleId: '0x1234...',
    notification: {
      type: 'cycle_started',
      circleId: '0x1234...',
      data: { cycleNumber: 1, dueDate: '2025-11-20' }
    }
  },
  // ... more notifications
];

const results = await whatsappNotificationHandler.sendBatchNotifications(notifications);
```

## Webhook Behavior

### Incoming Messages
When users reply to notifications:
- **"ok", "confirm", "yes"** → Send welcome message with circle link
- **Any other message** → Send simple acknowledgment

The webhook does NOT process commands - it only acknowledges receipt and sends confirmations.

## File Structure

```
whatsapp-bot-backend/
├── src/
│   ├── services/
│   │   ├── circle-link-listener.service.ts      # Listens for CircleLinked events
│   │   ├── whatsapp-notification-handler.service.ts  # Formats & sends notifications
│   │   └── whatsapp-sender.service.ts           # Low-level WhatsApp API
│   └── pages/api/whatsapp/
│       ├── webhook.ts                           # Receives incoming messages (confirmations)
│       ├── send-notification.ts                 # API for sending notifications
│       └── ...
```

## Key Differences from Command-Based Approach

| Aspect | Before | Now |
|--------|--------|-----|
| **User Interaction** | Commands via WhatsApp | Notification-only |
| **Incoming Messages** | Parsed & executed | Acknowledged |
| **Response** | Command results | Confirmation/acknowledgment |
| **Use Case** | Full app interaction | Real-time updates |
| **Command Executor** | Active | Deprecated (can be archived) |

## Testing

### Test Link Confirmation
```bash
# 1. Link circle via web app
# 2. Reply with "OK" to the template message
# Should receive: Welcome message with circle link
```

### Test Notifications
```bash
curl -X POST http://localhost:3000/api/whatsapp/send-notification \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "+13019790161",
    "circleId": "0x1234...",
    "circleName": "Test Circle",
    "notificationType": "cycle_started",
    "data": {
      "cycleNumber": 1,
      "dueDate": "2025-11-20"
    }
  }'
```

## Next Steps

1. ✅ Webhook updated to handle confirmations only
2. ✅ Notification service created
3. ✅ Send notification API endpoint ready
4. 📋 TODO: Archive/deprecate command executor
5. 📋 TODO: Integrate notifications with circle events on blockchain
6. 📋 TODO: Set up automation for deadline/payout notifications

