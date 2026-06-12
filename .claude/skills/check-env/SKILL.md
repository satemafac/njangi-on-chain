# Check Environment

Validate environment configuration for njangi-on-chain development.

## Task

1. Check that .env.local exists and has required variables
2. Verify key environment variables are set:
   - NEXT_PUBLIC_PACKAGE_ID
   - ZKLOGIN_SECRET
   - Database connection strings
   - API keys for Cetus, NAVI, zkLogin services
3. Check that package IDs match deployed contracts
4. Verify Docker services are configured
5. Report any missing or misconfigured variables

## Required Variables

### Core
- `NEXT_PUBLIC_PACKAGE_ID` - Move package ID (auto-updated by build script)
- `ZKLOGIN_SECRET` - Session encryption key

### Services
- Cetus API keys/endpoints
- NAVI protocol addresses
- zkLogin service configuration

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
- zkLogin services must be running (ports 5001, 5003)
- Check CLAUDE.md for full environment setup instructions
