# Njangi Circle with Cetus DEX Integration

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