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
4. The token can now access your phone number ID (the value of `WHATSAPP_PHONE_NUMBER_ID`)

### Step 4: Update the Vercel Environment Variable

Production reads the token from `WHATSAPP_ACCESS_TOKEN` in the Vercel project.
It is a server-only variable: never copy the token into a `NEXT_PUBLIC_`
variable, because Next.js inlines those into the browser bundle.

1. In the Vercel project, open **Settings → Environment Variables**.
2. Edit `WHATSAPP_ACCESS_TOKEN` in the **Production** environment, paste the
   new token, keep it **Sensitive**, and save. If Preview or Development also
   lists the variable, update it there too.
3. Redeploy production. Vercel applies environment variable changes only to
   deployments built after the change: open **Deployments**, then the current
   production deployment's **⋯** menu, and choose **Redeploy**.

The same steps with the CLI. `vercel env update` prompts for the value, so the
token never lands in your shell history:

```bash
# See which environments hold the variable (Sensitive values stay hidden)
vercel env ls

# Replace the Production value
vercel env update WHATSAPP_ACCESS_TOKEN production --sensitive

# Rebuild the current production deployment so it picks up the new value
vercel redeploy <production-deployment-url>
```

[docs/whatsapp-api-setup.md](docs/whatsapp-api-setup.md#for-production-vercel)
lists the other WhatsApp variables and the Vercel environments that need them.

## Testing the Permanent Token

1. **Check the token itself.** This prints the business number and its
   verified name. Error 190 means the token is invalid or expired:

   ```bash
   read -rs WHATSAPP_ACCESS_TOKEN   # paste the token; it is not echoed or saved to history
   curl -s "https://graph.facebook.com/v23.0/<phone-number-id>?fields=display_phone_number,verified_name" \
     -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN"
   ```

   Meta's [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/)
   shows when a token expires. A permanent token has no expiry date.

2. **Check production.** From a WhatsApp number that can message the business
   number, send `help`. The production webhook (`/api/whatsapp/webhook`)
   answers with the channel's help text, sent with `WHATSAPP_ACCESS_TOKEN`.
   No reply? Open the project's **Logs** tab in Vercel, filter to
   `/api/whatsapp/webhook`, and look for:
   - `Failed to send help message` with error code 190 in the body:
     production still has the old token. Check the Production value, and
     check that you redeployed.
   - `Rejected webhook with missing or invalid signature`: the request never
     reached the reply. `WHATSAPP_APP_SECRET` doesn't match the Meta app's
     secret.

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
2. ✅ Set `WHATSAPP_ACCESS_TOKEN` in the Vercel Production environment
3. ✅ Redeploy production
4. ✅ Send `help` to the business number and get the reply

