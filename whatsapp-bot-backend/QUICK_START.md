# ⚡ Quick Start Guide

## 🏃 30-Second Local Start

```bash
# 1. Prepare environment
cp .env.example .env.local
# Edit .env.local with your values

# 2. Start Docker
docker-compose up

# 3. Test
curl http://localhost:3000/health
```

**Done!** App is running at `http://localhost:3000`

---

## 🚀 Deploy to Heroku (5 Minutes)

### First Time Setup

```bash
# 1. Install Heroku CLI
brew tap heroku/brew && brew install heroku

# 2. Login
heroku login
heroku container:login

# 3. Create app
heroku create your-app-name

# 4. Add GitHub remote
git remote add heroku https://git.heroku.com/your-app-name.git
```

### Deploy

```bash
# Simple: just push!
git push heroku main

# Done! App deployed to:
# https://your-app-name.herokuapp.com
```

### Configure Environment

```bash
# Set all env vars
heroku config:set WHATSAPP_ACCESS_TOKEN=xxx --app your-app-name
heroku config:set SUI_TESTNET_PACKAGE_ID=0x... --app your-app-name
# ... (set all variables from .env.local)

# Or batch set:
export $(cat .env.local | xargs) && \
heroku config:set \
  $(env | grep -E 'NEXT_PUBLIC_|WHATSAPP_|SUI_|ZKLOGIN_' | sed 's/ /\n/g') \
  --app your-app-name
```

### Verify Deployment

```bash
# Check status
heroku ps -a your-app-name

# View logs
heroku logs -t -a your-app-name

# Test endpoint
curl https://your-app-name.herokuapp.com/health
```

---

## 📋 Common Commands

### Local Development

| Command | Purpose |
|---------|---------|
| `docker-compose up` | Start all services |
| `docker-compose up -d` | Start in background |
| `docker-compose logs -f` | View logs in real-time |
| `docker-compose down` | Stop services |
| `docker-compose exec bot sh` | Access container shell |
| `docker-compose rebuild` | Rebuild after code changes |

### Heroku Management

| Command | Purpose |
|---------|---------|
| `git push heroku main` | Deploy latest code |
| `heroku logs -t` | View real-time logs |
| `heroku config` | View env vars |
| `heroku config:set KEY=val` | Set env var |
| `heroku restart` | Restart app |
| `heroku logs \| grep ERROR` | Find errors |

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Port 3000 in use | `lsof -ti:3000 \| xargs kill -9` |
| Container won't start | `docker-compose logs` then `docker-compose build --no-cache` |
| Env vars not loading | `cat .env.local` and verify `docker-compose config` |
| Heroku deploy fails | `heroku logs` and check `heroku.yml` |

---

## 🔑 Required Environment Variables

Minimum set needed to run:

```bash
# Sui
SUI_TESTNET_PACKAGE_ID=0x...
SUI_DEFAULT_PACKAGE_ID=0x...

# WhatsApp
WHATSAPP_ACCESS_TOKEN=xxx
WHATSAPP_VERIFY_TOKEN=xxx
WHATSAPP_PHONE_NUMBER_ID=xxx

# Enoki
ZKLOGIN_DEFAULT_ENOKI_KEY=enoki_private_...

# OAuth (at least one)
ZKLOGIN_GOOGLE_CLIENT_ID=xxx
```

Full list in `.env.example`

---

## 🌍 Deployment Checklist

```bash
# Before deploying to Heroku:

☐ docker-compose up works locally
☐ curl http://localhost:3000/health returns 200
☐ .env.local has all values
☐ .env.local is in .gitignore
☐ heroku create your-app-name executed
☐ All env vars set via heroku config:set

# Deploy:

☐ git push heroku main
☐ heroku logs -t shows no errors
☐ curl https://your-app-name.herokuapp.com/health returns 200
☐ WhatsApp webhook updated to https://your-app-name.herokuapp.com/api/whatsapp/webhook

# Done! ✅
```

---

## 📊 Monitoring

```bash
# View logs
heroku logs -t --app your-app-name

# Search logs
heroku logs --app your-app-name | grep "ERROR"
heroku logs --app your-app-name | grep "correlation-id"

# Check health
curl https://your-app-name.herokuapp.com/health

# Monitor resources
heroku ps --app your-app-name
heroku logs | grep "memory"
```

---

## 💰 Cost

- **Heroku 1X Dyno**: $7/month ✅ (Perfect for your bot)
- **Heroku 2X Dyno**: $14/month (If you need more power)
- **Database/Cache**: $0 (You don't need them yet)

---

## 🆘 Help

**If something breaks:**

1. Check local: `docker-compose logs`
2. Check Heroku: `heroku logs -t --app your-app-name`
3. Rebuild: `docker-compose down && docker-compose build --no-cache && docker-compose up`
4. Redeploy: `git push heroku main`

**Read full docs:**
- `README.md` - Complete guide
- `DOCKER_GUIDE.md` - Detailed Docker guide

---

**That's it!** You now have a production WhatsApp bot running on Heroku! 🎉

