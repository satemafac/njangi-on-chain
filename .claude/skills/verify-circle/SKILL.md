# Verify Circle

Check circle state and configuration on-chain for a specific circle.

## Task

1. Prompt for circle ID if not provided
2. Query circle state from blockchain using Sui RPC
3. Verify circle configuration (members, rotation, treasury)
4. Check yield integration settings
5. Report circle health and any issues

## Key Information to Check

- Circle name and creation time
- Member list and rotation order
- Current rotation phase
- Treasury balance
- Yield strategy configuration
- Security deposit status
- Recent events (contributions, rotations, yield earnings)

## Success Criteria

- Circle data retrieves successfully
- All members are properly configured
- Rotation logic is consistent
- Treasury balances match expected values
- No state inconsistencies

## Notes

- Uses sui-rpc-failover for reliable RPC access
- Check src/lib/circle-chain.ts for circle queries
- Common issues: stale RPC data, missing events, incorrect time calculations
