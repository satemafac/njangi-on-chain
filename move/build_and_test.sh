#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Building Njangi Circle with Cetus integration...${NC}"
sui move build

if [ $? -ne 0 ]; then
    echo -e "${RED}Build failed. Please fix the errors and try again.${NC}"
    exit 1
fi

echo -e "${GREEN}Build successful!${NC}"

# Prompt user to publish or test with locally published package
echo -e "${YELLOW}Do you want to publish the package to testnet? (y/n)${NC}"
read publish_response

if [[ "$publish_response" == "y" || "$publish_response" == "Y" ]]; then
    echo -e "${BLUE}Publishing to testnet...${NC}"
    RESULT=$(sui client publish --gas-budget 200000000)
    
    # Extract package ID from publish result using a macOS-compatible grep approach
    # First try the Created Objects pattern
    PACKAGE_ID=$(echo "$RESULT" | grep -o "Published Objects:.*" | grep -o "PackageID: [a-fA-F0-9]\{64\}" | grep -o "0x[a-fA-F0-9]\{64\}" | head -1)
    
    if [ -z "$PACKAGE_ID" ]; then
        PACKAGE_ID=$(echo "$RESULT" | grep -o "Immutable Objects:.*" | grep -o "0x[a-fA-F0-9]\{64\}" | head -1)
    fi
    
    if [ -z "$PACKAGE_ID" ]; then
        # Try the new format
        PACKAGE_ID=$(echo "$RESULT" | grep -o "PackageID: 0x[a-fA-F0-9]\{64\}" | grep -o "0x[a-fA-F0-9]\{64\}" | head -1)
    fi
    
    if [ -z "$PACKAGE_ID" ]; then
        echo -e "${RED}Failed to extract package ID from publish result.${NC}"
        echo -e "${YELLOW}Please check the full publish output:${NC}"
        echo "$RESULT"
        exit 1
    fi
    
    echo -e "${GREEN}Package published with ID: ${PACKAGE_ID}${NC}"
    
    # Update .env.local with the new package ID
    ENV_FILE="../.env.local"
    if [ -f "$ENV_FILE" ]; then
        echo -e "${BLUE}Updating .env.local with the new package ID...${NC}"
        # Use sed to replace the NEXT_PUBLIC_PACKAGE_ID line
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS requires an empty string for -i
            sed -i '' "s|^NEXT_PUBLIC_PACKAGE_ID=.*|NEXT_PUBLIC_PACKAGE_ID=${PACKAGE_ID}|" "$ENV_FILE"
        else
            # Linux version
            sed -i "s|^NEXT_PUBLIC_PACKAGE_ID=.*|NEXT_PUBLIC_PACKAGE_ID=${PACKAGE_ID}|" "$ENV_FILE"
        fi
        echo -e "${GREEN}Updated .env.local with package ID: ${PACKAGE_ID}${NC}"
    else
        echo -e "${YELLOW}Note: .env.local file not found. If you're using environment variables, manually update NEXT_PUBLIC_PACKAGE_ID to ${PACKAGE_ID}${NC}"
    fi
    
    # Prompt user to test deposit with swap
    echo -e "${YELLOW}Do you want to test a deposit with swap? (y/n)${NC}"
    read test_response
    
    if [[ "$test_response" == "y" || "$test_response" == "Y" ]]; then
        echo -e "${YELLOW}Enter your wallet ID:${NC}"
        read wallet_id
        
        echo -e "${YELLOW}Enter a SUI coin to use:${NC}"
        read sui_coin
        
        echo -e "${BLUE}Testing deposit with swap...${NC}"
        
        # Set up the correct Cetus testnet objects
        CETUS_GLOBAL_CONFIG="0x6f4149091a5aea0e818e7243a13adcfb403842d670b9a2089de058512620687a"
        CETUS_POOL="0x7cae71e021eb857516cb7af9c0e08e25f9335201c94ee209c50026dc52ef7972"
        
        # Use the exact USDC type for the Cetus pool
        USDC_TYPE="0x73656ea34d677b8f276b1720f33d45729d2a22603f4a0561401a99ccc7b81d15::usdc::USDC"
        
        echo -e "${GREEN}Using the following values:${NC}"
        echo -e "  Wallet: ${wallet_id}"
        echo -e "  SUI Coin: ${sui_coin}"
        echo -e "  Pool: ${CETUS_POOL}"
        echo -e "  Global Config: ${CETUS_GLOBAL_CONFIG}"
        echo -e "  USDC Type: ${USDC_TYPE}"
        
        sui client call --package "$PACKAGE_ID" --module "testnet_example" --function "deposit_and_swap" \
                        --args "$wallet_id" "$sui_coin" "$CETUS_POOL" "$CETUS_GLOBAL_CONFIG" "0x6" \
                        --type-args "$USDC_TYPE" \
                        --gas-budget 100000000
        
        if [ $? -ne 0 ]; then
            echo -e "${RED}Test failed.${NC}"
            exit 1
        fi
        
        echo -e "${GREEN}Test successful!${NC}"
    fi
else
    echo -e "${BLUE}Skipping publish.${NC}"
fi

echo -e "${GREEN}Done!${NC}" 