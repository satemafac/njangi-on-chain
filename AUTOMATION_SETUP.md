# 🤖 Automation System Setup Guide

This guide will help you set up the Njangi automation system for time-based payout notifications and one-click admin approvals.

## 📋 Prerequisites

- Node.js 18+ installed
- A Sui wallet with testnet/mainnet SUI tokens for gas fees
- WhatsApp Business API account (for notifications)
- Access to deploy/run the application

## 🔑 Required Environment Variables

Create a `.env` file in your project root with these variables:

```bash
# ================================================
# 🔧 AUTOMATION SYSTEM ENVIRONMENT VARIABLES
# ================================================

# Node Environment
NODE_ENV=development

# Sui Network Configuration
NEXT_PUBLIC_SUI_NETWORK=testnet
NEXT_PUBLIC_SUI_RPC_URL=https://fullnode.testnet.sui.io:443

# ================================================
# 🌐 APPLICATION CONFIGURATION (CRITICAL FOR APPROVAL LINKS)
# ================================================
# Base URL used for generating one-click approval links sent via WhatsApp
# ⚠️  IMPORTANT: This must be your actual domain for approval links to work
NEXT_PUBLIC_BASE_URL=https://yourdomain.com

# ================================================
# 📱 WHATSAPP BUSINESS API (REQUIRED FOR NOTIFICATIONS)
# ================================================
# Get these from Facebook Developers Console (developers.facebook.com)
WHATSAPP_PHONE_NUMBER_ID=your_whatsapp_phone_number_id
WHATSAPP_ACCESS_TOKEN=your_whatsapp_access_token
WHATSAPP_VERIFY_TOKEN=your_chosen_verify_token
WHATSAPP_APP_SECRET=your_whatsapp_app_secret
WHATSAPP_WEBHOOK_URL=https://yourdomain.com/api/whatsapp/webhook
WHATSAPP_API_VERSION=v21.0



# ================================================
# 📊 OPTIONAL: MONITORING & LOGGING
# ================================================
LOG_LEVEL=debug
```

## 🚀 Step-by-Step Setup

### 1. 📱 Setup WhatsApp Business API

