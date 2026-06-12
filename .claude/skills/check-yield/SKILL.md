# Check Yield Integration

Verify yield integration status and configuration for Cetus and NAVI protocols.

## Task

1. Check that yield integration contracts are properly configured
2. Verify Cetus pool addresses and package IDs in environment
3. Test yield tracking service functionality
4. Report current APR values from live APIs
5. Verify event parsing for yield earnings

## Key Checks

- **Cetus Pool ID**: `0xb01b068bd0360bb3308b81eb42386707e460b7818816709b7f51e1635d542d40`
- **Cetus Package**: `0x0c7ae833c220aa73a3643a0d508afa4ac5d50d97312ea4584e35f9eb21b9df12`
- **NAVI Integration**: Check protocol addresses
- **Event Tracking**: Verify YieldConfig and SecurityDeposit events

## Success Criteria

- All protocol addresses are correctly configured
- APR fetching works from live APIs
- Event parsing returns valid earnings data
- No integration errors in logs

## Notes

- Uses real testnet addresses for Cetus DEX
- Yield strategies: Conservative (NAVI), Balanced (NAVI+Cetus), Aggressive
- Check src/services/cetus-service.ts and yield-tracking-service.ts
