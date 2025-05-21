# Pyth Price Oracle Integration for Njangi

This document explains how the Pyth Network price oracle integration works with the Njangi protocol to validate stablecoin deposits.

## Overview

Pyth Network provides real-time price data for a variety of assets. By integrating Pyth, Njangi can:

1. Validate that stablecoin deposits meet the required USD value
2. Get accurate market prices for different tokens
3. Ensure price data is fresh and reliable

## Smart Contract Integration

The integration consists of two main components:

1. **Price Validator Module**: A new Move module (`njangi_price_validator.move`) that validates token prices
2. **Custody Wallet Updates**: Modified custody functions to use price validation

### Dependencies

The project uses the following Pyth dependencies:

```toml
[dependencies]
Pyth = { git = "https://github.com/pyth-network/pyth-crosschain.git", subdir = "target_chains/sui/contracts", rev = "sui-contract-testnet" }
Wormhole = { git = "https://github.com/wormhole-foundation/wormhole.git", subdir = "sui/wormhole", rev = "sui-upgrade-testnet" }
```

## Price Feed IDs

Pyth uses specific price feed IDs for different assets:

- ETH/USD: `0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace`
- USDC/USD: `0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a`
- USDT/USD: `0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b`
- SUI/USD: `0x5450dc9536f233ea863ce9f89191a6f755f80e393ba2be2057dbabda0cc407c9`
- AFSUI/USD: `0xd213e2929116af56c3ce71a1acee874f1dd03f42567b552085fa9d8ce8ce7134`

## Contract Addresses

### Mainnet
- Pyth State ID: `0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8`
- Wormhole State ID: `0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c`

### Testnet
- Pyth State ID: `0x243759059f4c3111179da5878c12f68d612c21a8d54d85edc86164bb18be1c7c`
- Wormhole State ID: `0x31358d198147da50db32eda2562951d53973a0c0ad5ed738e9b17d88b213d790`

## Frontend Integration

The frontend integration uses the `@pythnetwork/pyth-sui-js` package to:

1. Fetch price feed updates from Hermes
2. Update price feeds in the transaction
3. Pass the price info object to the smart contract

## How to Use

### In Smart Contracts

To validate a deposit:

```move
use njangi::njangi_custody;
use pyth::price_info::PriceInfoObject;

// ...

// Validate deposit with price oracle
njangi_custody::internal_store_security_deposit<USDC>(
    custody_wallet,
    coin,
    member_address,
    required_amount, // minimum USD value required
    price_info_object, // provided by frontend
    clock,
    ctx
);
```

### In Frontend

To create a transaction that validates a deposit:

```typescript
import { depositWithPriceValidation } from "./pythIntegration";

// Example usage
async function makeDeposit() {
  const result = await depositWithPriceValidation(
    wallet,
    circleId,
    walletId,
    coinObjectId,
    BigInt(1000000), // $1 USD in microdollars
    "0x2::usdc::USDC", // Token type
    true // Use mainnet
  );
  
  if (result.success) {
    console.log("Deposit successful:", result.txId);
  } else {
    console.error("Deposit failed:", result.error);
  }
}
```

## Important Notes

1. **Always update price feeds from the client**: Don't hardcode calls to `pyth::update_single_price_feed` in your contracts.
2. **Maximum price age**: Price data older than 60 seconds will be rejected.
3. **Decimal handling**: The price validator handles differences in decimal places between tokens.

## References

- [Pyth Network Documentation](https://docs.pyth.network/price-feeds/use-real-time-data/sui)
- [Pyth Price Feed IDs](https://pyth.network/developers/price-feed-ids) 