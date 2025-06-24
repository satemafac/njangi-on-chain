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

### For Production (Heroku/Vercel)

**Set environment variables in your hosting platform:**

```bash
# Heroku
heroku config:set WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
heroku config:set WHATSAPP_ACCESS_TOKEN=your_access_token
heroku config:set WHATSAPP_VERIFY_TOKEN=your_verify_token
heroku config:set WHATSAPP_APP_SECRET=your_app_secret
heroku config:set WHATSAPP_WEBHOOK_URL=https://your-app.herokuapp.com/api/whatsapp/webhook
heroku config:set WHATSAPP_API_VERSION=v21.0

# Vercel (add to Vercel dashboard > Settings > Environment Variables)
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_ACCESS_TOKEN=your_access_token
WHATSAPP_VERIFY_TOKEN=your_verify_token
WHATSAPP_APP_SECRET=your_app_secret
WHATSAPP_WEBHOOK_URL=https://your-app.vercel.app/api/whatsapp/webhook
WHATSAPP_API_VERSION=v21.0
```

---

## 🔗 Webhook Configuration

### Step 1: Deploy Your App First

Your webhook endpoint must be publicly accessible:
- **Development**: Use ngrok: `ngrok http 3000`
- **Production**: Deploy to Heroku/Vercel first

### Step 2: Configure Webhook in Meta Console

1. **Go to WhatsApp > Configuration**
2. **Click "Edit" next to Webhook**
3. **Enter your webhook URL**: `https://yourdomain.com/api/whatsapp/webhook`
4. **Enter your verify token** (same as WHATSAPP_VERIFY_TOKEN)
5. **Subscribe to these webhook fields**:
   - `messages`
   - `message_deliveries` 
   - `message_reads`
   - `messaging_optins`

### Step 3: Test Webhook

1. **Click "Verify and Save"** in Meta Console
2. **Check your app logs** to see webhook verification
3. **Send a test message** to your WhatsApp number
4. **Verify message appears** in your logs

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
- Check webhook subscription fields are enabled
- Ensure app is not in development mode restrictions

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
- [ ] Deployed app with public webhook URL
- [ ] Configured webhook in Meta Console
- [ ] Tested webhook verification
- [ ] Sent test message successfully
- [ ] Received webhook event successfully

**You're ready to use WhatsApp integration! 🎉** 