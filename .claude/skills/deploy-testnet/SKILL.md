# Deploy to Testnet

Deploy Move contracts to Sui testnet with full verification.

## Task

1. Ensure tests pass (`sui move test`)
2. Build contracts (`sui move build`)
3. Deploy to testnet using build script
4. Capture and store new package ID
5. Update .env.local with NEXT_PUBLIC_PACKAGE_ID
6. Verify deployment on Sui Explorer
7. Test key contract functions post-deployment

## Pre-Deployment Checklist

- [ ] All tests passing
- [ ] No uncommitted changes (or changes are intentional)
- [ ] Sufficient gas in deploying wallet
- [ ] Testnet RPC is accessible
- [ ] Build script is configured for testnet

## Post-Deployment Verification

- [ ] Package ID updated in environment
- [ ] Contract visible on Sui Explorer
- [ ] Can create test circle
- [ ] zkLogin integration works
- [ ] Yield integration functional

## Success Criteria

- Deployment transaction succeeds
- Package ID is captured and saved
- Environment variables updated
- Manual verification on explorer confirms deployment
- Basic contract functions work

## Notes

- Use `cd move && ./build_and_test.sh` for interactive deployment
- Package ID format: `0x...` (64 hex characters)
- Deployment costs vary based on contract size
- Keep track of package IDs for mainnet migration
- Check transaction hash in Sui Explorer for confirmation
