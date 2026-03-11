# Njangi Smart Contract Deployment Guide

This guide covers deploying Njangi smart contracts to SUI blockchain using the dynamic network configuration system.

## 🏗️ **Dynamic Network Configuration System**

The Njangi project now features a flexible network switching system that allows seamless deployment to both testnet and mainnet with different configurations.

### **System Architecture**

```
move/
├── Move.toml                 # Active configuration (auto-updated)
├── config/
│   ├── testnet.toml         # Testnet configuration
│   └── mainnet.toml         # Mainnet configuration  
├── scripts/
│   └── switch-network.sh    # Network switching utility
├── deploy.sh                # Main deployment script
└── build_and_test.sh        # Enhanced build script
```

### **Network Configurations**

#### **Testnet Configuration**
- **SUI Framework**: Testnet revision
- **Pyth Network**: `0x41c21c1c0c8d43e39b1fcf0cb61e8b3e84acea99877e1948fd1fb87cc60e69b4`
- **Cetus CLMM**: `0x0c7ae833c220aa73a3643a0d508afa4ac5d50d97312ea4584e35f9eb21b9df12`
- **Cetus Config**: `0xf5ff7d5ba73b581bca6b4b9fa0049cd320360abd154b809f8700a8fd3cfaf7ca`

#### **Mainnet Configuration**
- **SUI Framework**: Mainnet revision  
- **Pyth Network**: `0x8d97f1cd6ac663735be08d48a218f259dcb83244b6b5b94a999e689b86929519`
- **Cetus CLMM**: `0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb`
- **Cetus Config**: `0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f`

## 📋 **Prerequisites**

### **Required Tools**
- **SUI CLI** (v1.48.0+): `sui --version`
- **Git**: For repository management
- **jq**: For JSON processing (optional, for enhanced wallet info)
- **bc**: For balance calculations (optional)

### **SUI CLI Setup**
```bash
# Install SUI CLI
curl -fLJO https://github.com/MystenLabs/sui/releases/download/mainnet/sui-mainnet-macos-arm64.tgz
tar -xf sui-mainnet-macos-arm64.tgz
sudo mv sui /usr/local/bin/

# Add environments
sui client new-env --alias testnet --rpc https://fullnode.testnet.sui.io:443
sui client new-env --alias mainnet --rpc https://fullnode.mainnet.sui.io:443
```

## 🔄 **Network Management**

### **Check Current Configuration**
```bash
cd move
./scripts/switch-network.sh status
```

**Output:**
```
============================================
   Njangi Network Configuration Status     
============================================

Move.toml Network: testnet
SUI CLI Environment: testnet

✅ Configuration is consistent - both using testnet
============================================
```

### **Switch Networks**
```bash
# Switch to mainnet
./scripts/switch-network.sh mainnet

# Switch to testnet  
./scripts/switch-network.sh testnet
```

The script will:
- ✅ Backup current `Move.toml`
- ✅ Copy network-specific configuration
- ✅ Offer to switch SUI CLI environment
- ✅ Show updated configuration status

### **Manual SUI Environment Switching**
```bash
# List environments
sui client envs

# Switch environment
sui client switch --env mainnet
sui client switch --env testnet
```

## 🚀 **Deployment Methods**

### **Method 1: Complete Deployment (Recommended)**

```bash
cd move

# Deploy to testnet
./deploy.sh testnet

# Deploy to mainnet  
./deploy.sh mainnet
```

**Features:**
- ✅ Automatic network switching
- ✅ Wallet balance validation
- ✅ Build verification
- ✅ Interactive deployment confirmation
- ✅ Automatic environment variable updates

### **Method 2: Custom Gas Budget**

```bash
# Deploy with custom gas (mainnet recommended: 300M)
./deploy.sh mainnet --gas-budget 300000000

# Deploy with debug output
./deploy.sh mainnet --debug
```

### **Method 3: Build Only (Testing)**

```bash
# Build for mainnet without deploying
./deploy.sh mainnet --build-only

# Build for testnet
./deploy.sh testnet --build-only
```

### **Method 4: Enhanced Build Script**

```bash
# Build with network switching
./build_and_test.sh --network=mainnet --build-only

# Build and test on testnet
./build_and_test.sh --network=testnet
```

## 💰 **Wallet Funding**

### **Get Your Wallet Address**
```bash
sui client active-address
```

### **Funding Requirements**

