#!/bin/bash

# Set environment variables
export PROVER_PORT=5001  # The port where the prover service will be accessible
export PROVER_FE_PORT=5003  # The port where the prover frontend service will be accessible
export SALT_PORT=5002    # The port where the salt service will be accessible
export ZKEY_PATH="$(pwd)/zkLogin.zkey"  # Path to the zkey file

# Check if the zkey file exists
if [ ! -f "$ZKEY_PATH" ]; then
  echo "zkLogin.zkey not found. Downloading from GitHub..."
  
  # For Testnet (uncomment the one you need)
  wget -O - https://raw.githubusercontent.com/sui-foundation/zklogin-ceremony-contributions/main/download-main-zkey.sh | bash
  
  # For Devnet (uncomment if you're using Devnet)
  # wget -O - https://raw.githubusercontent.com/sui-foundation/zklogin-ceremony-contributions/main/download-test-zkey.sh | bash
fi

# Make the local salt service script executable
chmod +x ./start-local-salt-service.sh

# Stop existing containers if they're running
echo "Stopping any existing zkLogin services..."
docker-compose down

# Start the Docker prover services
echo "Starting SUI Docker prover services..."
docker-compose up -d backend frontend

# Check if prover services are running
echo "Checking if prover services are running..."
docker ps | grep zklogin

# Stop any existing salt service on port 5002
echo "Stopping any existing salt service on port 5002..."
lsof -ti:5002 | xargs kill -9 2>/dev/null || true

# Start the local salt service in the background
echo "Starting local salt service..."
./start-local-salt-service.sh &

# Give the services a moment to start
sleep 2

echo "zkLogin services started:"
echo "- Prover backend service is available at http://localhost:${PROVER_PORT}"
echo "- Prover frontend service is available at http://localhost:${PROVER_FE_PORT}"
echo "- Local salt service is available at http://localhost:${SALT_PORT}"
echo "Note: You'll need to update your application to use these services." 