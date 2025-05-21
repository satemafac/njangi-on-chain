# Heroku zkLogin Services

This project has the following zkLogin services deployed on Heroku:

1. **Backend zkLogin Prover**: https://zklogin-backend-service-ba736adc0eb8.herokuapp.com
2. **Frontend zkLogin Service**: https://zklogin-frontend-service-f74353d605f9.herokuapp.com
3. **Salt Service**: https://zklogin-salt-service-545adc326c28.herokuapp.com

## Tools for Managing zkLogin Services

### Checking Service Status

To check if all services are running:

```bash
./heroku-zklogin-services.sh check
```

### Waking Up Services

Heroku free tier apps go to sleep after 30 minutes of inactivity. Wake them up with:

```bash
./heroku-zklogin-services.sh wake
```

### Restarting Services

If you need to restart the services:

```bash
./heroku-zklogin-services.sh restart
```

### Configuring Environment Variables

To create a `.env.zklogin` file with all the service URLs:

```bash
./heroku-zklogin-services.sh config
source .env.zklogin
```

## Updating Your Application

There are two ways to update your application to use the Heroku services:

### Option 1: Use the Auto-Update Script

This script will automatically scan your codebase and replace localhost URLs with Heroku URLs:

```bash
node update-zklogin-config.js
```

### Option 2: Manual Updates

Replace the following URLs in your application code:

- Replace `http://localhost:5001` with `https://zklogin-backend-service-ba736adc0eb8.herokuapp.com`
- Replace `http://localhost:5003` with `https://zklogin-frontend-service-f74353d605f9.herokuapp.com`
- Replace `http://localhost:5002` with `https://zklogin-salt-service-545adc326c28.herokuapp.com`

## Testing the Services

You can test each service endpoint directly:

```bash
# Test Backend Prover
curl -s https://zklogin-backend-service-ba736adc0eb8.herokuapp.com/ping

# Test Frontend Service
curl -s https://zklogin-frontend-service-f74353d605f9.herokuapp.com/ping

# Test Salt Service
curl -s https://zklogin-salt-service-545adc326c28.herokuapp.com/ping
```

## Important Notes

1. These services are running on Heroku's free tier, which may have limitations on usage.
2. The Salt Service uses Heroku's ephemeral filesystem, so data will be lost if the dyno restarts. For production, consider using a persistent database add-on.
3. All three services need to be operational for zkLogin to work correctly. 