# zkLogin Services on Heroku

## Final Working Services (Recommended)

The following zkLogin services have been thoroughly fixed to work properly on Heroku:

1. **Backend zkLogin Prover**: 
   - URL: https://zklogin-backend-fix3-46730ab9ae9f.herokuapp.com
   - Input endpoint: https://zklogin-backend-fix3-46730ab9ae9f.herokuapp.com/input
   - Runs on Standard-2X dyno due to memory requirements (~650MB)
   - ✅ Status: Working properly (May 5, 2025)

2. **Frontend zkLogin Service**: 
   - URL: https://zklogin-frontend-fix3-e9578d3d8fdb.herokuapp.com
   - Properly connects to the working backend service
   - ✅ Status: Working properly (May 5, 2025)

3. **Salt Service**: 
   - URL: https://zklogin-salt-service-545adc326c28.herokuapp.com
   - Endpoint: https://zklogin-salt-service-545adc326c28.herokuapp.com/get-salt
   - ✅ Status: Working properly (May 5, 2025)

## Previous Attempts (Not Recommended)

The following services were part of the troubleshooting process:

1. Backend zkLogin Prover: 
   - Original: https://zklogin-backend-service-ba736adc0eb8.herokuapp.com (script path error)
   - First Fix: https://zklogin-backend-fixed-27dc1427ea95.herokuapp.com (permission issues)
   - Second Fix: https://zklogin-backend-fix2-bb2e650e6a35.herokuapp.com (port binding issue)
   - **Final Fix**: https://zklogin-backend-fix3-46730ab9ae9f.herokuapp.com (working)

2. Frontend zkLogin Service: 
   - Original: https://zklogin-frontend-service-f74353d605f9.herokuapp.com (wrong script path)
   - First Fix: https://zklogin-frontend-fixed-24f074a5a154.herokuapp.com (socket addressing error)
   - Second Fix: https://zklogin-frontend-fix2-e730d02f4096.herokuapp.com (still had addressing issues)
   - **Final Fix**: https://zklogin-frontend-fix3-e9578d3d8fdb.herokuapp.com (working)

## How to Use in Your Application

### Option 1: Direct Configuration

Add the following environment variables to your application:

```env
# zkLogin Services Configuration
PROVER_URI=https://zklogin-backend-fix3-46730ab9ae9f.herokuapp.com/input
PROVER_FRONTEND_URL=https://zklogin-frontend-fix3-e9578d3d8fdb.herokuapp.com
SALT_SERVICE_URL=https://zklogin-salt-service-545adc326c28.herokuapp.com
```

### Option 2: Using the zkLogin Service Switcher (Recommended)

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

This approach makes it easy to develop locally and then switch to Heroku services for production or testing.

### Managing the Heroku Services

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

## Troubleshooting

If you encounter issues with the zkLogin services:

1. **Services might be sleeping**: Heroku free tier services go to sleep after 30 minutes of inactivity. Make a request to wake them up:
   ```
   curl https://zklogin-backend-fix3-46730ab9ae9f.herokuapp.com/input -X POST
   curl https://zklogin-frontend-fix3-e9578d3d8fdb.herokuapp.com
   curl https://zklogin-salt-service-545adc326c28.herokuapp.com/get-salt
   ```

2. **Check logs**: If a service is unresponsive, check the Heroku logs:
   ```
   heroku logs --tail --app zklogin-backend-fix3
   heroku logs --tail --app zklogin-frontend-fix3
   heroku logs --tail --app zklogin-salt-service
   ```

3. **Restart services**: If needed, restart the services:
   ```
   heroku restart --app zklogin-backend-fix3
   heroku restart --app zklogin-frontend-fix3
   heroku restart --app zklogin-salt-service
   ```

## Technical Details

The services have been fixed to handle several Heroku-specific challenges:

1. **Backend Service**:
   - Uses socat to forward from Heroku's dynamic PORT to the fixed port 8080 expected by proverServer
   - Properly initializes with environment variables ZKEY and WITNESS_BINARIES
   - File system search is restricted to `/app` to avoid permission issues
   - Requires a Standard-2X dyno due to high memory usage (~650MB)
   - Accepts POST requests to /input endpoint with JSON payloads

2. **Frontend Service**:
   - Fixed socket addressing issues by using socat port forwarding.
   - Replaced original `run.prover-fe.sh` to ensure server starts on PORT 8080.
   - Wrapper script uses socat to forward Heroku PORT to internal 8080.
   - Properly connects to the working backend service.

3. **Salt Service**:
   - Operates on standard SQLite database
   - Can run on a free dyno as it has lower memory requirements

## Scaling Considerations

1. **Backend Service**: This service is memory-intensive as it needs to load the large zkLogin zkey file into memory.
   - It's currently running on a Standard-2X dyno ($50/month)
   - If this becomes cost-prohibitive, consider:
     - Implementing a queue system to limit concurrent proving requests
     - Using a microservice architecture where multiple smaller provers share the load

2. **Frontend & Salt Services**: These are less resource-intensive and can run on free or hobby dynos. 