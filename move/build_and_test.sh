#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

SOURCE_DIR="./sources"
SUIUP_BIN="$HOME/.local/bin/sui"

# Prefer the suiup-managed CLI over older cargo-installed copies.
if [[ -x "$SUIUP_BIN" ]]; then
    export PATH="$HOME/.local/bin:$PATH"
fi

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

supports_move_skip_fetch_latest_git_deps() {
    sui move build --help 2>/dev/null | grep -q -- '--skip-fetch-latest-git-deps'
}

supports_publish_skip_fetch_latest_git_deps() {
    sui client publish --help 2>/dev/null | grep -q -- '--skip-fetch-latest-git-deps'
}

get_move_network() {
    if grep -q "Current configuration: MAINNET" Move.toml; then
        echo "mainnet"
    elif grep -q "Current configuration: TESTNET" Move.toml; then
        echo "testnet"
    else
        echo "unknown"
    fi
}

get_sui_env() {
    sui client active-env 2>/dev/null | grep -v warning | tr -d '[:space:]'
}

ensure_network_consistency() {
    local move_network
    move_network=$(get_move_network)
    local sui_env
    sui_env=$(get_sui_env)

    if [[ -z "$sui_env" || "$move_network" == "unknown" ]]; then
        echo -e "${YELLOW}Unable to confirm Move/Sui network alignment. Proceeding without the consistency guard.${NC}"
        return 0
    fi

    if [[ "$move_network" != "$sui_env" ]]; then
        echo -e "${RED}Network mismatch detected.${NC}"
        echo -e "${YELLOW}Move.toml is configured for: ${move_network}${NC}"
        echo -e "${YELLOW}Sui CLI active env is: ${sui_env}${NC}"
        echo -e "${CYAN}Fix one side before building/publishing:${NC}"
        echo -e "  cd move && ./scripts/switch-network.sh ${sui_env}"
        echo -e "  or"
        echo -e "  sui client switch --env ${move_network}"
        return 1
    fi

    return 0
}

extract_published_metadata_value() {
    local network="$1"
    local key="$2"
    local published_file="Published.toml"

    if [ ! -f "$published_file" ]; then
        return 0
    fi

    awk -v section="[published.${network}]" -v key="$key" '
        $0 == section { in_section = 1; next }
        in_section && /^\[/ { in_section = 0 }
        in_section && $1 == key {
            gsub(/"/, "", $3)
            print $3
            exit
        }
    ' "$published_file"
}

update_circle_chain_lineage() {
    local network="$1"
    local package_id="$2"
    local lineage_file="../src/lib/circle-chain.ts"

    if [[ "$network" != "testnet" && "$network" != "mainnet" ]]; then
        echo -e "${YELLOW}Skipping circle-chain.ts sync because the active Sui env is unknown.${NC}"
        return 0
    fi

    if [ ! -f "$lineage_file" ]; then
        echo -e "${YELLOW}Note: ${lineage_file} not found. Skipping package lineage sync.${NC}"
        return 0
    fi

    local published_at
    local original_id
    published_at=$(extract_published_metadata_value "$network" "published-at")
    original_id=$(extract_published_metadata_value "$network" "original-id")

    published_at=${published_at:-$package_id}
    original_id=${original_id:-$package_id}

    perl -0pi -e "s/(\\b${network}: \\{\\n\\s+publishedAt: ')[^']+(',\\n\\s+originalId: ')[^']+(',\\n\\s+\\},)/\$1${published_at}\$2${original_id}\$3/s" "$lineage_file"

    if grep -A3 "  ${network}: {" "$lineage_file" | grep -q "$published_at"; then
        echo -e "${GREEN}✅ Updated src/lib/circle-chain.ts ${network} lineage: publishedAt=${published_at}, originalId=${original_id}${NC}"
    else
        echo -e "${YELLOW}Warning: attempted to sync src/lib/circle-chain.ts for ${network}, but could not verify the update.${NC}"
    fi
}

# Function to display usage
display_usage() {
    echo -e "${CYAN}Usage: $0 [--build-only] [--debug-publish] [--network=<network>]${NC}"
    echo -e "Options:"
    echo -e "  --build-only     Only build the modules, skip publishing and testing"
    echo -e "  --debug-publish  Use additional debug flags during publishing"
    echo -e "  --network=<net>  Switch to testnet or mainnet before building (testnet|mainnet)"
    echo -e "  --help           Display this help message"
    echo -e ""
    echo -e "Examples:"
    echo -e "  $0 --network=mainnet        # Switch to mainnet and build"
    echo -e "  $0 --network=testnet        # Switch to testnet and build"
    echo -e "  $0 --build-only --network=mainnet  # Switch to mainnet and build only"
}

# Parse command line arguments
BUILD_ONLY=false
DEBUG_PUBLISH=false
NETWORK=""
for arg in "$@"; do
    case $arg in
        --build-only)
            BUILD_ONLY=true
            ;;
        --debug-publish)
            DEBUG_PUBLISH=true
            ;;
        --network=*)
            NETWORK="${arg#*=}"
            if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
                echo -e "${RED}Invalid network: $NETWORK. Must be 'testnet' or 'mainnet'${NC}"
                exit 1
            fi
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

