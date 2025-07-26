# Quick Deployment Reference

## 🚀 **One-Command Deployment**

```bash
# Deploy to mainnet
./deploy.sh mainnet

# Deploy to testnet  
./deploy.sh testnet
```

## 💰 **Wallet Funding**

**Mainnet Wallet Address:**
```
0xdde1086c98c6023db8e3d8267992e4c9aeba3d0271f6bac85dc2f6daa8301c77
```

**Requirements:**
- **Testnet**: Free SUI from [Discord](https://discord.com/invite/sui)
- **Mainnet**: 5-10 SUI for deployment gas

## 🔄 **Network Commands**

```bash
# Check current configuration
./scripts/switch-network.sh status

# Switch networks
./scripts/switch-network.sh mainnet
./scripts/switch-network.sh testnet

# Build only (no deployment)
./deploy.sh mainnet --build-only

# Custom gas budget
./deploy.sh mainnet --gas-budget 300000000
```

## 📁 **Files Structure**

```
move/
├── deploy.sh                 # Main deployment script
├── config/
│   ├── testnet.toml         # Testnet config
│   └── mainnet.toml         # Mainnet config
├── scripts/
│   └── switch-network.sh    # Network switcher
└── Move.toml                # Active config (auto-updated)
```

## ⚡ **Environment Variables (Auto-Updated)**

```bash
# Testnet
NEXT_PUBLIC_PACKAGE_ID=0x...

# Mainnet  
NEXT_PUBLIC_MAINNET_PACKAGE_ID=0x...
```

## 🛠️ **Troubleshooting**

```bash
# Check wallet balance
sui client gas

# Verify network setup
./scripts/switch-network.sh status

# Build verification
./deploy.sh mainnet --build-only
```

---

**For complete documentation:** [`../docs/deployment-guide.md`](../docs/deployment-guide.md) 