# 🤖 WhatsApp Bot Backend

A production-ready Node.js backend for WhatsApp Bot integration with Sui blockchain, featuring zkLogin authentication, Docker containerization, and Heroku deployment.

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [Local Development](#local-development)
- [Heroku Deployment](#heroku-deployment)
- [Environment Variables](#environment-variables)
- [Docker Commands](#docker-commands)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)

---

## �� Quick Start

### Prerequisites

- **Local Development:**
  - Docker Desktop installed ([download](https://www.docker.com/products/docker-desktop))
  - `.env.local` file with environment variables
  
- **Heroku Deployment:**
  - Heroku account ([create here](https://www.heroku.com))
  - Heroku CLI installed ([download](https://devcenter.heroku.com/articles/heroku-cli))
  - GitHub repository connected to Heroku

### 30-Second Setup

```bash
# 1. Clone and navigate to backend
cd whatsapp-bot-backend

# 2. Create .env.local (copy from .env.example and fill in values)
cp .env.example .env.local
# Edit .env.local with your credentials

# 3. Start locally with Docker
docker-compose up

# 4. Access the app
# Health: http://localhost:3000/health
# Status: http://localhost:3000/api/status
# Logs: docker-compose logs -f
```

---

## 🏃 Local Development

### Starting the Docker Container

#### Option 1: Using Docker Compose (Recommended)

```bash
# Start all services
docker-compose up

# Start in background
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

#### Option 2: Using Docker Directly

```bash
# Build image
docker build -t whatsapp-bot:latest .

# Run container
docker run -p 3000:3000 \
  --env-file .env.local \
  --name whatsapp-bot \
  whatsapp-bot:latest

# View logs
docker logs -f whatsapp-bot

# Stop container
docker stop whatsapp-bot
docker rm whatsapp-bot
```

### Accessing the Application

**Health Check:**
```bash
curl http://localhost:3000/health
```

**API Status:**
```bash
curl http://localhost:3000/api/status
```

**View Logs:**
```bash
docker-compose logs -f

# Follow logs with timestamps
docker-compose logs -f -t

# View last 100 lines
docker-compose logs --tail=100
```

### Development Workflow

```bash
# 1. Make code changes in src/

# 2. For TypeScript changes, rebuild:
docker-compose down
docker-compose build
docker-compose up

# 3. For simple log viewing:
docker-compose logs -f

# 4. Access container shell (if needed):
docker-compose exec bot sh

# 5. Restart without rebuild:
docker-compose restart
```

### Troubleshooting Local Setup

**Container won't start:**
```bash
# Check logs
docker-compose logs

# Rebuild from scratch
docker-compose down
docker-compose build --no-cache
docker-compose up
```

**Port 3000 already in use:**
```bash
# Use different port
docker run -p 3001:3000 ...

# Or kill process on port 3000
lsof -ti:3000 | xargs kill -9
```

**Environment variables not loading:**
```bash
# Verify .env.local exists
ls -la .env.local

# Check if variables are passed
docker-compose config | grep WHATSAPP_ACCESS_TOKEN
```

---

## 🌍 Heroku Deployment

### Prerequisites Setup

```bash
# 1. Install Heroku CLI
# macOS with Homebrew:
brew tap heroku/brew && brew install heroku

# 2. Login to Heroku
heroku login

# 3. Login to container registry
heroku container:login

# 4. Create Heroku app (if not created)
heroku create your-app-name
```

### Deployment Methods

#### Method 1: Automatic Git Push (Easiest) ⭐

This is the simplest method. Heroku reads `heroku.yml` and builds automatically.

```bash
# 1. Add Heroku remote (if not added)
heroku git:remote -a your-app-name

# 2. Deploy
git push heroku main

# 3. View deployment logs
heroku logs -t --app your-app-name

# 4. Verify deployment
curl https://your-app-name.herokuapp.com/health
```

**That's it!** Heroku automatically:
- Reads `heroku.yml`
- Builds Docker image
- Pushes to container registry
- Releases to dyno
- Starts application

#### Method 2: Manual Docker Push

If automatic deployment doesn't work:

```bash
# 1. Build image for Heroku
docker build -t registry.heroku.com/your-app-name/web:latest .

# 2. Push to Heroku container registry
docker push registry.heroku.com/your-app-name/web:latest

# 3. Release to dyno
heroku container:release web --app your-app-name

# 4. View logs
heroku logs -t --app your-app-name
```

### Configure Environment Variables on Heroku

```bash
# Set individual variables
heroku config:set WHATSAPP_ACCESS_TOKEN=xxx --app your-app-name
heroku config:set SUI_TESTNET_PACKAGE_ID=0x... --app your-app-name
heroku config:set ZKLOGIN_TESTNET_ENOKI_KEY=enoki_... --app your-app-name

# View all configured variables
heroku config --app your-app-name

# Remove a variable
heroku config:unset VARIABLE_NAME --app your-app-name

# Batch set from .env.local (macOS/Linux)
export $(cat .env.local | xargs) && heroku config:set $(env | grep -E 'NEXT_PUBLIC_|WHATSAPP_|SUI_|ZKLOGIN_' | sed 's/ /\n/g') --app your-app-name
```

**Required Environment Variables:**

```bash
# Sui Blockchain
NEXT_PUBLIC_TESTNET_RPC_URL=https://fullnode.testnet.sui.io:443
NEXT_PUBLIC_MAINNET_RPC_URL=https://fullnode.mainnet.sui.io:443
SUI_TESTNET_PACKAGE_ID=0x...
SUI_MAINNET_PACKAGE_ID=0x...
SUI_DEFAULT_PACKAGE_ID=0x...
SUI_WHATSAPP_LINKS_REGISTRY_ID=0x...

# WhatsApp
WHATSAPP_PHONE_NUMBER_ID=xxx
WHATSAPP_ACCESS_TOKEN=xxx
WHATSAPP_VERIFY_TOKEN=xxx
WHATSAPP_APP_SECRET=xxx
WHATSAPP_BUSINESS_ACCOUNT_ID=xxx
WHATSAPP_WEBHOOK_URL=https://your-app-name.herokuapp.com/api/whatsapp/webhook

# zkLogin / Enoki
ZKLOGIN_TESTNET_ENOKI_KEY=enoki_private_...
ZKLOGIN_MAINNET_ENOKI_KEY=enoki_private_...
ZKLOGIN_DEFAULT_ENOKI_KEY=enoki_private_...

# OAuth Providers
ZKLOGIN_GOOGLE_CLIENT_ID=xxx
ZKLOGIN_GOOGLE_CLIENT_SECRET=xxx
ZKLOGIN_FACEBOOK_CLIENT_ID=xxx
ZKLOGIN_FACEBOOK_CLIENT_SECRET=xxx
ZKLOGIN_APPLE_CLIENT_ID=xxx
ZKLOGIN_APPLE_CLIENT_SECRET=xxx
```

### Monitor Heroku Application

```bash
# View real-time logs
heroku logs -t --app your-app-name

# View last 100 lines
heroku logs -n 100 --app your-app-name

# Search logs
heroku logs --app your-app-name | grep ERROR
heroku logs --app your-app-name | grep correlation-id

# Check application status
heroku ps --app your-app-name

# View releases
heroku releases --app your-app-name
```

### Scale Application on Heroku

```bash
# Current dyno type
heroku ps --app your-app-name

# Upgrade to 2X dyno (1GB RAM, $14/month)
heroku dyno:resize standard-2x --app your-app-name

# Downgrade to 1X dyno (512MB RAM, $7/month)
heroku dyno:resize standard-1x --app your-app-name

# Scale to multiple dynos (if needed)
heroku ps:scale web=2 --app your-app-name

# Scale back to 1
heroku ps:scale web=1 --app your-app-name
```

### Restart Application

```bash
# Restart all dynos
heroku restart --app your-app-name

# Restart specific dyno
heroku dyno:restart web.1 --app your-app-name
```

### Rollback Deployment

```bash
# View release history
heroku releases --app your-app-name

# Rollback to previous version
heroku releases:rollback --app your-app-name

# Rollback to specific version
heroku releases:rollback v5 --app your-app-name

# Check current version after rollback
heroku releases --app your-app-name
```

### Delete Application

```bash
# WARNING: This deletes everything!
heroku apps:destroy --app your-app-name --confirm your-app-name
```

---

## 🔑 Environment Variables

### Setup .env.local

1. **Copy template:**
   ```bash
   cp .env.example .env.local
   ```

2. **Edit .env.local with your values:**
   ```
   # Server
   NODE_ENV=development
   PORT=3000
   LOG_LEVEL=info

   # Sui Blockchain
   NEXT_PUBLIC_TESTNET_RPC_URL=https://fullnode.testnet.sui.io:443
   NEXT_PUBLIC_MAINNET_RPC_URL=https://fullnode.mainnet.sui.io:443
   SUI_TESTNET_PACKAGE_ID=0xf6db2b...
   SUI_MAINNET_PACKAGE_ID=0x7bf527...
   SUI_DEFAULT_PACKAGE_ID=0xc5929...

   # WhatsApp
   WHATSAPP_PHONE_NUMBER_ID=6985791...
   WHATSAPP_ACCESS_TOKEN=EAAKxb13Pe...
   WHATSAPP_VERIFY_TOKEN=ABC123
   WHATSAPP_APP_SECRET=53b58922cb5b...

   # zkLogin / Enoki
   ZKLOGIN_TESTNET_ENOKI_KEY=enoki_private_9b2...
   ZKLOGIN_MAINNET_ENOKI_KEY=enoki_private_...
   ZKLOGIN_DEFAULT_ENOKI_KEY=enoki_private_9b2...

   # OAuth
   ZKLOGIN_GOOGLE_CLIENT_ID=764148...
   ZKLOGIN_GOOGLE_CLIENT_SECRET=...
   ZKLOGIN_FACEBOOK_CLIENT_ID=89942...
   ZKLOGIN_FACEBOOK_CLIENT_SECRET=...
   ZKLOGIN_APPLE_CLIENT_ID=com.apple...
   ZKLOGIN_APPLE_CLIENT_SECRET=...
   ```

3. **For Heroku, set via CLI:**
   ```bash
   heroku config:set KEY=value --app your-app-name
   ```

### Never Commit Credentials

**Always add to .gitignore:**
```
.env
.env.local
.env.*.local
```

---

## 🐳 Docker Commands

### Image Management

```bash
# Build image
docker build -t whatsapp-bot:latest .

# Build with no cache
docker build --no-cache -t whatsapp-bot:latest .

# List images
docker images | grep whatsapp-bot

# Remove image
docker rmi whatsapp-bot:latest
```

### Container Management

```bash
# Run container
docker run -p 3000:3000 --env-file .env.local whatsapp-bot:latest

# Run in background
docker run -d -p 3000:3000 --env-file .env.local whatsapp-bot:latest

# List running containers
docker ps

# List all containers (including stopped)
docker ps -a

# Stop container
docker stop whatsapp-bot

# Remove container
docker rm whatsapp-bot

# View logs
docker logs whatsapp-bot
docker logs -f whatsapp-bot

# Access container shell
docker exec -it whatsapp-bot sh
```

### Docker Compose

```bash
# Start services
docker-compose up

# Start in background
docker-compose up -d

# Stop services
docker-compose down

# Rebuild services
docker-compose build

# View logs
docker-compose logs -f

# Access container
docker-compose exec bot sh

# Remove volumes
docker-compose down -v
```

### Debugging

```bash
# Check container stats
docker stats whatsapp-bot

# View container details
docker inspect whatsapp-bot

# View health check status
docker inspect --format='{{json .State.Health}}' whatsapp-bot

# Test health endpoint
curl http://localhost:3000/health

# View container logs with timestamps
docker logs -t whatsapp-bot
```

---

## 🔧 Troubleshooting

### Container Won't Start

```bash
# Check logs
docker-compose logs

# Rebuild from scratch
docker-compose down
docker-compose build --no-cache
docker-compose up

# Check for configuration errors
docker-compose logs | grep -i error
```

### Port Already in Use

```bash
# Kill process on port 3000
lsof -ti:3000 | xargs kill -9

# Or use different port
docker run -p 3001:3000 ...
```

### Environment Variables Not Loading

```bash
# Verify .env.local exists and has values
cat .env.local

# Check if variables are passed to container
docker-compose config | grep WHATSAPP
```

### Heroku Deployment Fails

```bash
# Check build logs
heroku logs --app your-app-name

# Verify heroku.yml exists
cat heroku.yml

# Try manual deployment
heroku container:login
docker build -t registry.heroku.com/your-app-name/web:latest .
docker push registry.heroku.com/your-app-name/web:latest
heroku container:release web --app your-app-name
```

### High Memory Usage

```bash
# Check memory consumption
docker stats whatsapp-bot

# If consistently > 300MB:
# 1. Upgrade to 2X dyno (1GB)
# 2. Check logs for memory leaks
# 3. Profile application
```

### Logs Not Appearing

```bash
# Check log volume mount
docker volume ls | grep whatsapp

# View logs directly
docker exec whatsapp-bot cat logs/app.log

# Check log file size
docker exec whatsapp-bot ls -lh logs/
```

---

## 📁 Project Structure

```
whatsapp-bot-backend/
├── src/
│   ├── config/
│   │   ├── config.ts           # Configuration loading & validation
│   │   └── index.ts
│   ├── middleware/
│   │   ├── errorHandler.ts     # Global error handling
│   │   └── requestLogger.ts    # Request logging with correlation IDs
│   ├── utils/
│   │   ├── errors.ts           # Custom error classes
│   │   └── logger.ts           # Winston logger setup
│   ├── server.ts               # Express server entry point
│   └── ...
├── dist/                        # Compiled JavaScript output
├── logs/
│   ├── app.log                 # All application logs
│   ├── error.log               # Errors only
│   ├── exceptions.log          # Uncaught exceptions
│   └── rejections.log          # Unhandled rejections
├── Dockerfile                  # Multi-stage Docker build
├── .dockerignore               # Docker build context exclusions
├── docker-compose.yml          # Local development configuration
├── heroku.yml                  # Heroku deployment configuration
├── DOCKER_GUIDE.md             # Detailed Docker guide
├── README.md                   # This file
├── package.json                # Dependencies
├── tsconfig.json               # TypeScript configuration
└── .env.example                # Environment variables template
```

---

## 📊 Performance Specs

### Docker Image

| Metric | Value |
|--------|-------|
| Base Image | node:18-alpine3.19 |
| Image Size | ~250MB |
| Build Time | ~45 seconds |
| Startup Time | ~3 seconds |

### Runtime

| Metric | Value |
|--------|-------|
| Memory (Idle) | ~80MB |
| Memory (Typical) | ~120MB |
| Memory (Peak) | ~150MB |
| Heroku 1X Dyno | 512MB (✅ Comfortable) |

### API Performance

| Operation | Time |
|-----------|------|
| Health Check | <100ms |
| WhatsApp Message | 100-600ms |
| Sui RPC Call | 100-500ms |

---

## 🔒 Security

✅ **Implemented:**
- Non-root user in Docker container
- Alpine Linux (minimal image)
- Health checks enabled
- Proper signal handling (dumb-init)
- Environment variables not in image
- Error messages don't leak internals

✅ **Best Practices:**
- Never commit `.env` files
- Use Heroku config vars for production
- Regularly rebuild image for security patches
- Monitor logs for suspicious activity

---

## 🚀 Next Steps

1. **Start locally:**
   ```bash
   docker-compose up
   ```

2. **Verify it works:**
   ```bash
   curl http://localhost:3000/health
   ```

3. **Deploy to Heroku:**
   ```bash
   heroku create your-app-name
   git push heroku main
   ```

4. **Monitor:**
   ```bash
   heroku logs -t --app your-app-name
   ```

5. **Update WhatsApp webhook:**
   ```
   https://your-app-name.herokuapp.com/api/whatsapp/webhook
   ```

---

## 📚 Additional Resources

- [Docker Documentation](https://docs.docker.com/)
- [Heroku Container Registry](https://devcenter.heroku.com/articles/container-registry-and-runtime)
- [Heroku CLI Reference](https://devcenter.heroku.com/articles/heroku-cli-commands)
- [Node.js Best Practices](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md)
- [DOCKER_GUIDE.md](./DOCKER_GUIDE.md) - Detailed Docker guide

---

## 💡 Tips

**Development:**
- Use `docker-compose up` for quick local testing
- Mount volumes for hot reload (src/ directory)
- Check correlation IDs in logs for debugging

**Production:**
- Set environment variables via Heroku CLI
- Monitor logs regularly
- Plan scaling strategy (upgrade dyno or add instances)
- Use Heroku metrics for performance monitoring

**Cost Optimization:**
- Start with 1X dyno ($7/month)
- Upgrade to 2X only if needed ($14/month)
- Use Eco dyno for staging ($5/month, shared)

---

## 🆘 Support

For issues:

1. **Check logs:**
   ```bash
   docker-compose logs    # Local
   heroku logs -t         # Heroku
   ```

2. **Test locally first:**
   - Verify `.env.local` has all required variables
   - Run `docker-compose up` and test `/health` endpoint

3. **Verify configuration:**
   ```bash
   heroku config --app your-app-name
   ```

4. **Rebuild from scratch:**
   ```bash
   docker-compose down
   docker-compose build --no-cache
   docker-compose up
   ```

---

## 📝 License

This project is part of the Njangi on-chain application.

---

**Created:** 2025
**Technology:** Node.js, Express, Docker, Heroku, TypeScript, Winston
**Status:** ✅ Production Ready

