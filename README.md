# Njangi Smart Contract Documentation
#npx tsx salt-service.ts - npm run dev - ./start-zklogin-services.sh
 - sui move build

## Overview
The Njangi smart contract is a decentralized savings and credit system implemented on the Sui blockchain. It supports multiple types of savings circles including rotational, goal-based, and auction-based models.

## Features

### Circle Types
1. **Rotational (ROSCA)**
   - Fixed contribution amounts
   - Automated rotation-based payouts
   - Fair distribution system
   - Member tracking and verification

2. **Goal-Based**
   - Target amount or time-based goals
   - Milestone tracking
   - Progress verification
   - Flexible distribution models

3. **Auction-Based**
   - Competitive bidding system
   - Discount distribution
   - Dynamic payout amounts

## Core Components

### Treasury Management
```move
struct CircleTreasury {
    balance: Coin<USDC>,
    total_contributions: u64,
    last_payout_time: u64,
}
```
- Secure USDC handling
- Automated reconciliation
- Balance verification

### Member Management
```move
struct MemberState {
    status: u8,
    reputation_score: u64,
    warning_count: u8,
    total_contributions: u64,
}
```
- Reputation system
- Warning/suspension handling
- Contribution tracking

### Cycle Management
```move
struct CycleInfo {
    cycle_number: u64,
    total_collected: u64,
    contributors: vector<address>,
    payout_recipient: address,
}
```
- Automated cycle transitions
- Contribution tracking
- Payout automation

## Security Features

### Capability-Based Access Control
```move
struct AdminCap has key { ... }
struct VerifierCap has key { ... }
struct MemberCap has key { ... }
```
- Role-based permissions
- Time-bound capabilities
- Secure operation validation

### State Management
```move
struct CircleState {
    is_locked: bool,
    operation_sequence: u64,
    current_concurrent_operations: u64,
}
```
- Concurrent operation handling
- State consistency checks
- Operation sequencing

## Usage Guide

### Creating a Circle
```move
public fun create_circle(
    name: vector<u8>,
    contribution_amount: u64,
    cycle_type: u8,
    // ... other parameters
)
```

### Joining a Circle
```move
public fun join_circle(
    circle: &mut NjangiCircle,
    security_deposit: Coin<USDC>,
    // ... other parameters
)
```

### Making Contributions
```move
public fun make_contribution(
    circle: &mut NjangiCircle,
    payment: Coin<USDC>,
    // ... other parameters
)
```

## Events and Monitoring

### Key Events
- CircleCreated
- MemberJoined
- ContributionMade
- PayoutMade
- CycleCompleted

### Progress Tracking
```move
public fun get_circle_summary(): CircleSummary
public fun get_goal_progress(): (u64, u64, vector<Milestone>)
```

## Error Handling

### Error Types
- Authentication errors (EINVALID_AUTHENTICATION)
- State errors (EINVALID_CYCLE_STATE)
- Operation errors (EINVALID_OPERATION_SEQUENCE)
- Treasury errors (EINVALID_TREASURY_STATE)

## Best Practices

### Treasury Management
1. Regular reconciliation
2. Balance verification
3. Secure payout processing

### Member Operations
1. Proper capability validation
2. State checks before operations
3. Concurrent operation handling

### Cycle Management
1. Verify cycle completion
2. Track all contributions
3. Validate payout conditions

## Performance Considerations

### Optimizations
1. O(1) member lookups using Table
2. Efficient rotation order updates
3. Batched treasury operations
4. Cached cycle information

### Scalability
1. Member limit considerations
2. Operation concurrency limits
3. Treasury balance management

## Integration Guide

### Required Dependencies
```toml
[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "testnet" }
```

### USDC Integration
```move
use sui_ext::usdc::USDC;
```

## Testing

### Test Scenarios
1. Circle creation and setup
2. Member operations
3. Contribution handling
4. Payout processing
5. Goal tracking
6. Treasury reconciliation

## Security Considerations

### Access Control
1. Capability validation
2. Role-based permissions
3. Time-bound operations

### State Management
1. Concurrent operation handling
2. State consistency checks
3. Treasury verification

## Upgradeability

### Version Management
1. Contract versioning
2. State migration
3. Backward compatibility

## Common Issues and Solutions

### Treasury Discrepancies
- Regular reconciliation
- Automated balance checks
- Discrepancy resolution

### Member Management
- Proper state transitions
- Warning/suspension handling
- Reputation management

### Cycle Operations
- Proper sequencing
- Contribution verification
- Payout automation

## Support and Maintenance

### Monitoring
1. Event tracking
2. State verification
3. Performance monitoring

### Troubleshooting
1. Error code reference
2. State validation
3. Operation verification

## Future Improvements

### Planned Features
1. Enhanced governance
2. Additional circle types
3. Advanced treasury management
4. Improved scalability

## Development Setup

### zkLogin.zkey File
The project requires a large zkLogin.zkey file (588MB) which is not included in the repository due to GitHub file size limitations. 

To set up your development environment:
1. Run the provided download script to fetch the file:
   ```
   ./download-main-zkey.sh   # For mainnet/testnet
   # OR
   ./download-test-zkey.sh   # For testing environments
   ```
2. This will download and place the zkLogin.zkey file in the root directory
3. The file is already added to .gitignore to prevent accidental commits

This file is required for the zkLogin services to function properly as referenced in the docker-compose.yml configuration.

## License
[Specify License]