echo -e "${CYAN}Using Sui CLI: $(command -v sui)${NC}"
echo -e "${CYAN}Sui version: $(sui --version 2>/dev/null | head -n 1)${NC}"

# Handle network switching if specified
if [[ -n "$NETWORK" ]]; then
    echo -e "${BLUE}🔄 Switching to $NETWORK configuration...${NC}"
    if [[ -f "./scripts/switch-network.sh" ]]; then
        ./scripts/switch-network.sh "$NETWORK"
        if [[ $? -ne 0 ]]; then
            echo -e "${RED}❌ Failed to switch to $NETWORK. Exiting.${NC}"
            exit 1
        fi
    else
        echo -e "${RED}❌ Network switching script not found: ./scripts/switch-network.sh${NC}"
        exit 1
    fi
    echo -e "${BLUE}============================================${NC}"
fi

if ! ensure_network_consistency; then
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
BUILD_CMD=(sui move build)
BUILD_CMD_DISPLAY="sui move build"
BUILD_USED_SKIP_FETCH=false

# Default to cached dependency resolution for local builds. This avoids
# unnecessary Git refreshes that can fail on macOS machines without the
# Xcode license accepted. Set MOVE_BUILD_SKIP_FETCH_LATEST_GIT_DEPS=0 to
# force a fresh dependency fetch.
if [[ "${MOVE_BUILD_SKIP_FETCH_LATEST_GIT_DEPS:-1}" != "0" ]]; then
    if supports_move_skip_fetch_latest_git_deps; then
        BUILD_CMD=(sui move build --skip-fetch-latest-git-deps)
        BUILD_CMD_DISPLAY="sui move build --skip-fetch-latest-git-deps"
        BUILD_USED_SKIP_FETCH=true
    else
        echo -e "${YELLOW}Current Sui CLI does not support --skip-fetch-latest-git-deps for build. Falling back to plain build.${NC}"
    fi
fi

echo -e "${BLUE}Running ${BUILD_CMD_DISPLAY}...${NC}"
"${BUILD_CMD[@]}"

# Check build result
if [ $? -ne 0 ]; then
    if [[ "$BUILD_USED_SKIP_FETCH" == true ]]; then
        echo -e "${YELLOW}Tip: if you need to refresh Git dependencies, rerun with MOVE_BUILD_SKIP_FETCH_LATEST_GIT_DEPS=0 after fixing your Xcode/Git environment.${NC}"
    fi
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

