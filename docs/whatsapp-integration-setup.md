# WhatsApp Integration Setup Guide

This document provides step-by-step instructions for setting up the WhatsApp Business API integration for Njangi Circle Management.

## Overview

The WhatsApp integration allows users to:
- Create savings circles via WhatsApp commands
- Join existing circles
- Make contributions
- Check circle status and balances
- Receive automated notifications
- Authenticate securely with zkLogin

## Prerequisites

1. **Business Verification**: You need a verified business for WhatsApp Business API
2. **Meta Developer Account**: Required for API access
3. **Phone Number**: A dedicated phone number for the WhatsApp Business account
4. **SSL Certificate**: HTTPS endpoint for webhook URL
5. **Domain**: Public domain for webhook endpoints

## Step 1: Meta Developer Account Setup

### 1.1 Create Meta Developer Account
1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Click "Get Started" and log in with your Facebook account
3. Complete the developer account verification process
4. Enable two-factor authentication (2FA) - **Required**

### 1.2 Create Meta App
1. In the Meta Developer Console, click "Create App"
2. Select "Business" as the app type
3. Fill in app details:
   - **App Name**: "Njangi WhatsApp Integration"
   - **App Contact Email**: Your business email
   - **Business Manager Account**: Select or create one

### 1.3 Add WhatsApp Product
1. In your Meta App dashboard, click "Add Product"
2. Find "WhatsApp" and click "Set Up"
3. Choose "WhatsApp Cloud API" (recommended)

## Step 2: WhatsApp Business API Configuration

### 2.1 Get Phone Number
1. In WhatsApp settings, go to "Phone Numbers"
2. Add a new phone number or use the test number provided
3. Verify the phone number via SMS

### 2.2 Generate Access Token
1. Go to WhatsApp > Getting Started
2. Copy the temporary access token (24 hours)
3. For production, create a permanent token:
   - Go to App Settings > Basic
   - Generate a permanent access token
   - **Store securely** - this is your `WHATSAPP_ACCESS_TOKEN`

### 2.3 Get Phone Number ID
1. In WhatsApp settings, find your phone number
2. Copy the Phone Number ID
3. This is your `WHATSAPP_PHONE_NUMBER_ID`

## Step 3: Webhook Configuration

### 3.1 Configure Webhook URL
1. In WhatsApp settings, go to "Configuration"
2. Click "Edit" next to Webhook
3. Enter your webhook URL:
   ```
   https://yourdomain.com/api/whatsapp/webhook
   ```
4. Enter verify token (create a secure random string)
5. This is your `WHATSAPP_VERIFY_TOKEN`

### 3.2 Subscribe to Webhook Fields
Subscribe to these webhook fields:
- `messages`: For incoming messages
- `message_deliveries`: For delivery status
- `message_reads`: For read receipts
- `messaging_postbacks`: For button clicks

### 3.3 Get App Secret
1. Go to App Settings > Basic
2. Copy the "App Secret"
3. This is your `WHATSAPP_APP_SECRET`

## Step 4: Environment Configuration

Create or update your `.env` file with the following variables:

```env
# WhatsApp Business API Configuration
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id_here
WHATSAPP_ACCESS_TOKEN=your_access_token_here
WHATSAPP_VERIFY_TOKEN=your_verify_token_here
WHATSAPP_APP_SECRET=your_app_secret_here
WHATSAPP_WEBHOOK_URL=https://yourdomain.com/api/whatsapp/webhook
WHATSAPP_API_VERSION=v21.0
```

For MCP/Cursor integration, add these to `.cursor/mcp.json`:

```json
{
  "env": {
    "WHATSAPP_PHONE_NUMBER_ID": "your_phone_number_id_here",
    "WHATSAPP_ACCESS_TOKEN": "your_access_token_here",
    "WHATSAPP_VERIFY_TOKEN": "your_verify_token_here",
    "WHATSAPP_APP_SECRET": "your_app_secret_here",
    "WHATSAPP_WEBHOOK_URL": "https://yourdomain.com/api/whatsapp/webhook",
    "WHATSAPP_API_VERSION": "v21.0"
  }
}
```

