# WhatsApp Registry Auto-Discovery System

## Overview

The WhatsApp Registry Auto-Discovery system automatically discovers all WhatsApp registry IDs from blockchain transaction history. Instead of manually tracking and updating environment variables every time you deploy a new contract, the system queries the deployment coin's transaction history to find all `init_registry` transactions and extract the created `WhatsAppLinksRegistry` object IDs.

## How It Works

### Architecture

```
Deployment Coin
    ↓ (transaction history)
    ↓ Query all transactions
    ↓
Scan for WhatsAppLinksRegistry creations
    ↓ (in objectChanges)
    ↓ Extract registryId + packageId
    ↓
WHATSAPP_REGISTRIES array
    ↓ (in-memory cache)
    ↓
Auto-discover function handles all networks
    ↓ (testnet & mainnet)
```

### Key Components

1. **`whatsapp-registry-service.ts`**:
   - `discoverWhatsAppRegistries(network)`: Queries deployment coin for registries
   - `refreshRegistriesFromBlockchain()`: Updates both testnet and mainnet registries
   - `DEPLOYMENT_COINS`: Config for testnet/mainnet deployment coins

2. **`whatsapp-registry-init.ts`**:
   - `initializeWhatsAppRegistries()`: Called on app startup
   - `forceRefreshWhatsAppRegistries()`: Manual refresh for testing/debugging
   - Includes 24-hour caching to avoid excessive RPC queries

3. **Configuration**:
   - `NEXT_PUBLIC_TESTNET_DEPLOYMENT_COIN`: Testnet coin ID (default provided)
   - `NEXT_PUBLIC_MAINNET_DEPLOYMENT_COIN`: Mainnet coin ID (from env vars)

## Usage

### On App Startup (Next.js App Router)

Add to your root layout or initialization function:

```typescript
// app/layout.tsx or similar
import { initializeWhatsAppRegistries } from '@/lib/whatsapp-registry-init';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Initialize WhatsApp registries on startup
  try {
    await initializeWhatsAppRegistries();
  } catch (error) {
    console.error('Failed to initialize registries:', error);
    // App continues with fallback env vars
  }

  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
```

### Manual Refresh

```typescript
import { forceRefreshWhatsAppRegistries } from '@/lib/whatsapp-registry-init';

// Manually refresh registries (e.g., after deploying new contract)
await forceRefreshWhatsAppRegistries();
console.log('Registries updated!');
```

### Querying Registries

The auto-discovered registries are automatically available through existing functions:

```typescript
import { getActiveWhatsAppRegistries, getCurrentWhatsAppRegistry } from '@/services/whatsapp-registry-service';

// Get active registries (both manual and auto-discovered)
const registries = getActiveWhatsAppRegistries('testnet');
// Returns both manually configured AND auto-discovered registries

// Get the current registry (latest non-deprecated)
const current = getCurrentWhatsAppRegistry('testnet');
```

## Setting Up Deployment Coins

### Testnet

Default coin is already configured:
```
0x0649a5b68500d73a7fb57bf2b4e9983562da1af970b7fd6fe24e247b7c9c7ed5
```

You can override with env var:
```bash
NEXT_PUBLIC_TESTNET_DEPLOYMENT_COIN=0x<your-coin-id>
```

### Mainnet

Set the deployment coin in Heroku config or .env:

```bash
NEXT_PUBLIC_MAINNET_DEPLOYMENT_COIN=0x<your-mainnet-coin-id>
```

Then call `initializeWhatsAppRegistries()` to discover mainnet registries.

## Finding Your Deployment Coin ID

Your deployment coin is the one you use to fund `init_registry` transactions.

### On Testnet

```bash
# After deploying new contract and calling init_registry, check your gas coin
sui client gas

# Should show something like:
# ...
# Coin ID: 0x0649a5b68500d73a7fb57bf2b4e9983562da1af970b7fd6fe24e247b7c9c7ed5
```

Or view on SuiScan:
```
https://suiscan.xyz/testnet/object/<coin-id>/tx-blocks
```

## How It Finds Registry IDs

1. **Query all transactions** from the deployment coin
2. **Scan objectChanges** in each transaction
3. **Find created WhatsAppLinksRegistry objects**:
   - Extract `objectId` → registry ID
   - Extract `objectType` → package ID
4. **Group by package** → Handle multiple deployments
5. **Merge with manual config** → Keep env vars as source of truth

### Example Discovery Output

```
🔍 Discovering WhatsApp registries for testnet from coin 0x0649a5b6...
✅ Discovered registry: 0x65fad7ce... from package 0x2ee55011...
✅ Discovered registry: 0x9e203f7d... from package 0xd0f586ee...
📱 WhatsApp Active Registries (testnet): {
  count: 2,
  registries: [
    { packageId: '0x2ee55011...', registryId: '0x65fad7ce...', description: '...' },
    { packageId: '0xd0f586ee...', registryId: '0x9e203f7d...', description: '...' }
  ]
}
✅ Updated testnet registries: 2 total
```

## Caching

- **Default TTL**: 24 hours
- **Cache invalidation**: Automatic after 24 hours or manual with `forceRefreshWhatsAppRegistries()`
- **Benefits**: Reduces RPC load while keeping data relatively fresh
- **Behavior**: First call after startup always queries blockchain (initial discovery)

## Fallback Behavior

If auto-discovery fails:
1. System logs error but continues
2. Uses env vars as fallback:
   - `NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID`
   - `NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID`
3. App remains functional with manually configured registries

## Troubleshooting

### No registries discovered

Check:
1. ✅ Deployment coin ID is correct
2. ✅ Coin has transaction history with `init_registry` calls
3. ✅ RPC endpoint is accessible
4. ✅ Network is correct (testnet vs mainnet)

### Stale registries

Force refresh:
```typescript
await forceRefreshWhatsAppRegistries();
```

### Wrong registries being used

Check env vars take precedence:
```typescript
import { getAllWhatsAppRegistries } from '@/services/whatsapp-registry-service';
console.log(getAllWhatsAppRegistries('testnet'));
// Shows both auto-discovered and manually configured
```

## Future Enhancements

1. **Periodic auto-refresh**: Call discovery every X hours in background
2. **Event listening**: Listen for new `init_registry` transactions and update immediately
3. **Deprecation tracking**: Automatically mark old registries as deprecated based on age
4. **Registry versioning**: Track deployment history with timestamps
5. **Multi-chain support**: Extend to other networks beyond testnet/mainnet

## Summary

| Aspect | Before | After |
|--------|--------|-------|
| **Setup** | Manual env vars | Auto-discovery from blockchain |
| **Scaling** | Error-prone (easy to forget) | Automatic (query never forgets) |
| **Migrations** | Update 3-4 env vars per deploy | No updates needed |
| **Fallback** | N/A | Still works with env vars |
| **RPC Queries** | None | 1 query per 24 hours |
| **Maintenance** | High | Low |

