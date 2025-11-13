# 🔐 WhatsApp Permanent Access Token Setup

## Problem
Temporary access tokens generated in Meta Dev Dashboard expire after 24 hours, causing the "Invalid OAuth access token" error (error 190).

## Solution: Get a Permanent Token

### Step 1: Create a System User (One-time)
1. Go to **Meta Business Suite** → **Settings** → **Users**
2. Click **Add** and create a **System User**
3. Give it a name like `njangi-whatsapp-bot`
4. Select role: **Admin**

### Step 2: Generate a Permanent Access Token
1. In **Meta Business Suite**, go to **Settings** → **Users**
2. Click on your System User
3. Click **Generate token** (or **Create token**)
4. Select these permissions:
   - ✅ `whatsapp_business_messaging`
   - ✅ `whatsapp_business_management`
   - ✅ `business_management` (for managing the business)
5. This generates a **permanent token** (doesn't expire unless revoked)

### Step 3: Assign Token to Your WhatsApp Business Phone Number
1. Go to **Meta Business Suite** → **WhatsApp** → **Getting Started**
2. Select your WhatsApp Business Account
3. Add the System User with the **Admin** role
4. The token can now access your phone number ID (`881828818344477`)

### Step 4: Update Heroku Environment Variable

```bash
# Copy your new permanent token
heroku config:set WHATSAPP_ACCESS_TOKEN="your-permanent-token-here" -a njangi-on-chain

# Restart the app
heroku restart -a njangi-on-chain

# Verify it's set correctly
heroku config -a njangi-on-chain | grep WHATSAPP_ACCESS_TOKEN
```

## Alternative: Get Token via API

If you have access to your app's token, you can also get a permanent token via the Graph API:

```bash
curl -X POST \
  "https://graph.instagram.com/v21.0/{YOUR_BUSINESS_ACCOUNT_ID}/access_tokens?business_app={APP_ID}&access_token={EXISTING_TOKEN}"
```

## Current Heroku Setup
- **Phone Number ID**: `881828818344477`
- **WhatsApp Business Account ID**: `4338352046412081`
- **Current Token Status**: ❌ Expired (temporary test token)

## Testing the Permanent Token

Once set, test it:

```bash
# Health check
curl https://njangionchain.com/api/whatsapp/health

# Manual notification test
curl -X POST https://njangionchain.com/api/whatsapp/notify-circle-link \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "+13019790161",
    "circleId": "0x1639fcff0c0f7a48ba0a1aa9f727985f1c9360d399bd8210dc99f26c07237d8e",
    "adminAddress": "0xe833deaa9c038ac2edd397323ed5dbde1e622aadfd0d526332a214a31f9de17d",
    "type": "confirmation"
  }'
```

## Error Reference

| Error Code | Meaning | Solution |
|-----------|---------|----------|
| 190 | Invalid OAuth access token | Get permanent token (this guide) |
| 401 | Unauthorized | Check phone number ID and business account ID |
| 429 | Rate limited | Wait before sending more messages |
| 400 | Invalid recipient | Ensure phone is in test list |

## ⚠️ Important Notes

1. **Never use temporary tokens in production** - They expire within 24 hours
2. **Permanent tokens don't expire** - They only expire if you manually revoke them
3. **Keep token secure** - Don't commit to git, always use environment variables
4. **Test list requirement** - Even with permanent token, test numbers must be added to WhatsApp Business Account test list for 90-day free testing

## Next Steps

1. ✅ Get permanent access token from Meta Business Suite
2. ✅ Set `WHATSAPP_ACCESS_TOKEN` on Heroku
3. ✅ Restart app
4. ✅ Test circle linking - should now receive WhatsApp message