#### **Testnet**
- **Amount**: Free SUI from Discord
- **Source**: Join SUI Discord → `#testnet-faucet` → `!faucet <your_address>`
- **Alternative**: [Testnet Faucet](https://discord.com/invite/sui)

#### **Mainnet**
- **Amount**: 5-10 SUI (recommended)
- **Purpose**: Gas fees for deployment
- **Cost**: ~0.5-2 SUI for deployment
- **Purchase**: Major exchanges (Binance, Coinbase, KuCoin, etc.)

**Current Wallet for Mainnet Deployment:**
```
0xdde1086c98c6023db8e3d8267992e4c9aeba3d0271f6bac85dc2f6daa8301c77
```

### **Check Wallet Balance**
```bash
# Detailed balance
sui client gas

# JSON format (for scripting)
sui client gas --json | jq '.data[] | {id: .id.id, balance: .content.fields.balance}'
```

## 📦 **Deployment Process**

### **1. Pre-deployment Checks**
```bash
cd move

# Verify network configuration
./scripts/switch-network.sh status

# Check wallet balance
sui client gas

# Verify build works
./deploy.sh mainnet --build-only
```

### **2. Execute Deployment**
```bash
# Interactive deployment
./deploy.sh mainnet
```

**Deployment Flow:**
1. 🔄 Network configuration switching
2. 🔨 Contract compilation and verification
3. 💰 Wallet balance validation
4. ⚠️ Interactive confirmation prompt
5. 🚀 Contract publication to blockchain
6. 📝 Package ID extraction and logging
7. ⚙️ Environment variable updates

### **3. Post-deployment**

The deployment script automatically:
- ✅ Extracts package ID from transaction
- ✅ Updates `.env.local` with appropriate variables:
  - `NEXT_PUBLIC_TESTNET_PACKAGE_ID` (testnet)
  - `NEXT_PUBLIC_MAINNET_PACKAGE_ID` (mainnet)
- ✅ Displays deployment summary

**Manual verification:**
```bash
# Check package info
sui client object <PACKAGE_ID>

# Verify environment variables
cat ../.env.local | grep PACKAGE_ID
```

## 🔧 **Environment Variables**

### **Frontend Integration**

The deployment process updates your `.env.local` file:

```bash
# Testnet deployment
NEXT_PUBLIC_TESTNET_PACKAGE_ID=0x1234...abcd

# Mainnet deployment  
NEXT_PUBLIC_MAINNET_PACKAGE_ID=0x5678...efgh

# Both networks
NEXT_PUBLIC_TESTNET_PACKAGE_ID=0x1234...abcd
NEXT_PUBLIC_MAINNET_PACKAGE_ID=0x5678...efgh
```

### **Network Detection in Frontend**

```typescript
// In your Next.js app
const packageId = process.env.NEXT_PUBLIC_SUI_NETWORK === 'mainnet'
  ? process.env.NEXT_PUBLIC_MAINNET_PACKAGE_ID
  : process.env.NEXT_PUBLIC_TESTNET_PACKAGE_ID;
```

## 🛠️ **Advanced Usage**

### **Multiple Deployments**

```bash
# Deploy to both networks
./deploy.sh testnet
./deploy.sh mainnet

# Verify both deployments
grep "PACKAGE_ID" ../.env.local
```

### **Custom Deployment Scripts**

```bash
# Build-only with specific network
./build_and_test.sh --network=mainnet --build-only

# Deploy with debug output
./deploy.sh mainnet --debug --gas-budget 500000000
```

### **Network Configuration Backup**

```bash
# Backup current configuration
cp Move.toml Move.toml.backup

# Restore from backup
cp Move.toml.backup Move.toml
```

## 🐛 **Troubleshooting**

### **Common Issues**

#### **"No gas coins found"**
```bash
# Check wallet address
sui client active-address

# Verify environment
sui client active-env

# Check balance
sui client gas
```

**Solution:** Fund wallet with SUI tokens

#### **"Configuration mismatch detected"**
```bash
# Check status
./scripts/switch-network.sh status

# Fix by switching environment
sui client switch --env <network>
```

#### **"Build failed"**
```bash
# Clean build
sui move clean
sui move build

# Check dependencies
cat Move.toml
```

**Solution:** Verify network configuration is correct

#### **"Failed to extract package ID"**
```bash
# Check transaction manually
sui client ptb --help

# Look for package creation in output
grep -i "package" deployment_output.log
```

### **Debug Mode**

```bash
# Enable verbose output
./deploy.sh mainnet --debug

# Manual deployment
sui client publish . --gas-budget 200000000 --skip-fetch-latest-git-deps
```

## 📊 **Deployment Verification**

### **Contract Verification**

```bash
# Check package exists
sui client object <PACKAGE_ID>

# List package modules
sui client package <PACKAGE_ID>

# Verify contract functions
sui client call --package <PACKAGE_ID> --module njangi_circles --function get_version
```

### **Integration Testing**

```bash
# Test basic function call
sui client call \
  --package <PACKAGE_ID> \
  --module njangi_core \
  --function get_protocol_version \
  --gas-budget 1000000
```

## 🔒 **Security Considerations**

### **Mainnet Deployment**
- ✅ **Immutable**: Contracts cannot be modified after deployment
- ✅ **Audited**: Code has been tested on testnet
- ⚠️ **Gas Costs**: Mainnet transactions cost real SUI
- ⚠️ **Irreversible**: Deployment cannot be undone

### **Best Practices**
1. **Test First**: Always deploy to testnet before mainnet
2. **Verify Build**: Use `--build-only` to verify compilation
3. **Check Balance**: Ensure sufficient gas before deployment
4. **Backup Config**: Keep configuration backups
5. **Verify Package**: Confirm package ID after deployment

## 📚 **Additional Resources**

- **SUI Documentation**: https://docs.sui.io/
- **Move Language**: https://move-language.github.io/move/
- **Cetus Protocol**: https://cetus-1.gitbook.io/cetus-developer-docs/
- **Pyth Network**: https://docs.pyth.network/sui

## 🤝 **Support**

For deployment issues:
1. Check [Troubleshooting](#troubleshooting) section
2. Verify network configuration with `./scripts/switch-network.sh status`
3. Review deployment logs for error messages
4. Test with `--build-only` flag first 
