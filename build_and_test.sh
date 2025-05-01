#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

SOURCE_DIR="./sources"

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to display usage
display_usage() {
    echo -e "${CYAN}Usage: $0 [--build-only]${NC}"
    echo -e "Options:"
    echo -e "  --build-only    Only build the modules, skip publishing and testing"
    echo -e "  --help          Display this help message"
}

# Parse command line arguments
BUILD_ONLY=false
for arg in "$@"; do
    case $arg in
        --build-only)
            BUILD_ONLY=true
            ;;
        --help)
            display_usage
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $arg${NC}"
            display_usage
            exit 1
            ;;
    esac
done

# Check if Sui CLI is installed
if ! command_exists sui; then
    echo -e "${RED}Error: Sui CLI is not installed or not in PATH.${NC}"
    echo -e "Please install Sui CLI by following instructions at: https://docs.sui.io/build/install"
    exit 1
fi

# Display header
echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}   Njangi Circle Contract Build Script     ${NC}"
echo -e "${BLUE}============================================${NC}"

# List all Move files in the sources directory
echo -e "${CYAN}Modules to be built:${NC}"
for file in $SOURCE_DIR/*.move; do
    if [[ -f "$file" ]]; then
        base_name=$(basename "$file")
        echo -e "  ${YELLOW}${base_name}${NC}"
    fi
done
echo -e "${BLUE}============================================${NC}"

# Check if we should build specific modules
echo -e "${YELLOW}Build all modules or specific ones? (all/specific)${NC}"
read build_choice

if [[ "$build_choice" == "specific" ]]; then
    echo -e "${YELLOW}Enter module names separated by space (e.g. njangi_core njangi_circles):${NC}"
    read -a module_names
    
    # Check if specified modules exist
    for module in "${module_names[@]}"; do
        if [[ ! -f "$SOURCE_DIR/${module}.move" ]]; then
            echo -e "${RED}Error: Module '${module}.move' not found in $SOURCE_DIR${NC}"
            exit 1
        fi
    done
    
    echo -e "${BLUE}Building specific modules: ${module_names[@]}...${NC}"
    # Note: sui move build always builds all modules, but we're acknowledging user selection
else
    echo -e "${BLUE}Building all modules...${NC}"
fi

# Build the modules
echo -e "${BLUE}Running sui move build...${NC}"
sui move build

# Check build result
if [ $? -ne 0 ]; then
    echo -e "${RED}Build failed. Please fix the errors and try again.${NC}"
    exit 1
fi

echo -e "${GREEN}Build successful!${NC}"

# Check if we should skip publishing
if [ "$BUILD_ONLY" = true ]; then
    echo -e "${YELLOW}Skipping publish and test steps (--build-only flag used).${NC}"
    echo -e "${GREEN}Build process completed successfully!${NC}" 
    echo -e "${BLUE}============================================${NC}"
    exit 0
fi

# Display active address and gas balance
echo -e "${BLUE}Getting active address and gas balance...${NC}"
ACTIVE_ADDRESS=$(sui client active-address | awk '{print $NF}')
echo -e "${CYAN}Active address: ${ACTIVE_ADDRESS}${NC}"

# Note about gas requirements
echo -e "${YELLOW}Note: The Njangi contract requires higher gas due to its size and complexity${NC}"
echo -e "${YELLOW}For publishing: at least 500M MIST (0.5 SUI) is recommended${NC}"
echo -e "${YELLOW}For function calls: at least 200M MIST (0.2 SUI) is recommended${NC}"
echo

# Get gas objects for the active address
echo -e "${BLUE}Checking gas objects for this address...${NC}"
sui client gas --json | jq '.data[] | {id: .id.id, gas_value: .content.fields.balance}'

echo -e "${YELLOW}Please ensure the above address has sufficient gas for publishing.${NC}"
echo -e "${YELLOW}If gas is insufficient, run: sui client gas --address ${ACTIVE_ADDRESS}${NC}"

# Prompt user to verify the build and publish
echo -e "${YELLOW}Do you want to publish the package to testnet? (y/n)${NC}"
read publish_response

if [[ "$publish_response" == "y" || "$publish_response" == "Y" ]]; then
    # Ask for gas budget
    echo -e "${YELLOW}Enter gas budget for publishing (default: 500000000):${NC}"
    read gas_budget
    
    # Set default if empty - using higher gas budget (500M) due to contract size and complexity
    gas_budget=${gas_budget:-500000000}
    
    # Ask for specific gas coin ID
    echo -e "${YELLOW}Enter gas coin ID to use (leave empty for default):${NC}"
    read gas_coin_id
    
    # Set up publish command with or without debug flags
    PUBLISH_CMD="sui client publish"
    
    if [ "$DEBUG_PUBLISH" = true ]; then
        echo -e "${BLUE}Publishing with debug flags enabled...${NC}"
        PUBLISH_CMD="$PUBLISH_CMD --dump --verbose"
    else
        echo -e "${BLUE}Publishing to testnet with gas budget: ${gas_budget}...${NC}"
    fi
    
    # Add gas coin if specified
    if [ ! -z "$gas_coin_id" ]; then
        PUBLISH_CMD="$PUBLISH_CMD --gas-object $gas_coin_id"
        echo -e "${BLUE}Using gas object: ${gas_coin_id}${NC}"
    fi
    
    PUBLISH_CMD="$PUBLISH_CMD --gas-budget $gas_budget"
    
    # Capture both stdout and stderr
    PUBLISH_OUTPUT=$(eval $PUBLISH_CMD 2>&1)
    PUBLISH_STATUS=$?
    
    # Check if publish command succeeded
    if [ $PUBLISH_STATUS -ne 0 ]; then
        echo -e "${RED}Publish command failed. Error:${NC}"
        
        # Look for specific error patterns
        if echo "$PUBLISH_OUTPUT" | grep -q "VMVerificationOrDeserialization"; then
            echo -e "${YELLOW}This appears to be a verification error. Common causes:${NC}"
            echo -e "1. Type parameter issues"
            echo -e "2. Incompatible function signatures"
            echo -e "3. Incorrect module dependencies"
            echo -e "4. Code using features not supported by the current Sui version"
        fi
        
        # Print full error output for debugging
        echo -e "${RED}Full error output:${NC}"
        echo "$PUBLISH_OUTPUT"
        
        echo -e "${YELLOW}Would you like to continue with testing using a previously published package? (y/n)${NC}"
        read continue_testing
        
        if [[ "$continue_testing" != "y" && "$continue_testing" != "Y" ]]; then
            echo -e "${RED}Exiting.${NC}"
            exit 1
        else
            echo -e "${YELLOW}Enter the package ID of your previously published package:${NC}"
            read PACKAGE_ID
            
            if [[ ! "$PACKAGE_ID" =~ ^0x[a-fA-F0-9]+$ ]]; then
                echo -e "${RED}Invalid package ID format. Exiting.${NC}"
                exit 1
            fi
        fi
    else
        # Extract package ID from publish result
        PACKAGE_ID=$(echo "$PUBLISH_OUTPUT" | grep -o "PackageID: 0x[a-fA-F0-9]\{64\}" | grep -o "0x[a-fA-F0-9]\{64\}" | head -1)
        
        if [ -z "$PACKAGE_ID" ]; then
            # Try alternative formats
            PACKAGE_ID=$(echo "$PUBLISH_OUTPUT" | grep -o "Published Objects:.*" | grep -o "ID: 0x[a-fA-F0-9]\{40\}" | grep -o "0x[a-fA-F0-9]\{40\}" | head -1)
        fi
        
        if [ -z "$PACKAGE_ID" ]; then
            PACKAGE_ID=$(echo "$PUBLISH_OUTPUT" | grep -o "Immutable Objects:.*" | grep -o "0x[a-fA-F0-9]\{64\}" | head -1)
        fi
        
        if [ -z "$PACKAGE_ID" ]; then
            echo -e "${RED}Failed to extract package ID from publish result.${NC}"
            echo -e "${YELLOW}Please check the full publish output:${NC}"
            echo "$PUBLISH_OUTPUT"
            
            echo -e "${YELLOW}Enter the package ID manually:${NC}"
            read PACKAGE_ID
            
            if [[ ! "$PACKAGE_ID" =~ ^0x[a-fA-F0-9]+$ ]]; then
                echo -e "${RED}Invalid package ID format. Exiting.${NC}"
                exit 1
            fi
        } else {
            echo -e "${GREEN}✅ Package published with ID: ${PACKAGE_ID}${NC}"
        }
        fi
    fi
    
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
        echo -e "${GREEN}✅ Updated .env.local with package ID: ${PACKAGE_ID}${NC}"
    else
        echo -e "${YELLOW}Note: .env.local file not found. If you're using environment variables, manually update NEXT_PUBLIC_PACKAGE_ID to ${PACKAGE_ID}${NC}"
        
        # Create a new .env.local file
        echo -e "${YELLOW}Would you like to create a new .env.local file? (y/n)${NC}"
        read create_env
        
        if [[ "$create_env" == "y" || "$create_env" == "Y" ]]; then
            echo "NEXT_PUBLIC_PACKAGE_ID=${PACKAGE_ID}" > "$ENV_FILE"
            echo -e "${GREEN}✅ Created new .env.local file with package ID${NC}"
        fi
    fi
    
    # Prompt user to test one of the module's functions
    echo -e "${YELLOW}Do you want to test a function from the published modules? (y/n)${NC}"
    read test_response
    
    if [[ "$test_response" == "y" || "$test_response" == "Y" ]]; then
        # Display available test options
        echo -e "${CYAN}Available test options:${NC}"
        echo -e "  1. Test deposit with swap"
        echo -e "  2. Test create circle"
        echo -e "  3. Test custom function"
        
        echo -e "${YELLOW}Enter your choice (1-3):${NC}"
        read test_choice
        
        case $test_choice in
            1)
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
                                --gas-budget 200000000
                ;;
            2)
                echo -e "${BLUE}Testing create circle function...${NC}"
                echo -e "${YELLOW}Enter circle name:${NC}"
                read circle_name
                
                # Convert name to bytes
                NAME_BYTES=$(echo -n "$circle_name" | xxd -p | tr -d '\n')
                
                sui client call --package "$PACKAGE_ID" --module "njangi_circles" --function "create_circle" \
                                --args "0x$NAME_BYTES" "100" "10000" "50" "5000" "0" "1" "0" "5" "0" \
                                "true true" "none" "none" "none" "none" "false" "0x6" \
                                --gas-budget 200000000
                ;;
            3)
                echo -e "${YELLOW}Enter module name:${NC}"
                read module_name
                
                echo -e "${YELLOW}Enter function name:${NC}"
                read function_name
                
                echo -e "${YELLOW}Enter arguments (space-separated, use quotes for strings):${NC}"
                read -a arguments
                
                echo -e "${BLUE}Testing custom function ${module_name}::${function_name}...${NC}"
                
                # Convert arguments array to space-separated string
                args_string="${arguments[*]}"
                
                sui client call --package "$PACKAGE_ID" --module "$module_name" --function "$function_name" \
                                --args $args_string \
                                --gas-budget 200000000
                ;;
            *)
                echo -e "${RED}Invalid choice. Skipping test.${NC}"
                ;;
        esac
        
        if [ $? -ne 0 ]; then
            echo -e "${RED}Test failed.${NC}"
            echo -e "${YELLOW}This could be due to:${NC}"
            echo -e "1. Invalid arguments"
            echo -e "2. Function not being public or not existing"
            echo -e "3. Insufficient gas"
            echo -e "4. Network issues"
        else
            echo -e "${GREEN}Test completed!${NC}"
        fi
    fi
else
    echo -e "${BLUE}Skipping publish.${NC}"
fi

echo -e "${GREEN}Build process completed successfully!${NC}" 
echo -e "${BLUE}============================================${NC}" 