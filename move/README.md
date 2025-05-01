# Njangi On-Chain

A modular SUI Move implementation of the Njangi circle savings system.

## Module Structure

The codebase has been split into multiple modules for better organization:

1. **njangi_core.move** - Core constants, error codes, and helper functions
2. **njangi_circles.move** - Circle creation and management 
3. **njangi_members.move** - Member management functionality
4. **njangi_payments.move** - Payment and contribution functionality
5. **njangi_custody.move** - Custody wallet functionality

## Fixing Compiler Errors

When compiling the split modules, you may encounter linter errors regarding unbound modules or undefined functions. This is because the modules depend on each other, but the compiler might not recognize them correctly on the first pass.

### Building Order

To fix these issues, build the modules in this order:

1. First build `njangi_core` - it has no module dependencies
2. Then build `njangi_custody` and `njangi_members` - they only depend on core
3. Then build `njangi_circles` - it depends on core, custody, and members
4. Finally build `njangi_payments` - it depends on all other modules

### Common Errors

#### Module Constants Access

Error: `Invalid access of 'njangi::njangi_core::CONSTANT_NAME'`

Fix: In modules like `njangi_custody` and `njangi_members`, make these constants public in `njangi_core` and redefine them locally:

```move
// In njangi_custody.move
// At the top after imports but before structs
const CUSTODY_OP_DEPOSIT: u8 = core::CUSTODY_OP_DEPOSIT;
const CUSTODY_OP_WITHDRAWAL: u8 = core::CUSTODY_OP_WITHDRAWAL;
const CUSTODY_OP_STABLECOIN_DEPOSIT: u8 = core::CUSTODY_OP_STABLECOIN_DEPOSIT;
const MS_PER_DAY: u64 = core::MS_PER_DAY;
```

#### Function Visibility

Error: `public(friend) is deprecated. Replace with public(package)`

Fix: Update all `public(friend)` declarations to use `public(package)` instead.

#### Lambda Functions

Error: `Unexpected lambda type. Lambdas can only be used with 'macro' functions, as parameters or direct arguments`

Fix: Refactor functions that use lambda callbacks to use concrete function references or implement a trait-like pattern.

## Building the Project

```bash
cd move
sui move build
```

## Testing

```bash
cd move
sui move test
```

## Publishing

```bash
cd move
sui client publish --gas-budget 200000000
```

## Njangi Circle with Cetus DEX Integration

This module implements a Circle-based savings and contribution system with Cetus DEX integration for automated SUI-to-stablecoin swaps.

## Setup and Compilation

1. Make sure you have Sui CLI installed:
```bash
sui --version
```

2. Build the package:
```bash
cd move
sui move build
```

3. Publish the package to testnet:
```bash
sui client publish --gas-budget 100000000
```

## Cetus DEX Integration

This contract uses Cetus CLMM (Concentrated Liquidity Market Maker) for real-time stablecoin swaps. The integration allows users to:

1. Deposit SUI and automatically swap to USDC
2. Perform on-demand swaps from SUI to USDC
3. Calculate expected swap amounts with slippage protection

### Key Components

- `cetus_integration.move`: Core integration with Cetus CLMM protocol
- `testnet_example.move`: Example functions showing how to use the integration
- Updated wallet functions that work with actual Cetus pools

### Using the Integration

To use the Cetus integration for deposits and swaps, you'll need to pass the Cetus pool and global config objects:

```move
use njangi::njangi_circle;
use sui::clock;
use sui::coin::Coin;
use sui::sui::SUI;

// Deposit to custody wallet with auto-swap
njangi_circle::deposit_with_swap<USDC_TYPE>(
    wallet,             // CustodyWallet object
    sui_coin,           // SUI coin to deposit
    pool,               // Cetus Pool<SUI, USDC> object
    global_config,      // Cetus GlobalConfig object
    clock,              // Clock object
    ctx                 // TxContext
);
```

### Testnet Configuration

On Sui Testnet, use the following Cetus objects:

- CLMM Package ID: `0x0868b71c0cba55bf0faf6c40df8c179c67a4d0ba0e79965b68b3d72d7dfbf666`
- GlobalConfig ID: `0x6f4149091a5aea0e818e7243a13adcfb403842d670b9a2089de058512620687a`
- SUI-USDC Pool ID: `0x7cae71e021eb857516cb7af9c0e08e25f9335201c94ee209c50026dc52ef7972`

### CLI Commands

Use the following command to deposit and swap:

```bash
sui client call \
  --package <YOUR_PUBLISHED_PACKAGE_ID> \
  --module testnet_example \
  --function deposit_and_swap \
  --args <CUSTODY_WALLET_ID> <SUI_COIN_ID> <POOL_ID> <GLOBAL_CONFIG_ID> <CLOCK_ID> \
  --type-args "<USDC_TYPE>" \
  --gas-budget 10000000
```

Where:
- `<USDC_TYPE>` is: `0x9e89965f542887a8f0383451ba553fedf62c04e4dc68f60dec5b8d7ad1436bd6::usdc::USDC`
- `<CUSTODY_WALLET_ID>` is your wallet's object ID
- `<SUI_COIN_ID>` is the coin you want to deposit and swap
- `<POOL_ID>` is the SUI-USDC pool ID
- `<GLOBAL_CONFIG_ID>` is the Cetus global config ID
- `<CLOCK_ID>` is the system clock object (usually `0x6`)

## Troubleshooting

If your swap fails, check:

1. Pool liquidity - the pool may not have enough liquidity
2. Slippage settings - high price volatility can cause slippage failures
3. Gas budget - swaps require more gas than simple transactions
4. Coin type - make sure you're using the correct USDC type on testnet

## Security Considerations

1. The contract uses slippage protection to ensure users get a fair price
2. All contracts have been updated to handle swap failures gracefully
3. Users can customize slippage tolerance through the wallet config 

## Constants Handling

Since Move constants don't support visibility modifiers, this implementation uses getter functions for constants in the core module. This allows other modules to access these values without duplicating constants across modules.

For example, instead of:
```move
public const MEMBER_STATUS_ACTIVE: u8 = 0;
```

We use:
```move
const MEMBER_STATUS_ACTIVE: u8 = 0;
public fun member_status_active(): u8 { MEMBER_STATUS_ACTIVE }
```

This pattern is used throughout the codebase to maintain consistency while enabling proper module separation.

## Struct Field Access

For similar reasons, struct fields that need to be accessed across modules have getter functions:

```move
public struct UsdAmounts has store, drop {
    contribution_amount: u64, 
    security_deposit: u64,
    target_amount: option::Option<u64>
}

public fun get_usd_contribution_amount(usd_amounts: &UsdAmounts): u64 {
    usd_amounts.contribution_amount
}
``` 