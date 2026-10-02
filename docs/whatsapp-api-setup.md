# WhatsApp Business API Setup Guide

## 🔑 Getting WhatsApp API Keys from Meta

### Step 1: Meta Developer Account Setup

1. **Go to [Meta for Developers](https://developers.facebook.com/)**
2. **Create/Login** to your Facebook account
3. **Click "My Apps"** → **"Create App"**
4. **Choose "Business"** as app type
5. **Fill in app details:**
   - App Name: "Njangi WhatsApp Integration"
   - Contact Email: Your email
   - Business Account: Create/select one

### Step 2: Add WhatsApp Product

1. **In your app dashboard**, click **"Add Product"**
2. **Find "WhatsApp"** and click **"Set up"**
3. **Choose "WhatsApp Business API"**
4. **Select your Business Account**

### Step 3: Phone Number Setup

1. **Go to WhatsApp > Getting Started**
2. **Add a phone number** or use the test number provided
3. **Verify your phone number** following Meta's process
4. **Copy the Phone Number ID** (you'll need this)

### Step 4: Get Your API Credentials

You'll find these in your Meta Developer Console:

```bash
# 1. PHONE NUMBER ID
# Location: WhatsApp > Getting Started > Phone numbers
WHATSAPP_PHONE_NUMBER_ID="123456789012345"

# 2. ACCESS TOKEN  
# Location: WhatsApp > Getting Started > Temporary access token
# For production: WhatsApp > Configuration > Access Token
WHATSAPP_ACCESS_TOKEN="EAAJ..."

# 3. VERIFY TOKEN (you create this)
# Make up a secure random string - used for webhook verification
WHATSAPP_VERIFY_TOKEN="your_secure_verify_token_123"

# 4. APP SECRET
# Location: App Settings > Basic > App Secret (click "Show")
WHATSAPP_APP_SECRET="abcd1234..."

# 5. WEBHOOK URL (your deployed domain)
WHATSAPP_WEBHOOK_URL="https://yourdomain.com/api/whatsapp/webhook"

# 6. API VERSION (current version)
WHATSAPP_API_VERSION="v21.0"
```

---

## 📁 Configuration in Your Project

### For Local Development

**Create `.env` file in project root:**

```bash
# Copy your .env.example to .env
cp .env.example .env

# Then add these WhatsApp variables to your .env file:
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id_here
WHATSAPP_ACCESS_TOKEN=your_access_token_here
WHATSAPP_VERIFY_TOKEN=your_secure_verify_token_here
WHATSAPP_APP_SECRET=your_app_secret_here
WHATSAPP_WEBHOOK_URL=https://yourdomain.com/api/whatsapp/webhook
WHATSAPP_API_VERSION=v21.0
```

### For Production (Vercel)

Production runs on Vercel. Add these in the Vercel project under
**Settings → Environment Variables**, in the **Production** environment:

```bash
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_ACCESS_TOKEN=your_access_token
WHATSAPP_VERIFY_TOKEN=your_verify_token
WHATSAPP_APP_SECRET=your_app_secret
WHATSAPP_WEBHOOK_URL=https://njangionchain.com/api/whatsapp/webhook
WHATSAPP_API_VERSION=v21.0
```

The CLI works too. It prompts for the value, so a secret never lands in your
shell history:

```bash
vercel env add WHATSAPP_ACCESS_TOKEN production --sensitive
```

- **Keep these names server-only.** Never give a WhatsApp secret a
  `NEXT_PUBLIC_` name: Next.js inlines `NEXT_PUBLIC_*` values into the browser
  bundle, where anyone can read them.
- **Mark the access token, app secret and verify token Sensitive.** Vercel
  never shows a Sensitive value again after you save it.
- **Production is the environment that needs them.** Meta calls the
  production webhook, and Vercel runs cron jobs (the WhatsApp notifiers) only
  on production. Preview URLs sit behind Vercel Authentication, so Meta can't
  reach them. Add a variable to Preview only if preview deployments should
  send real WhatsApp messages.
- **Redeploy after every change.** Vercel applies environment variable
  changes only to deployments built after the change. Open **Deployments**,
  then the current production deployment's **⋯** menu, and choose
  **Redeploy** (CLI: `vercel redeploy <production-deployment-url>`).
- **The registry ids are public, build-time values.**
  `NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID`,
  `NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID` and their `MAINNET` pair identify
  the Move package and the on-chain `WhatsAppLinksRegistry` object.
  `move/build_and_test.sh` and `scripts/bootstrap-package.mjs` write them to
  `.env.local` when you publish. Whenever they change, copy the active
  network's pair into Production and Preview, then redeploy: Next.js inlines
  `NEXT_PUBLIC_*` values at build time, so the running site keeps the old ids
  until it is rebuilt.

`.env.example` has the full variable list with defaults. See
[docs/environment.md](environment.md#hosted-environment-vercel) for the rest
of the Vercel setup.

---

## 🔗 Webhook Configuration

### Step 1: Deploy Your App First

Your webhook endpoint must be publicly accessible:
- **Development**: Use ngrok: `ngrok http 3000`
- **Production**: `https://njangionchain.com/api/whatsapp/webhook`, served by
  the Vercel deployment. Use the apex host: `www.njangionchain.com` answers
  with a 308 redirect. Preview URLs won't work either, because they sit behind
  Vercel Authentication.

### Step 2: Configure Webhook in Meta Console

1. **Go to App Dashboard > WhatsApp > Configuration.** If the app was created
   with the "Connect with customers through WhatsApp" use case, the panel is
   under **Use cases > Customize > Configuration** instead.
2. **Click "Edit" next to Webhook**
3. **Enter the Callback URL**: `https://njangionchain.com/api/whatsapp/webhook`.
   The callback URL applies to the whole Meta app, so pointing it at an ngrok
   tunnel takes webhooks away from production. For local testing, use a
   separate Meta app and set its callback URL to your ngrok URL plus
   `/api/whatsapp/webhook`.
4. **Enter the Verify token** (the same value as `WHATSAPP_VERIFY_TOKEN`)
5. **Click "Verify and save".** Meta sends a GET request to the callback URL
   and saves only if the app answers with the `hub.challenge` value. The list
   of webhook fields appears after that.
6. **Subscribe to the `messages` field.** It is the only field the app needs.
   It carries the messages people send to the business number (a `messages`
   array, including button and list replies) and the sent, delivered and read
   statuses of the messages the app sends (a `statuses` array).
   [`src/pages/api/whatsapp/webhook.ts`](../src/pages/api/whatsapp/webhook.ts)
   replies to incoming messages. It logs statuses only in development, so
   they don't show up in production logs.

`message_deliveries`, `message_reads`, `messaging_optins` and
`messaging_postbacks` are Messenger webhook fields for Facebook Pages. They
don't exist for WhatsApp, where delivery and read receipts arrive through
`messages`. See Meta's
[WhatsApp webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview)
page for the full field list.

### Step 3: Test Webhook

1. **Check your app logs** for the verification request (on Vercel: the
   project's **Logs** tab, filtered to `/api/whatsapp/webhook`). A passing
   check logs `Webhook verified successfully`.
2. **Send a test message** to your WhatsApp number
3. **Verify message appears** in your logs as `Incoming WhatsApp message`

---

## 🧪 Testing Your Setup

### Test Message Sending

```bash
# Test API endpoint (replace with your keys)
curl -X POST "https://graph.facebook.com/v21.0/YOUR_PHONE_NUMBER_ID/messages" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messaging_product": "whatsapp",
    "to": "YOUR_TEST_PHONE_NUMBER",
    "type": "text",
    "text": {
      "body": "Hello from Njangi! 🎉"
    }
  }'
```

### Test Webhook Reception

1. **Send a message TO your WhatsApp Business number**
2. **Check your application logs**
3. **Should see webhook event in console**

---

## 🔒 Security Best Practices

### Never Commit API Keys

```bash
# Add to .gitignore (should already be there)
.env
.env.local
.env.*.local

# Check what's being tracked
git status
# Make sure .env is not listed
```

### Use Different Keys for Development/Production

- **Development**: Use test phone numbers and temporary tokens
- **Production**: Use verified business phone numbers and permanent tokens

### Rotate Keys Regularly

- **Access tokens** can be regenerated in Meta Console
- **App secrets** should be rotated periodically
- **Webhook URLs** should use HTTPS only

---

## 🐛 Common Issues & Solutions

### Issue: Webhook Verification Failed
**Solution**: Ensure WHATSAPP_VERIFY_TOKEN matches exactly what you entered in Meta Console

### Issue: Messages Not Sending
**Solutions**:
- Check if phone number is verified in Meta Console
- Verify ACCESS_TOKEN is correct and not expired
- Ensure recipient phone number is in international format (+1234567890)

### Issue: Webhook Not Receiving Messages
**Solutions**:
- Verify webhook URL is publicly accessible
- Check that the `messages` field is subscribed (WhatsApp > Configuration)
- Make sure the Meta app is in Live mode: Meta doesn't send some webhooks to
  apps in Development mode

### Issue: 403 Forbidden Errors
**Solution**: Check if your app has proper permissions and phone number is verified

---

## 📞 Support

- **Meta Developer Docs**: https://developers.facebook.com/docs/whatsapp
- **WhatsApp Business API**: https://developers.facebook.com/docs/whatsapp/cloud-api
- **Business Manager**: https://business.facebook.com/

---

## ✅ Quick Checklist

- [ ] Created Meta Developer account
- [ ] Created Facebook app with WhatsApp product
- [ ] Added and verified phone number
- [ ] Got all 6 API credentials
- [ ] Added credentials to .env file
- [ ] Set the production variables in Vercel and redeployed
- [ ] Deployed app with public webhook URL
- [ ] Configured webhook in Meta Console
- [ ] Tested webhook verification
- [ ] Sent test message successfully
- [ ] Received webhook event successfully

**You're ready to use WhatsApp integration! 🎉** 