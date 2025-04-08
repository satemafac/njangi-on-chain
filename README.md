# Njangi Smart Contract Documentation
#npx tsx salt-service.ts - npm run dev - ./start-zklogin-services.sh
 - sui move build

## Deployment
Latest contract deployed to Sui Testnet:
- Package ID: `0x6b6dabded31921f627c3571197e31433e2b312700ff07ef394daa5cdcb3abd1c`
- Features: Stablecoin swaps, custody wallets, DEX integration
- Dependencies: Sui Framework, Cetus DEX

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

### Stablecoin Integration & DEX Swaps
```move
struct StablecoinConfig has store, drop {
    enabled: bool,
    target_coin_type: string::String,
    dex_address: address,
    slippage_tolerance: u64,
    minimum_swap_amount: u64,
    pool_id: option::Option<address>,
    global_config_id: option::Option<address>,
}
```
- Automatic SUI to stablecoin swaps (USDC, USDT)
- Real-time DEX integration with Cetus
- Inflation protection for circle funds
- Configurable slippage tolerance
- Multi-token support
- Comprehensive balance tracking

### Custody Wallet
```move
struct CustodyWallet has key, store {
    id: object::UID,
    circle_id: object::ID,
    balance: balance::Balance<SUI>,
    admin: address,
    stablecoin_config: StablecoinConfig,
    stablecoin_holdings: table::Table<string::String, u64>,
    stablecoins: vector<address>,
}
```
- Circle-linked secure fund storage 
- Auto-swap of SUI deposits to stablecoins
- Multi-token balance tracking
- Withdrawal limits and time-locking
- Admin-controlled security features
- Real-time DEX integration

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

### Managing Stablecoins
```move
// Configure auto-swap settings
public fun configure_stablecoin_swap(
    wallet: &mut CustodyWallet,
    enabled: bool,
    target_coin_type: vector<u8>,
    dex_address: address,
    slippage_tolerance: u64,
    minimum_swap_amount: u64,
    global_config_id: address,
    pool_id: address,
    ctx: &mut tx_context::TxContext
)

// Deposit SUI with auto-swap
public fun deposit_to_custody(
    wallet: &mut CustodyWallet,
    payment: coin::Coin<SUI>,
    clock: &clock::Clock,
    ctx: &mut tx_context::TxContext
)

// Withdraw stablecoins from custody
public fun withdraw_stablecoin(
    wallet: &mut CustodyWallet,
    amount: u64,
    coin_type: vector<u8>,
    clock: &clock::Clock,
    ctx: &mut tx_context::TxContext
)
```

## SUI to USDC Auto-Swap Feature

### Overview
The auto-swap feature allows circle members to automatically convert SUI tokens to USDC stablecoins using Cetus DEX. This helps protect against crypto volatility by converting contributions to stablecoins.

### Implementation Components

1. **Smart Contract**: The `njangi_circle.move` contract has been updated with:
   - `configure_stablecoin_swap`: Function to configure auto-swap settings
   - `deposit_stablecoin_to_custody`: Function to deposit swapped stablecoins to the custody wallet

2. **Frontend Integration**:
   - `StablecoinSwapForm.tsx`: Component for manually executing swaps
   - `ManageCircle` component: Updated with auto-swap configuration section
   - `cetus-service.ts`: Service for interacting with Cetus DEX

3. **Cetus SDK Integration**:
   - Used `@cetusprotocol/cetus-sui-clmm-sdk` to interact with Cetus liquidity pools
   - Implemented swap transaction creation and execution
   - Added price estimates and slippage protection

### Usage Guide

#### Auto-Swap Configuration (Admin only)
1. Navigate to the circle management page
2. In the "Stablecoin Auto-Swap Settings" section, toggle "Auto-Swap Funds" to enable/disable
3. Configure options:
   - Stablecoin Type: Select USDC, USDT, etc.
   - Slippage Tolerance: Set acceptable price impact (0.1% - 5%)
   - Minimum Swap Amount: Minimum SUI amount to trigger auto-swap

#### Manual Swap (Admin only)
1. Navigate to the circle management page
2. In the "Stablecoin Auto-Swap Settings" section, click "Show Swap Form"
3. Enter the amount of SUI to swap
4. Review the estimated USDC output and price impact
5. Click "Swap SUI for USDC" to execute the transaction

### Technical Notes
- Uses Cetus DEX on SUI testnet for liquidity
- zkLogin integration for secure transaction signing
- Price impact warnings to protect users from unfavorable trades
- Real-time price updates from CoinGecko API

## Events and Monitoring

### Key Events
- CircleCreated
- MemberJoined
- ContributionMade
- PayoutMade
- CycleCompleted
- StablecoinSwapExecuted
- StablecoinHoldingUpdated
- CustodyDeposited
- CustodyWithdrawn

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
- Stablecoin errors (ESwapFailed, ESlippageExceeded, EInsufficientLiquidity, EUnsupportedToken)

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
5. Cross-chain stablecoin integration

### DEX Integration
The contract now integrates with the Cetus DEX on Sui for automatic SUI to stablecoin swaps. Future enhancements will include:
1. Integration with additional DEXes for better rates
2. Support for more token types
3. Advanced price impact management
4. Liquidity aggregation across multiple sources
5. Automatic pool selection based on best rates

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

## Join Request System

The application includes a feature for users to request to join circles. These requests are stored in a SQLite database and managed through a set of API endpoints.

### Database Structure

Join requests are stored in a SQLite database (`join-requests.db`) in the project root. The table structure is:

```sql
CREATE TABLE IF NOT EXISTS join_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  circleId TEXT NOT NULL,
  circleName TEXT NOT NULL,
  userAddress TEXT NOT NULL,
  userName TEXT NOT NULL,
  requestDate INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
  UNIQUE(circleId, userAddress)
)
```

### API Endpoints

The following API endpoints are available for managing join requests:

- `POST /api/join-requests/create` - Create a new join request
- `GET /api/join-requests/[circleId]` - Get all pending requests for a circle
- `PUT /api/join-requests/[circleId]/update` - Update a join request status
- `GET /api/join-requests/user/[userAddress]` - Get all requests for a user

### Client-Side Integration

The frontend uses the `join-request-service.ts` service to interact with these API endpoints. This service provides methods for creating, fetching, and updating join requests.

### Usage Flow

1. User visits a circle's join page
2. User clicks "Request to Join Circle"
3. Request is stored in the SQLite database
4. Admin views pending requests on the manage circle page
5. Admin approves or rejects requests
6. Database is updated with the new status