# Get gas objects for the active address
echo -e "${BLUE}Checking gas objects for this address...${NC}"
sui client gas --json | jq '
    if type == "array" then
        .[]
    elif (.data? | type) == "array" then
        .data[]
    else
        .
    end
    | {
        id: (.gasCoinId // .id.id // .objectId // "unknown"),
        gas_value: (.mistBalance // .content.fields.balance // .balance // "unknown")
    }
'

echo -e "${YELLOW}Please ensure the above address has sufficient gas for publishing.${NC}"
echo -e "${YELLOW}If gas is insufficient, run: sui client gas ${ACTIVE_ADDRESS}${NC}"

# Prompt user to verify the build and publish
echo -e "${YELLOW}Do you want to publish the package to the active network? (y/n)${NC}"
read publish_response

if [[ "$publish_response" == "y" || "$publish_response" == "Y" ]]; then
    # Ask for gas budget
    echo -e "${YELLOW}Enter gas budget for publishing (default: 200000000):${NC}"
    read gas_budget
    
    # Set default if empty
    gas_budget=${gas_budget:-200000000}

    PUBLISH_CMD=(sui client publish . --gas-budget "$gas_budget")
    PUBLISH_CMD_DISPLAY="sui client publish . --gas-budget ${gas_budget}"

    if [[ "${MOVE_BUILD_SKIP_FETCH_LATEST_GIT_DEPS:-1}" != "0" ]]; then
        if supports_publish_skip_fetch_latest_git_deps; then
            PUBLISH_CMD+=(--skip-fetch-latest-git-deps)
            PUBLISH_CMD_DISPLAY="${PUBLISH_CMD_DISPLAY} --skip-fetch-latest-git-deps"
        else
            echo -e "${YELLOW}Current Sui CLI does not support --skip-fetch-latest-git-deps for publish. Falling back to plain publish.${NC}"
        fi
    fi

    if [ "$DEBUG_PUBLISH" = true ]; then
        echo -e "${YELLOW}Debug publish requested, but this CLI does not support the old --dump/--verbose flags. Running the normal publish command and preserving full output on failure.${NC}"
    fi

    echo -e "${BLUE}Publishing to the active network with gas budget: ${gas_budget}...${NC}"
    echo -e "${BLUE}Running ${PUBLISH_CMD_DISPLAY}${NC}"

    # Capture both stdout and stderr
    PUBLISH_OUTPUT=$("${PUBLISH_CMD[@]}" 2>&1)
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
            
            # Extract more specific error details if available
            ERROR_DETAILS=$(echo "$PUBLISH_OUTPUT" | grep -A 10 "Error: " | grep -v "sui client")
            if [ ! -z "$ERROR_DETAILS" ]; then
                echo -e "${YELLOW}Error details:${NC}"
                echo "$ERROR_DETAILS"
            fi
            
            echo -e "${CYAN}Try running with the --debug-publish flag for more details.${NC}"
        fi

        if echo "$PUBLISH_OUTPUT" | grep -q "client api version"; then
            echo -e "${YELLOW}Your local Sui CLI is older than the connected network. Upgrade the CLI before retrying publish to avoid protocol/dependency verification issues.${NC}"
        fi

        if echo "$PUBLISH_OUTPUT" | grep -qi "already published"; then
            echo -e "${YELLOW}This package already has a published lineage entry. Use 'sui client upgrade' with the upgrade capability from Published.toml instead of running a fresh publish again.${NC}"
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
        else
            echo -e "${GREEN}✅ Package published with ID: ${PACKAGE_ID}${NC}"
        fi
    fi
    
    # Update .env.local with the new package ID
    ENV_FILE="../.env.local"
    if [ -f "$ENV_FILE" ]; then
        echo -e "${BLUE}Updating .env.local with the new package ID...${NC}"

        ACTIVE_ENV=$(get_sui_env)
        ENV_KEYS=("NEXT_PUBLIC_PACKAGE_ID")
        if [[ "$ACTIVE_ENV" == "testnet" ]]; then
            ENV_KEYS+=("NEXT_PUBLIC_TESTNET_PACKAGE_ID" "NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID")
        elif [[ "$ACTIVE_ENV" == "mainnet" ]]; then
            ENV_KEYS+=("NEXT_PUBLIC_MAINNET_PACKAGE_ID" "NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID")
        fi

        for env_key in "${ENV_KEYS[@]}"; do
            if grep -q "^${env_key}=" "$ENV_FILE"; then
                if [[ "$OSTYPE" == "darwin"* ]]; then
                    sed -i '' "s|^${env_key}=.*|${env_key}=${PACKAGE_ID}|" "$ENV_FILE"
                else
                    sed -i "s|^${env_key}=.*|${env_key}=${PACKAGE_ID}|" "$ENV_FILE"
                fi
            fi
        done
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

    update_circle_chain_lineage "$ACTIVE_ENV" "$PACKAGE_ID"
    
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
                                --gas-budget 100000000
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
                                --gas-budget 100000000
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
                                --gas-budget 100000000
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
