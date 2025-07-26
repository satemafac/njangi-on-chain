#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Function to display usage
display_usage() {
    echo -e "${CYAN}Njangi Contract Deployment Script${NC}"
    echo -e "${CYAN}==================================${NC}"
    echo ""
    echo -e "Usage: $0 <network> [options]"
    echo ""
    echo -e "Networks:"
    echo -e "  ${GREEN}testnet${NC}  - Deploy to testnet"
    echo -e "  ${GREEN}mainnet${NC}  - Deploy to mainnet"
    echo ""
    echo -e "Options:"
    echo -e "  --gas-budget <amount>  Set gas budget (default: 200000000)"
    echo -e "  --build-only          Only build, don't deploy"
    echo -e "  --debug               Enable debug mode"
    echo -e "  --help                Show this help"
    echo ""
    echo -e "Examples:"
    echo -e "  $0 testnet                           # Deploy to testnet"
    echo -e "  $0 mainnet --gas-budget 300000000   # Deploy to mainnet with custom gas"
    echo -e "  $0 mainnet --build-only              # Build for mainnet only"
}

# Function to check wallet balance
check_wallet_balance() {
    local network="$1"
    echo -e "${BLUE}🔍 Checking wallet balance on $network...${NC}"
    
    local gas_coins=$(sui client gas --json 2>/dev/null)
    if [[ $? -ne 0 ]] || [[ "$gas_coins" == "[]" ]] || [[ -z "$gas_coins" ]]; then
        echo -e "${RED}❌ No gas coins found in wallet${NC}"
        echo -e "${YELLOW}💰 Please fund your wallet:${NC}"
        local wallet_address=$(sui client active-address 2>/dev/null | grep -v warning)
        echo -e "   ${CYAN}Address: $wallet_address${NC}"
        if [[ "$network" == "mainnet" ]]; then
            echo -e "   ${CYAN}Recommended: 5-10 SUI for deployment${NC}"
        else
            echo -e "   ${CYAN}Get testnet SUI from: https://discord.com/invite/sui${NC}"
        fi
        return 1
    fi
    
    # Show gas balance summary
    local total_balance=$(echo "$gas_coins" | jq -r '[.data[].content.fields.balance | tonumber] | add')
    local sui_balance=$(echo "scale=2; $total_balance / 1000000000" | bc)
    echo -e "${GREEN}✅ Wallet balance: $sui_balance SUI${NC}"
    
    # Check if balance is sufficient
    if (( $(echo "$total_balance < 100000000" | bc -l) )); then
        echo -e "${YELLOW}⚠️  Warning: Low balance. Minimum 0.1 SUI recommended${NC}"
    fi
    
    return 0
}

# Default values
NETWORK=""
GAS_BUDGET="200000000"
BUILD_ONLY=false
DEBUG_MODE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        testnet|mainnet)
            NETWORK="$1"
            shift
            ;;
        --gas-budget)
            GAS_BUDGET="$2"
            if [[ ! "$GAS_BUDGET" =~ ^[0-9]+$ ]]; then
                echo -e "${RED}❌ Invalid gas budget: $GAS_BUDGET${NC}"
                exit 1
            fi
            shift 2
            ;;
        --build-only)
            BUILD_ONLY=true
            shift
            ;;
        --debug)
            DEBUG_MODE=true
            shift
            ;;
        --help)
            display_usage
            exit 0
            ;;
        *)
            echo -e "${RED}❌ Unknown argument: $1${NC}"
            display_usage
            exit 1
            ;;
    esac
done

# Validate network is specified
if [[ -z "$NETWORK" ]]; then
    echo -e "${RED}❌ Network must be specified${NC}"
    echo ""
    display_usage
    exit 1
fi

echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}   Njangi Contract Deployment to $NETWORK${NC}" 
echo -e "${BLUE}============================================${NC}"

# Switch to target network
echo -e "${BLUE}🔄 Switching to $NETWORK configuration...${NC}"
if [[ -f "./scripts/switch-network.sh" ]]; then
    ./scripts/switch-network.sh "$NETWORK"
    if [[ $? -ne 0 ]]; then
        echo -e "${RED}❌ Failed to switch to $NETWORK${NC}"
        exit 1
    fi
else
    echo -e "${RED}❌ Network switching script not found${NC}"
    exit 1
fi

# Build contracts
echo -e "${BLUE}🔨 Building contracts...${NC}"
BUILD_CMD="./build_and_test.sh --build-only"
if [[ "$DEBUG_MODE" == "true" ]]; then
    BUILD_CMD="$BUILD_CMD --debug-publish"
fi

