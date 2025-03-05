#!/bin/bash

# Set environment variables
export PORT=5002
export SALT_DB_PATH="./salt-database.db"
export ENCRYPTION_KEY_PATH="./.encryption-key"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
  echo "Node.js is not installed. Please install Node.js to run the salt service."
  exit 1
fi

# Check if the salt service file exists
if [ ! -f "./src/services/salt-service.ts" ]; then
  echo "salt-service.ts not found in src/services directory."
  exit 1
fi

# Install ts-node if not already installed
if ! command -v ts-node &> /dev/null; then
  echo "Installing ts-node..."
  npm install -g ts-node
fi

# Start the salt service
echo "Starting local salt service on port $PORT..."
ts-node ./src/services/salt-service.ts

# If you prefer to use node directly with TypeScript compilation:
# echo "Compiling TypeScript..."
# npx tsc ./src/services/salt-service.ts --outDir ./dist
# echo "Starting local salt service on port $PORT..."
# node ./dist/services/salt-service.js 