1. **Go to [Meta for Developers](https://developers.facebook.com/)**
2. **Create a new app** → Business → WhatsApp Business API
3. **Get your credentials:**
   - Phone Number ID
   - Access Token  
   - App Secret
4. **Set up webhook** pointing to: `https://yourdomain.com/api/whatsapp/webhook`
5. **Verify webhook** with your chosen verify token

### 2. 🔧 Install Dependencies

```bash
# Install project dependencies
npm install

# Or if using yarn
yarn install
```

### 3. 🏗️ Build and Deploy Smart Contracts

```bash
# Navigate to move directory
cd move

# Build the contracts
sui move build

# Publish contracts (if not already published)
sui client publish --gas-budget 100000000

# Note the package ID for your .env file
```

### 4. 🎯 Start the Automation Service

The automation service can be started in several ways:

#### Option A: Manual Start (Development)
```bash
# Start the Next.js application
npm run dev

# The automation service will start automatically with the application
```

#### Option B: Standalone Automation Service
```bash
# Create a standalone script to run automation
node -e "
const { automationCronService } = require('./src/services/automation-cron.service.ts');
automationCronService.start();
console.log('Automation service started');
"
```

#### Option C: Production Deployment
```bash
# Build for production
npm run build

# Start production server
npm start

# Or use PM2 for process management
npm install -g pm2
pm2 start npm --name "njangi-automation" -- start
```

## 🔔 How the Approval System Works

The automation system uses a **notification-based approach** for security:

### 🕐 **Monitoring Phase**
- System monitors all active circles every **5 minutes**
- Checks for overdue payouts using blockchain time validation
- Sends progressive warnings at **24h**, **6h**, and **1h** before deadline

### 📱 **Approval Request Phase**
When a payout becomes overdue:
1. **WhatsApp notification** sent to circle admin
2. **Simple approval link** included in message (no tokens needed!)
3. **Admin clicks link** → taken to approval page

### ✅ **Execution Phase**
1. Admin reviews payout details
2. Admin logs in with their Sui wallet (zkLogin)
3. Admin clicks "Approve & Execute Payout"
4. **Admin's own wallet** executes the transaction
5. All members receive success notification

### 🔒 **Security Benefits**
- ✅ **No admin private keys** stored in the system
- ✅ **No tokens or off-chain secrets** required
- ✅ **Pure blockchain verification** for all permissions
- ✅ **Admin maintains full control** over payouts
- ✅ **Cryptographic wallet signatures** for authentication
- ✅ **Audit trail** of all approval requests
- ✅ **Manual override** always available

## 📊 Monitor the System

### Access the Dashboard
Visit: `http://localhost:3000/automation/dashboard`

The dashboard shows:
- ✅ System health status
- 📈 Active circles being monitored
- 🔔 Recent notifications sent
- 📋 Audit logs
- ⚠️ Active alerts

### API Endpoints
- **Dashboard Data**: `GET /api/automation/dashboard`
- **Audit Logs**: `GET /api/automation/logs`

## 🔐 Security Considerations

### 🛡️ Environment Variables Security
- **Never commit `.env` files** to version control
- **Rotate WhatsApp tokens** regularly
- **Secure approval tokens** expire after 24 hours
- **Use HTTPS** for approval links in production

### 🔗 Blockchain Security
- **Wallet-based authentication** prevents unauthorized access
- **Smart contract validation** ensures only real admins can approve
- **On-chain payout verification** confirms payouts are actually overdue
- **No replay attacks** possible due to blockchain state verification

### 👥 Admin Access Control
- **Each circle admin** manages their own payouts
- **No shared credentials** or central admin keys
- **Wallet-based authentication** using zkLogin
- **Audit trail** of all approval requests and executions

## ⚙️ Configuration Options

### Automation Intervals
The system runs on multiple intervals:
- **5 minutes**: Check for overdue payouts
- **1 hour**: Send progress notifications
- **24 hours**: System health checks

### Notification Settings
Configure notification templates in:
- `src/services/whatsapp-notification.service.ts`

### Monitoring Thresholds
Adjust alert thresholds in:
- `src/services/automation-monitoring.service.ts`

## 🚨 Troubleshooting

### Common Issues

1. **"Access Denied" or "You are not the admin"**
   - Ensure you're logged in with the correct wallet
   - Verify the wallet address matches the circle admin
   - Check blockchain connection is working

2. **"WhatsApp API authentication failed"**
   - Check all WhatsApp environment variables
   - Verify access token is valid
   - Ensure phone number is verified

3. **"Sui RPC connection failed"**
   - Check `NEXT_PUBLIC_SUI_RPC_URL` is correct
   - Verify network connectivity
   - Try alternative RPC endpoints

4. **"Admin authentication required"**
   - Admin must log in with their Sui wallet
   - Check zkLogin service is working
   - Verify wallet has sufficient SUI for gas

### Debug Mode
Enable detailed logging:
```bash
LOG_LEVEL=debug npm run dev
```

## 📞 Support

For additional help:
1. Check the automation dashboard for system status
2. Review audit logs for detailed error information
3. Verify all environment variables are correctly set
4. Ensure admin wallet has sufficient SUI balance

## 🔄 Production Deployment

For production deployment:

1. **Update environment variables:**
   ```bash
   NODE_ENV=production
   NEXT_PUBLIC_SUI_NETWORK=mainnet
   NEXT_PUBLIC_SUI_RPC_URL=https://fullnode.mainnet.sui.io:443
   NEXT_PUBLIC_BASE_URL=https://yourdomain.com
   LOG_LEVEL=error
   ```

2. **Set up proper monitoring** and alerts

3. **Configure reverse proxy** (nginx/cloudflare) for HTTPS

4. **Set up automated backups** for logs and configuration

---

🎉 **Your automation system is now ready to handle time-based payouts and notifications automatically!** 