## Step 5: Testing Setup

### 5.1 Test Webhook Verification
1. Deploy your application with the webhook endpoint
2. Test webhook verification:
   ```bash
   curl -X GET "https://yourdomain.com/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=test&hub.verify_token=your_verify_token"
   ```
3. Should return the challenge value

### 5.2 Test Message Sending
Use the send API endpoint:
```bash
curl -X POST https://yourdomain.com/api/whatsapp/send \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "+1234567890",
    "type": "text",
    "content": {
      "text": "Hello from Njangi! 🎉"
    }
  }'
```

### 5.3 Health Check
Monitor service health:
```bash
curl https://yourdomain.com/api/whatsapp/health
```

## Step 6: Business Verification (Production)

### 6.1 Business Verification Requirements
- **Business Manager**: Verified Facebook Business Manager account
- **Business Information**: Legal business name, address, website
- **Business Documents**: Business license, tax ID, etc.
- **Use Case**: Clear description of how WhatsApp will be used

### 6.2 Message Templates
For production, create pre-approved message templates:

1. Go to WhatsApp > Message Templates
2. Create templates for:
   - Welcome messages
   - Payment reminders
   - Circle notifications
   - Authentication prompts

Example template:
```
Template Name: welcome_message
Category: UTILITY
Language: English
Content: Welcome to Njangi, {{1}}! Your savings circle journey starts here.
```

## Step 7: Rate Limiting & Compliance

### 7.1 Rate Limits
WhatsApp has strict rate limits:
- **Conversations**: 1,000 per 24 hours (initially)
- **Messages per second**: 20 for Cloud API
- **Template messages**: Limited based on quality rating

### 7.2 Compliance Requirements
- **Opt-in required**: Users must opt-in to receive messages
- **24-hour window**: Can only send free-form messages within 24 hours of user's last message
- **Template messages**: Use for notifications outside 24-hour window
- **Quality rating**: Maintain high quality to avoid restrictions

## Step 8: Monitoring & Maintenance

### 8.1 Monitoring Endpoints
- Health check: `GET /api/whatsapp/health`
- Service stats: Included in health check response
- Webhook logs: Check application logs

### 8.2 Error Handling
Common issues and solutions:
- **Webhook verification fails**: Check verify token
- **Message sending fails**: Verify access token and phone number ID
- **Rate limit exceeded**: Implement proper rate limiting
- **Template rejected**: Follow WhatsApp template guidelines

## Step 9: Security Best Practices

### 9.1 Webhook Security
- Always verify webhook signatures
- Use HTTPS for all endpoints
- Validate all incoming data
- Rate limit webhook requests

### 9.2 Token Management
- Rotate access tokens regularly
- Store tokens securely (environment variables)
- Monitor token usage and expiry
- Use least privilege access

## Troubleshooting

### Common Issues

1. **Webhook verification fails**
   - Check that webhook URL is accessible
   - Verify the verify token matches
   - Ensure HTTPS is properly configured

2. **Messages not sending**
   - Verify access token is valid
   - Check phone number ID is correct
   - Ensure recipient number is in correct format (+1234567890)

3. **Rate limiting errors**
   - Implement exponential backoff
   - Monitor rate limit headers
   - Consider upgrading API limits

4. **Template messages rejected**
   - Follow WhatsApp template guidelines
   - Avoid promotional content
   - Include clear opt-out instructions

### Support Resources

- [WhatsApp Business API Documentation](https://developers.facebook.com/docs/whatsapp)
- [Meta Business Help Center](https://www.facebook.com/business/help)
- [WhatsApp Business API Rate Limits](https://developers.facebook.com/docs/whatsapp/pricing)

## Next Steps

After completing this setup:
1. Test all endpoints thoroughly
2. Implement command parsing (subtask 34.3)
3. Set up authentication bridge with zkLogin (subtask 34.2)
4. Deploy to production environment
5. Submit for business verification if required

---

*Last updated: 2025-06-23* 