$BUILD_CMD
if [[ $? -ne 0 ]]; then
    echo -e "${RED}❌ Build failed${NC}"
    exit 1
fi

# Exit if build-only
if [[ "$BUILD_ONLY" == "true" ]]; then
    echo -e "${GREEN}✅ Build completed successfully for $NETWORK${NC}"
    exit 0
fi

# Check wallet balance
check_wallet_balance "$NETWORK"
if [[ $? -ne 0 ]]; then
    echo -e "${YELLOW}💡 Fund your wallet and run this script again${NC}"
    exit 1
fi

# Confirm deployment
echo ""
echo -e "${YELLOW}🚀 Ready to deploy to $NETWORK${NC}"
echo -e "${CYAN}   Gas Budget: $GAS_BUDGET${NC}"
echo -e "${CYAN}   Network: $NETWORK${NC}"
echo ""
echo -e "${YELLOW}Do you want to proceed with deployment? (y/N)${NC}"
read -r response

if [[ "$response" != "y" && "$response" != "Y" ]]; then
    echo -e "${BLUE}❌ Deployment cancelled${NC}"
    exit 0
fi

# Deploy contracts
echo -e "${BLUE}🚀 Deploying contracts to $NETWORK...${NC}"

PUBLISH_CMD="sui client publish --gas-budget $GAS_BUDGET"
if [[ "$DEBUG_MODE" == "true" ]]; then
    PUBLISH_CMD="$PUBLISH_CMD --dump --verbose"
fi

echo -e "${CYAN}Running: $PUBLISH_CMD${NC}"
PUBLISH_OUTPUT=$($PUBLISH_CMD 2>&1)
PUBLISH_STATUS=$?

if [[ $PUBLISH_STATUS -eq 0 ]]; then
    echo -e "${GREEN}✅ Deployment successful!${NC}"
    
    # Extract package ID
    PACKAGE_ID=$(echo "$PUBLISH_OUTPUT" | grep -o "PackageID: 0x[a-fA-F0-9]\{64\}" | grep -o "0x[a-fA-F0-9]\{64\}" | head -1)
    
    if [[ -z "$PACKAGE_ID" ]]; then
        PACKAGE_ID=$(echo "$PUBLISH_OUTPUT" | grep -o "Published Objects:.*" | grep -o "ID: 0x[a-fA-F0-9]\{40\}" | grep -o "0x[a-fA-F0-9]\{40\}" | head -1)
    fi
    
    if [[ -n "$PACKAGE_ID" ]]; then
        echo -e "${GREEN}📦 Package ID: $PACKAGE_ID${NC}"
        
        # Update .env file
        ENV_FILE="../.env.local"
        if [[ "$NETWORK" == "mainnet" ]]; then
            ENV_VAR="NEXT_PUBLIC_MAINNET_PACKAGE_ID"
        else
            ENV_VAR="NEXT_PUBLIC_PACKAGE_ID"
        fi
        
        if [[ -f "$ENV_FILE" ]]; then
            if grep -q "^$ENV_VAR=" "$ENV_FILE"; then
                if [[ "$OSTYPE" == "darwin"* ]]; then
                    sed -i '' "s|^$ENV_VAR=.*|$ENV_VAR=$PACKAGE_ID|" "$ENV_FILE"
                else
                    sed -i "s|^$ENV_VAR=.*|$ENV_VAR=$PACKAGE_ID|" "$ENV_FILE"
                fi
            else
                echo "$ENV_VAR=$PACKAGE_ID" >> "$ENV_FILE"
            fi
            echo -e "${GREEN}✅ Updated $ENV_FILE with $ENV_VAR${NC}"
        else
            echo -e "${YELLOW}⚠️  Creating new .env.local file${NC}"
            echo "$ENV_VAR=$PACKAGE_ID" > "$ENV_FILE"
        fi
        
        echo ""
        echo -e "${BLUE}🎉 Deployment Summary${NC}"
        echo -e "${BLUE}====================${NC}"
        echo -e "${CYAN}Network: $NETWORK${NC}"
        echo -e "${CYAN}Package ID: $PACKAGE_ID${NC}"
        echo -e "${CYAN}Environment Variable: $ENV_VAR${NC}"
        
    else
        echo -e "${YELLOW}⚠️  Could not extract package ID from output${NC}"
        echo -e "${BLUE}Full output:${NC}"
        echo "$PUBLISH_OUTPUT"
    fi
    
else
    echo -e "${RED}❌ Deployment failed${NC}"
    echo -e "${BLUE}Error output:${NC}"
    echo "$PUBLISH_OUTPUT"
    exit 1
fi 