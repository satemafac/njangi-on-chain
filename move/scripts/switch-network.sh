#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOVE_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="$MOVE_DIR/config"
MOVE_TOML="$MOVE_DIR/Move.toml"

# Function to display usage
display_usage() {
    echo -e "${CYAN}Njangi Network Switcher${NC}"
    echo -e "${CYAN}=====================${NC}"
    echo ""
    echo -e "Usage: $0 [network]"
    echo -e ""
    echo -e "Networks:"
    echo -e "  ${GREEN}testnet${NC}  - Switch to testnet configuration"
    echo -e "  ${GREEN}mainnet${NC}  - Switch to mainnet configuration"
    echo -e "  ${GREEN}status${NC}   - Show current network configuration"
    echo -e ""
    echo -e "Examples:"
    echo -e "  $0 testnet     # Switch to testnet"
    echo -e "  $0 mainnet     # Switch to mainnet"
    echo -e "  $0 status      # Show current network"
}

# Function to get current network from Move.toml
get_current_network() {
    if [[ -f "$MOVE_TOML" ]]; then
        if grep -q "Current configuration: TESTNET" "$MOVE_TOML"; then
            echo "testnet"
        elif grep -q "Current configuration: MAINNET" "$MOVE_TOML"; then
            echo "mainnet"
        else
            echo "unknown"
        fi
    else
        echo "none"
    fi
}

# Function to show current status
show_status() {
    local current_network=$(get_current_network)
    local sui_env=$(sui client active-env 2>/dev/null | grep -v warning || echo "not set")
    
    echo -e "${BLUE}============================================${NC}"
    echo -e "${BLUE}   Njangi Network Configuration Status     ${NC}"
    echo -e "${BLUE}============================================${NC}"
    echo ""
    echo -e "${CYAN}Move.toml Network:${NC} $current_network"
    echo -e "${CYAN}SUI CLI Environment:${NC} $sui_env"
    echo ""
    
    if [[ "$current_network" == "testnet" && "$sui_env" == "testnet" ]]; then
        echo -e "${GREEN}✅ Configuration is consistent - both using testnet${NC}"
    elif [[ "$current_network" == "mainnet" && "$sui_env" == "mainnet" ]]; then
        echo -e "${GREEN}✅ Configuration is consistent - both using mainnet${NC}"
    else
        echo -e "${YELLOW}⚠️  Configuration mismatch detected!${NC}"
        echo -e "   Consider running: sui client switch --env $current_network"
    fi
    
    echo -e "${BLUE}============================================${NC}"
}

# Function to switch network
switch_network() {
    local target_network="$1"
    local config_file="$CONFIG_DIR/$target_network.toml"
    
    # Check if config file exists
    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}❌ Configuration file not found: $config_file${NC}"
        return 1
    fi
    
    # Create backup of current Move.toml
    if [[ -f "$MOVE_TOML" ]]; then
        cp "$MOVE_TOML" "$MOVE_TOML.backup"
        echo -e "${BLUE}📁 Backup created: Move.toml.backup${NC}"
    fi
    
    # Copy new configuration
    cp "$config_file" "$MOVE_TOML"
    
    if [[ $? -eq 0 ]]; then
        echo -e "${GREEN}✅ Successfully switched to $target_network configuration${NC}"
        echo -e "${YELLOW}📝 Don't forget to switch your SUI CLI environment:${NC}"
        echo -e "   ${CYAN}sui client switch --env $target_network${NC}"
        
        # Check if SUI environment exists and offer to switch
        local sui_envs=$(sui client envs 2>/dev/null | grep -v warning | grep "$target_network" || true)
        if [[ -n "$sui_envs" ]]; then
            echo ""
            echo -e "${YELLOW}🔄 Would you like to switch SUI CLI environment now? (y/n)${NC}"
            read -r response
            if [[ "$response" == "y" || "$response" == "Y" ]]; then
                sui client switch --env "$target_network"
                if [[ $? -eq 0 ]]; then
                    echo -e "${GREEN}✅ SUI CLI environment switched to $target_network${NC}"
                else
                    echo -e "${RED}❌ Failed to switch SUI CLI environment${NC}"
                fi
            fi
        else
            echo -e "${YELLOW}⚠️  SUI CLI environment '$target_network' not found${NC}"
            echo -e "   ${CYAN}Add it with: sui client new-env --alias $target_network --rpc <rpc_url>${NC}"
        fi
        
        echo ""
        echo -e "${BLUE}📊 Current configuration:${NC}"
        show_status
        
    else
        echo -e "${RED}❌ Failed to switch configuration${NC}"
        # Restore backup if copy failed
        if [[ -f "$MOVE_TOML.backup" ]]; then
            mv "$MOVE_TOML.backup" "$MOVE_TOML"
            echo -e "${BLUE}📁 Restored from backup${NC}"
        fi
        return 1
    fi
}

# Main execution
case "${1:-}" in
    "testnet"|"mainnet")
        local current_network=$(get_current_network)
        if [[ "$current_network" == "$1" ]]; then
            echo -e "${YELLOW}⚠️  Already using $1 configuration${NC}"
            show_status
        else
            echo -e "${BLUE}🔄 Switching from $current_network to $1...${NC}"
            switch_network "$1"
        fi
        ;;
    "status")
        show_status
        ;;
    "")
        display_usage
        echo ""
        show_status
        ;;
    *)
        echo -e "${RED}❌ Invalid network: $1${NC}"
        echo ""
        display_usage
        exit 1
        ;;
esac 