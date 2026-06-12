# Test Contracts

Run the Move smart contract test suite for njangi-on-chain.

## Task

1. Navigate to the move directory
2. Run `sui move test` to execute all contract tests
3. Report any test failures with details
4. If tests pass, confirm all modules are working correctly

## Success Criteria

- All tests pass
- No compilation errors
- Report test coverage if available

## Notes

- Tests cover njangi_core, njangi_circles, and njangi_yield_integration modules
- Common test failures may relate to time utilities or yield calculations
- If tests fail, check that test dependencies are properly configured
