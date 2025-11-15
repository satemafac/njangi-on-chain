# WhatsApp Command & Notification System

## Overview

The Njangi WhatsApp bot now provides a comprehensive notification and command system for circle members. Users receive automated updates about their circles and can request information via simple commands.

## System Architecture

### Services

1. **WhatsAppCommandHandlerService** (`whatsapp-command-handler.service.ts`)
   - Generates formatted WhatsApp messages for different notification types
   - Methods for each notification category
   - Integrates with WhatsAppSenderService for delivery

2. **API Endpoint** (`send-command-response.ts`)
   - HTTP endpoint for triggering notifications
   - Accepts POST requests with notification parameters
   - Returns success/failure status

3. **Webhook Handler** (`webhook.ts`)
   - Handles incoming user messages
   - Provides acknowledgment messages
   - Notification-only channel (users don't send commands)

## Notification Types

### 1. Help Message
**Endpoint:** `POST /api/whatsapp/send-command-response`

```json
{
  "phoneNumber": "+1234567890",
  "commandType": "help"
}
```

**Response:**
```
📱 *Njangi WhatsApp Bot*

You will receive automated updates about your circles:

✅ *Notifications you'll receive:*
• 🔄 New cycle started
• 💰 Member contributions
• ⏰ Deadline reminders
• 💸 Payout notifications
• 👥 Rotation status updates
• ⚠️ Important alerts

[Full help text...]
```

### 2. Cycle Started Notification
**Endpoint:** `POST /api/whatsapp/send-command-response`

```json
{
  "phoneNumber": "+1234567890",
  "commandType": "cycle_started",
  "circleId": "0x1639fcff0c0f7a48ba0a1aa9f727985f1c9360d399bd8210dc99f26c07237d8e",
  "circleName": "Friends Circle",
  "data": {
    "cycleNumber": 5
  }
}
```

**Response:**
```
🔄 *Cycle #5 Started*

Your circle "Friends Circle" has started a new cycle!

View details: https://njangionchain.com/circle/0x1639fcff...
```

### 3. Member Contribution Notification
**Endpoint:** `POST /api/whatsapp/send-command-response`

```json
{
  "phoneNumber": "+1234567890",
  "commandType": "contribution",
  "circleId": "0x1639fcff0c0f7a48ba0a1aa9f727985f1c9360d399bd8210dc99f26c07237d8e",
  "circleName": "Friends Circle",
  "data": {
    "memberName": "Alice",
    "contributionAmount": "$100 USD",
    "totalContributed": "$350 USD",
    "targetAmount": "$500 USD"
  }
}
```

**Response:**
```
💰 *New Contribution Received*

Alice contributed $100 USD to "Friends Circle"

📊 Cycle Progress: 70% ($350 USD/$500 USD)
```

### 4. Deadline Reminder
**Endpoint:** `POST /api/whatsapp/send-command-response`

```json
{
  "phoneNumber": "+1234567890",
  "commandType": "deadline",
  "circleId": "0x1639fcff0c0f7a48ba0a1aa9f727985f1c9360d399bd8210dc99f26c07237d8e",
  "circleName": "Friends Circle",
  "data": {
    "hoursRemaining": 6,
    "targetAmount": "$500 USD"
  }
}
```

**Response:**
```
⏰ *Contribution Deadline Reminder*

"Friends Circle" contribution deadline:

6 hours remaining

Target: $500 USD

View circle: https://njangionchain.com/circle/0x1639fcff...
```

### 5. Payout Notification
**Endpoint:** `POST /api/whatsapp/send-command-response`

```json
{
  "phoneNumber": "+1234567890",
  "commandType": "payout",
  "circleId": "0x1639fcff0c0f7a48ba0a1aa9f727985f1c9360d399bd8210dc99f26c07237d8e",
  "circleName": "Friends Circle",
  "data": {
    "beneficiary": "Bob",
    "payoutAmount": "$500 USD",
    "payoutDate": "2025-11-15"
  }
}
```

**Response:**
```
💸 *Payout Processed*

"Friends Circle" - Cycle Payout

👤 Beneficiary: Bob
💰 Amount: $500 USD
📅 Date: 2025-11-15

View details: https://njangionchain.com/circle/0x1639fcff...
```

### 6. Rotation Status Update
**Endpoint:** `POST /api/whatsapp/send-command-response`

```json
{
  "phoneNumber": "+1234567890",
  "commandType": "rotation",
  "circleId": "0x1639fcff0c0f7a48ba0a1aa9f727985f1c9360d399bd8210dc99f26c07237d8e",
  "circleName": "Friends Circle",
  "data": {
    "currentBeneficiary": "Alice",
    "currentPosition": 2,
    "totalMembers": 5,
    "cycleNumber": 5
  }
}
```

**Response:**
```
🔄 *Rotation Status Update*

"Friends Circle" - Cycle #5

👑 Current Beneficiary:
Alice

📊 Rotation: Position 3 of 5

View full details: https://njangionchain.com/circle/0x1639fcff...
```

### 7. Member Joined Notification
**Endpoint:** `POST /api/whatsapp/send-command-response`

```json
{
  "phoneNumber": "+1234567890",
  "commandType": "member_joined",
  "circleId": "0x1639fcff0c0f7a48ba0a1aa9f727985f1c9360d399bd8210dc99f26c07237d8e",
  "circleName": "Friends Circle",
  "data": {
    "newMemberName": "Charlie",
    "totalMembers": 4,
    "maxMembers": 5
  }
}
```

**Response:**
```
👥 *New Member Joined*

"Friends Circle"

✨ Charlie has joined!

📈 Circle Size: 4/5 members

View circle: https://njangionchain.com/circle/0x1639fcff...
```

### 8. General Alert/Warning
**Endpoint:** `POST /api/whatsapp/send-command-response`

```json
{
  "phoneNumber": "+1234567890",
  "commandType": "alert",
  "circleId": "0x1639fcff0c0f7a48ba0a1aa9f727985f1c9360d399bd8210dc99f26c07237d8e",
  "circleName": "Friends Circle",
  "data": {
    "alertTitle": "Contribution Overdue",
    "alertMessage": "Your contribution is overdue. Please submit your payment as soon as possible.",
    "severity": "warning"
  }
}
```

**Response:**
```
⚠️ *Contribution Overdue*

"Friends Circle"

Your contribution is overdue. Please submit your payment as soon as possible.

View circle: https://njangionchain.com/circle/0x1639fcff...
```

### 9. Generic Message
**Endpoint:** `POST /api/whatsapp/send-command-response`

```json
{
  "phoneNumber": "+1234567890",
  "commandType": "generic",
  "data": {
    "title": "Circle Announcement",
    "message": "Your circle meeting has been scheduled for Friday at 7 PM",
    "emoji": "📢"
  }
}
```

**Response:**
```
📢 *Circle Announcement*

Your circle meeting has been scheduled for Friday at 7 PM
```

## Implementation Guide

### Frontend Integration (Next.js)

```typescript
// src/pages/api/circles/[id]/send-notification.ts
import axios from 'axios';

export async function sendCircleNotification(
  phoneNumber: string,
  circleId: string,
  notificationType: 'cycle_started' | 'contribution' | 'deadline' | 'payout' | 'rotation',
  data: Record<string, any>
) {
  try {
    const response = await axios.post(
      `${process.env.WHATSAPP_BOT_BASE_URL}/api/whatsapp/send-command-response`,
      {
        phoneNumber,
        commandType: notificationType,
        circleId,
        circleName: data.circleName,
        data,
      }
    );

    return response.data;
  } catch (error) {
    console.error('Failed to send notification:', error);
    throw error;
  }
}
```

### Smart Contract Events

The system monitors these Move contract events:

- **CircleCreated**: New circle initialized
- **CircleActivated**: Circle becomes active
- **MemberJoined**: User joins circle
- **StablecoinContributionMade**: Contribution received
- **CycleResumed**: New cycle started
- **PayoutOverdue**: Payment deadline passed
- **MemberActivated**: Member status change

### Automated Triggers

Create automation to trigger notifications:

```typescript
// Example: Monitor cycle completion and trigger payout notification
function onCycleCompleted(circle: Circle) {
  const beneficiary = getBeneficiary(circle);
  const payout = calculatePayout(circle);

  await sendCircleNotification(
    beneficiary.phoneNumber,
    circle.id,
    'payout',
    {
      circleName: circle.name,
      beneficiary: beneficiary.name,
      payoutAmount: formatAmount(payout),
      payoutDate: new Date().toISOString().split('T')[0],
    }
  );
}
```

## Response Status Codes

| Code | Meaning |
|------|---------|
| 200 | Notification sent successfully |
| 400 | Missing or invalid parameters |
| 405 | Wrong HTTP method |
| 500 | Server error or WhatsApp API error |

## Error Handling

All endpoints return consistent error responses:

```json
{
  "success": false,
  "error": "Description of what went wrong",
  "timestamp": "2025-11-15T21:14:36.151Z"
}
```

## Rate Limiting Considerations

- Avoid sending multiple notifications to the same user within short time windows
- Use the 2-minute deduplication window for circle link events
- Consider throttling deadline reminders (don't send if already sent in last hour)

## Message Templates

For template-based messages (when circle_linked or other templates are approved):

```json
{
  "to": "+1234567890",
  "type": "template",
  "template": {
    "name": "circle_notification",
    "language": {
      "code": "en_US"
    },
    "components": [
      {
        "type": "body",
        "parameters": [
          {
            "type": "text",
            "text": "param_value"
          }
        ]
      }
    ]
  }
}
```

## Future Enhancements

1. **Interactive Messages**: Button-based responses for quick actions
2. **Image/Document Sharing**: Share circle summaries as images
3. **Scheduled Notifications**: Pre-schedule messages for specific times
4. **Multi-language Support**: Localize messages based on user preference
5. **Rich Media**: Share documents, receipts, or transaction proofs
6. **User Preferences**: Allow users to customize notification frequency

## Testing

Test notifications manually via curl:

```bash
curl -X POST http://localhost:3000/api/whatsapp/send-command-response \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "+1234567890",
    "commandType": "help"
  }'
```

Or via the bot API:

```bash
curl -X POST https://njangi-on-chain.herokuapp.com/api/whatsapp/send-command-response \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "+13019790161",
    "commandType": "cycle_started",
    "circleId": "0x...",
    "circleName": "Test Circle",
    "data": {
      "cycleNumber": 1
    }
  }'
```

