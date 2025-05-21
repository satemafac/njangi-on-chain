# zkLogin Services Setup

This document explains how to configure your application to use either local or Heroku-hosted zkLogin services.

## Available Services

### Local Services
- Backend zkLogin Prover: http://localhost:5001/input
- Frontend zkLogin Service: http://localhost:5003
- Salt Service: http://localhost:5002

### Heroku Services
- Backend zkLogin Prover: https://zklogin-backend-fix3-46730ab9ae9f.herokuapp.com/input
- Frontend zkLogin Service: https://zklogin-frontend-fix3-e9578d3d8fdb.herokuapp.com
- Salt Service: https://zklogin-salt-service-545adc326c28.herokuapp.com

## Switching Between Services

We've created a convenient script that allows you to easily switch between local and Heroku zkLogin services:

```bash
# Switch to local services
./zklogin-switch.sh local

# Switch to Heroku services
./zklogin-switch.sh heroku

# Check current configuration
./zklogin-switch.sh status
```

After switching, you need to load the environment variables into your shell:

```bash
source .env.zklogin
```

## Managing Heroku Services

The `heroku-zklogin-services.sh` script provides commands to manage Heroku-hosted services:

```bash
# Check if all services are running
./heroku-zklogin-services.sh check

# Wake up sleeping services
./heroku-zklogin-services.sh wake

# Restart all services
./heroku-zklogin-services.sh restart

# Create an .env.zklogin file with Heroku service URLs
./heroku-zklogin-services.sh config
```

## Managing Local Services

To start local zkLogin services, use:

```bash
./start-zklogin-services.sh
```

This will:
1. Download the zkLogin.zkey file if needed
2. Start the Docker containers for the prover services
3. Start the local salt service

## Troubleshooting

### Heroku Services
- Heroku free tier dynos go to sleep after 30 minutes of inactivity
- Use `./heroku-zklogin-services.sh wake` to wake them up
- The backend service runs on a Standard-2X dyno due to memory requirements
- Services return different status codes when checked:
  - Backend: Returns 405 Method Not Allowed for HEAD requests to /input
  - Frontend: Returns 200 OK for /ping
  - Salt: Returns 200 OK for /ping

### Local Services
- Ensure Docker is running before starting local services
- Make sure ports 5001, 5002, and 5003 are available
- Check Docker logs if services fail to start:
  ```bash
  docker logs zklogin_backend_1
  docker logs zklogin_frontend_1
  ``` 