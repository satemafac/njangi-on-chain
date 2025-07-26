# 🚀 Mainnet Deployment Checklist

## Step 1: Fund Wallet
**Send 5-10 SUI to:**
```
0xdde1086c98c6023db8e3d8267992e4c9aeba3d0271f6bac85dc2f6daa8301c77
```

## Step 2: Verify Setup
```bash
cd move

# Check wallet balance
sui client gas

# Verify network status
./scripts/switch-network.sh status
```

## Step 3: Test Build
```bash
# Test compilation for mainnet
./deploy.sh mainnet --build-only
```

## Step 4: Deploy to Mainnet
```bash
# Deploy contracts
./deploy.sh mainnet
```

## Step 5: Verify Deployment
```bash
# Check environment variables were updated
cat .env.local | grep MAINNET_PACKAGE_ID

# Test contract call (optional)
sui client call \
  --package <PACKAGE_ID> \
  --module njangi_core \
  --function get_protocol_version \
  --gas-budget 1000000
```

---

✅ **Deployment Complete!** Your contracts are now live on SUI mainnet.

**Next Steps:**
- Update frontend to use mainnet package ID
- Test basic contract functions
- Monitor contract activity on [SUI Explorer](https://suiexplorer.com/)

**Need Help?** See [Deployment Guide](docs/deployment-guide.md) for troubleshooting. 