# Check Environment

Validate environment configuration for njangi-on-chain development.

## Task

1. Check that .env.local exists and has required variables
2. Verify key environment variables are set:
   - NEXT_PUBLIC_PACKAGE_ID
   - ZKLOGIN_SECRET
   - Database connection strings
   - The active network's Enoki API key (server-only `ENOKI_API_KEY_TESTNET` / `ENOKI_API_KEY_MAINNET`)
   - API keys for Cetus, NAVI
3. Check that package IDs match deployed contracts
4. Flag any `NEXT_PUBLIC_ENOKI*` variable: Next.js inlines it into the browser bundle, so it must never hold the Enoki key
5. Report any missing or misconfigured variables

## Required Variables

### Core
- `NEXT_PUBLIC_PACKAGE_ID` - Move package ID (auto-updated by build script)
- `ZKLOGIN_SECRET` - Session encryption key

### Services
- Cetus API keys/endpoints
- NAVI protocol addresses
- Enoki API key: `ENOKI_API_KEY_TESTNET` / `ENOKI_API_KEY_MAINNET` (server-only)

### Database
- SQLite/PostgreSQL connection strings
- Database migration status

## Success Criteria

- All required variables are set
- Package IDs are valid and deployed
- Services are reachable
- Database is accessible
- No configuration warnings

## Notes

- Package ID updates automatically when deploying contracts
- zkLogin needs no local services: salts and zkProofs come from Enoki
- Check CLAUDE.md for full environment setup instructions
