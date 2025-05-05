#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Local service configuration
LOCAL_PROVER_URI="http://localhost:5001/input"
LOCAL_PROVER_FRONTEND_URL="http://localhost:5003"
LOCAL_SALT_SERVICE_URL="http://localhost:5002"

# Heroku service configuration
HEROKU_PROVER_URI="https://zklogin-backend-fix3-46730ab9ae9f.herokuapp.com/input"
HEROKU_PROVER_FRONTEND_URL="https://zklogin-frontend-fix3-e9578d3d8fdb.herokuapp.com"
HEROKU_SALT_SERVICE_URL="https://zklogin-salt-service-545adc326c28.herokuapp.com"

# Creates a .env.zklogin.local file with local service URLs
create_local_env() {
  cat > .env.zklogin.local << EOF
# Local zkLogin Services Configuration
PROVER_URI=${LOCAL_PROVER_URI}
PROVER_FRONTEND_URL=${LOCAL_PROVER_FRONTEND_URL}
SALT_SERVICE_URL=${LOCAL_SALT_SERVICE_URL}

# Local service ports for reference
PROVER_PORT=5001
PROVER_FE_PORT=5003
SALT_PORT=5002
EOF

  echo -e "${GREEN}Created .env.zklogin.local with local service URLs${NC}"
}

# Creates a .env.zklogin.heroku file with Heroku service URLs
create_heroku_env() {
  cat > .env.zklogin.heroku << EOF
# Heroku zkLogin Services Configuration
PROVER_URI=${HEROKU_PROVER_URI}
PROVER_FRONTEND_URL=${HEROKU_PROVER_FRONTEND_URL}
SALT_SERVICE_URL=${HEROKU_SALT_SERVICE_URL}
EOF

  echo -e "${GREEN}Created .env.zklogin.heroku with Heroku service URLs${NC}"
}

# Creates the main .env.zklogin file that points to the active configuration
create_main_env() {
  local mode=$1
  
  if [[ "$mode" == "local" ]]; then
    cp .env.zklogin.local .env.zklogin
    echo -e "${GREEN}Switched to LOCAL zkLogin services${NC}"
  elif [[ "$mode" == "heroku" ]]; then
    cp .env.zklogin.heroku .env.zklogin
    echo -e "${GREEN}Switched to HEROKU zkLogin services${NC}"
  else
    echo -e "${RED}Invalid mode specified: $mode${NC}"
    exit 1
  fi
  
  echo -e "${YELLOW}To activate in your shell, run:${NC}"
  echo -e "${BLUE}source .env.zklogin${NC}"
}

# Check if existing local services are running
check_local_services() {
  echo -e "${YELLOW}Checking local zkLogin services...${NC}"
  
  local all_running=true
  
  # Check prover backend
  if curl -s --head --max-time 2 "${LOCAL_PROVER_URI}" > /dev/null; then
    echo -e "${GREEN}✓ Local prover backend is running${NC}"
  else
    echo -e "${RED}✗ Local prover backend is not running${NC}"
    all_running=false
  fi
  
  # Check prover frontend
  if curl -s --head --max-time 2 "${LOCAL_PROVER_FRONTEND_URL}" > /dev/null; then
    echo -e "${GREEN}✓ Local prover frontend is running${NC}"
  else
    echo -e "${RED}✗ Local prover frontend is not running${NC}"
    all_running=false
  fi
  
  # Check salt service
  if curl -s --head --max-time 2 "${LOCAL_SALT_SERVICE_URL}" > /dev/null; then
    echo -e "${GREEN}✓ Local salt service is running${NC}"
  else
    echo -e "${RED}✗ Local salt service is not running${NC}"
    all_running=false
  fi
  
  if [[ "$all_running" == false ]]; then
    echo -e "${YELLOW}Note: Some local services are not running. You can start them with:${NC}"
    echo -e "${BLUE}./start-zklogin-services.sh${NC}"
  fi
}

# Print current configuration
print_current_config() {
  if [[ -f .env.zklogin ]]; then
    echo -e "${YELLOW}Current zkLogin Configuration:${NC}"
    cat .env.zklogin | grep -v "^#" | sed 's/^/  /'
    echo ""
  else
    echo -e "${YELLOW}No active zkLogin configuration found.${NC}"
  fi
}

# Main functionality
case "$1" in
  local)
    create_local_env
    create_main_env "local"
    check_local_services
    ;;
  heroku)
    create_heroku_env
    create_main_env "heroku"
    ./heroku-zklogin-services.sh check
    ;;
  status)
    print_current_config
    ;;
  *)
    echo "Usage: $0 [local|heroku|status]"
    echo "  local  - Switch to local zkLogin services"
    echo "  heroku - Switch to Heroku zkLogin services"
    echo "  status - Show current zkLogin configuration"
    exit 1
    ;;
esac 