# 🔧 WhatsApp Bot Backend - Environment Setup Guide

## Quick Setup

### 1. ✅ Automatic Setup Done

The `.env.local` file has been created with placeholder values. You need to update a few keys:

```bash
cd whatsapp-bot-backend
```

### 2. 🔑 Required Configuration

Update these in `.env.local`:

#### Sui Package IDs
```env
# From your main project .env.local, find:
NEXT_PUBLIC_TESTNET_PACKAGE_ID=... → copy to SUI_TESTNET_PACKAGE_ID
NEXT_PUBLIC_MAINNET_PACKAGE_ID=... → copy to SUI_MAINNET_PACKAGE_ID
```

#### WhatsApp Links Registry
```env
# Deploy the Move contract and update:
SUI_WHATSAPP_LINKS_REGISTRY_ID=0x...
```

#### Enoki (zkLogin) Keys
```env
# Get from your Enoki dashboard:
ZKLOGIN_TESTNET_ENOKI_KEY=enoki_testnet_...
ZKLOGIN_MAINNET_ENOKI_KEY=enoki_mainnet_...
```

#### OAuth Credentials (Optional for local dev)
```env
# For testing with real OAuth:
ZKLOGIN_GOOGLE_CLIENT_ID=...
ZKLOGIN_GOOGLE_CLIENT_SECRET=...
```

### 3. 🚀 Start the Backend

```bash
# Terminal 1: Main project (optional - for full app)
npm start

# Terminal 2: WhatsApp Bot Backend
cd whatsapp-bot-backend
npm install
npm run dev
```

### 4. ✅ Verify It's Running

```bash
curl http://localhost:3001/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "whatsapp-bot",
  "uptime": 1234,
  "environment": "development"
}
```

## Environment Variables Explained

### Server Configuration
- `NODE_ENV`: `development` or `production`
- `PORT`: Server port (default: 3001)
- `LOG_LEVEL`: `debug`, `info`, `warn`, or `error`

### Sui RPC
- `SUI_TESTNET_RPC_URL`: Primary testnet RPC
- `SUI_TESTNET_RPC_ALT`: Fallback testnet RPC
- `SUI_MAINNET_RPC_URL`: Primary mainnet RPC
- `SUI_MAINNET_RPC_ALT`: Fallback mainnet RPC

### Package IDs
- `SUI_TESTNET_PACKAGE_ID`: Your deployed contract on testnet
- `SUI_MAINNET_PACKAGE_ID`: Your deployed contract on mainnet
- `SUI_DEFAULT_PACKAGE_ID`: Which one to use (testnet or mainnet)
- `SUI_WHATSAPP_LINKS_REGISTRY_ID`: The shared object for WhatsApp links

### WhatsApp API
- `WHATSAPP_PHONE_NUMBER_ID`: Your WhatsApp business phone number ID
- `WHATSAPP_ACCESS_TOKEN`: Long-lived WhatsApp API token
- `WHATSAPP_VERIFY_TOKEN`: Webhook verify token
- `WHATSAPP_APP_SECRET`: App secret for webhook validation

### zkLogin / Enoki
- `ZKLOGIN_TESTNET_ENOKI_KEY`: Enoki API key for testnet
- `ZKLOGIN_MAINNET_ENOKI_KEY`: Enoki API key for mainnet
- OAuth credentials for Google, Facebook, Apple

## Troubleshooting

### "Missing required environment variable: X"

Check `.env.local` exists and contains the variable. Restart the server:

```bash
npm run dev
```

### "Cannot connect to RPC"

- Verify `SUI_TESTNET_RPC_URL` is correct
- Check internet connection
- Try the alternate RPC URL (`SUI_TESTNET_RPC_ALT`)

### "WhatsApp API errors"

- Verify `WHATSAPP_ACCESS_TOKEN` is valid and not expired
- Check `WHATSAPP_PHONE_NUMBER_ID` matches your business account

## Production Deployment

For Heroku deployment:

1. Set environment variables via Heroku CLI:
```bash
heroku config:set NODE_ENV=production PORT=3000 --app your-app
heroku config:set SUI_MAINNET_PACKAGE_ID=0x... --app your-app
```

2. Or update `heroku.yml` with your settings

See `DOCKER_GUIDE.md` for Docker/Heroku deployment instructions.
