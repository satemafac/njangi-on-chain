# Build and Deploy

Build Move contracts and optionally deploy to testnet using the project's build script.

## Task

1. Navigate to the move directory
2. Run `./build_and_test.sh` for full build/test/publish cycle
3. OR run `./build_and_test.sh --build-only` to skip publishing
4. Verify that NEXT_PUBLIC_PACKAGE_ID is updated in .env.local
5. Report the new package ID if deployed

## Success Criteria

- Build completes without errors
- Tests pass before deployment
- Package ID is synced to environment variables
- Deployment transaction succeeds (if publishing)

## Notes

- Interactive script will prompt for deployment confirmation
- Use --build-only during development to skip publishing
- Package ID updates automatically sync to .env.local
- Check gas costs before deploying to mainnet
