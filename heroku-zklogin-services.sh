#!/bin/bash

# URLs for the deployed services
BACKEND_URL="https://zklogin-backend-fix3-46730ab9ae9f.herokuapp.com"
FRONTEND_URL="https://zklogin-frontend-fix3-e9578d3d8fdb.herokuapp.com"
SALT_URL="https://zklogin-salt-service-545adc326c28.herokuapp.com"

# Heroku app names
BACKEND_APP="zklogin-backend-fix3"
FRONTEND_APP="zklogin-frontend-fix3"
SALT_APP="zklogin-salt-service"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Curl timeout in seconds
CURL_TIMEOUT=5

# Check if a service is running (with shorter timeout)
check_service() {
  local url=$1
  local name=$2
  local timeout=${3:-$CURL_TIMEOUT}
  
  echo -e "${YELLOW}Checking $name at $url...${NC}"
  
  # Try ping endpoint first with timeout
  if curl -s --head --max-time $timeout "$url/ping" 2>/dev/null | grep "200 OK" > /dev/null; then
    echo -e "${GREEN}✓ $name is running (ping endpoint)${NC}"
    return 0
  # If ping fails, try root endpoint
  elif curl -s --head --max-time $timeout "$url" 2>/dev/null | grep "200 OK" > /dev/null; then
    echo -e "${GREEN}✓ $name is running (root endpoint)${NC}"
    return 0
  else
    echo -e "${RED}✗ $name is not responding (may be sleeping)${NC}"
    return 1
  fi
}

# Wake up a service
wake_service() {
  local url=$1
  local name=$2
  
  echo -e "${YELLOW}Attempting to wake up $name...${NC}"
  
  # Make a request to the service to wake it up
  curl -s --max-time 10 "$url" > /dev/null
  
  # Give it some time to start
  echo -e "${YELLOW}Waiting for service to start...${NC}"
  sleep 5
  
  # Check if it's now responsive
  if curl -s --head --max-time 10 "$url" 2>/dev/null | grep "200 OK" > /dev/null; then
    echo -e "${GREEN}✓ $name is now awake${NC}"
    return 0
  else
    echo -e "${RED}✗ $name is still not responding${NC}"
    return 1
  fi
}

# Restart a service
restart_service() {
  local app_name=$1
  local service_name=$2
  
  echo -e "${YELLOW}Restarting $service_name...${NC}"
  heroku restart --app $app_name
  
  # Wait for restart to complete
  echo -e "${YELLOW}Waiting for restart to complete...${NC}"
  sleep 5
}

# Configure local environment to use remote services
configure_env() {
  cat > .env.zklogin << EOF
# Heroku zkLogin Services Configuration
PROVER_URI=${BACKEND_URL}/input
PROVER_FRONTEND_URL=${FRONTEND_URL}
SALT_SERVICE_URL=${SALT_URL}
EOF

  echo -e "${GREEN}Created .env.zklogin with remote service URLs${NC}"
  echo -e "Use 'source .env.zklogin' to load these into your environment"
}

# Main logic
if [ "$1" == "check" ] || [ "$1" == "" ]; then
  echo -e "${YELLOW}Checking all zkLogin services...${NC}"
  check_service "$BACKEND_URL" "Backend zkLogin Prover"
  check_service "$FRONTEND_URL" "Frontend zkLogin Service"
  check_service "$SALT_URL" "Salt Service"
  echo -e "${YELLOW}Note: If services are not responding, they may be sleeping. Use 'wake' command to wake them up.${NC}"
  
elif [ "$1" == "wake" ]; then
  echo -e "${YELLOW}Waking up all zkLogin services...${NC}"
  wake_service "$BACKEND_URL" "Backend zkLogin Prover"
  wake_service "$FRONTEND_URL" "Frontend zkLogin Service"
  wake_service "$SALT_URL" "Salt Service"
  
elif [ "$1" == "restart" ]; then
  echo -e "${YELLOW}Restarting all zkLogin services...${NC}"
  restart_service $BACKEND_APP "Backend zkLogin Prover"
  restart_service $FRONTEND_APP "Frontend zkLogin Service"
  restart_service $SALT_APP "Salt Service"
  
elif [ "$1" == "config" ]; then
  configure_env
  
else
  echo "Usage: $0 [check|wake|restart|config]"
  echo "  check   - Check if all services are running (default)"
  echo "  wake    - Attempt to wake up sleeping services"
  echo "  restart - Restart all services on Heroku"
  echo "  config  - Create an .env.zklogin file with remote service URLs"
  exit 1
fi 