# WhatsApp Registry Management

This guide explains how to manage WhatsApp registry versions when deploying updated contracts.

## Overview

The WhatsApp registry service (`src/services/whatsapp-registry-service.ts`) manages multiple registry versions across different package deployments, similar to how `circle-service.ts` handles multiple package IDs.

## Key Concepts

### Registry vs Package
- **Package ID**: Changes every time you redeploy the contract code (new module, new functions)
- **Registry Object ID**: The blockchain object that stores data - **persists across deployments** when referencing the same registry

### Why Multiple Registries?
When you deploy a new package version (e.g., after fixing the `unlink_circle` bug), the Move type system treats the registry differently:
- Old package → Registry Type A
- New package → Registry Type B
- **Type A ≠ Type B → Type Mismatch Error**

Solution: Create a new registry with the new package, marking the old one as `deprecated`.

## Environment Variables

Add these to your `.env.local`:

### Testnet
```bash
# Current active package and registry
NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID=0x2ee55011e9d3c27a2743f83fb9f4498de8cdb6078cc175bec03362326f9ec1a1
NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID=0x[NEW_REGISTRY_OBJECT_ID]

# Bot backend
# (Same values - needed for bot service)
WHATSAPP_PACKAGE_ID=0x2ee55011e9d3c27a2743f83fb9f4498de8cdb6078cc175bec03362326f9ec1a1
WHATSAPP_REGISTRY_ID=0x[NEW_REGISTRY_OBJECT_ID]
```

### Mainnet
```bash
NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID=0x...
NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID=0x...
```

## Usage Examples

### Get Current Registry
```typescript
import { getCurrentWhatsAppRegistry, getCurrentWhatsAppPackageId, getCurrentWhatsAppRegistryId } from '@/services/whatsapp-registry-service';

// Get all registry info
const registry = getCurrentWhatsAppRegistry();
// { packageId: '0x...', registryObjectId: '0x...', description: '...' }

// Get just the IDs
const packageId = getCurrentWhatsAppPackageId();
const registryId = getCurrentWhatsAppRegistryId();
```

### Check Registry Status
```typescript
import { isRegistryDeprecated, getMigrationSuggestion } from '@/services/whatsapp-registry-service';

// Check if using old registry
if (isRegistryDeprecated(oldPackageId)) {
  console.warn('Using deprecated registry');
  const newRegistry = getMigrationSuggestion(oldPackageId);
  console.log('Migrate to:', newRegistry);
}
```

### Validate Configuration
```typescript
import { validateWhatsAppRegistry, logWhatsAppRegistry } from '@/services/whatsapp-registry-service';

// Validate setup
const validation = validateWhatsAppRegistry();
if (!validation.isValid) {
  console.error('Configuration errors:', validation.errors);
}

// Log current config (for debugging)
logWhatsAppRegistry();
```

## When to Add New Registries

Add a new registry entry when:

1. **After deploying updated contract code**:
   - New package ID is generated
   - Old registry still contains data
   - Create new registry with old package marked as `deprecated: true`

2. **Workflow**:
   ```bash
   # 1. Deploy new package
   sui client publish --gas-budget 20000000
   # → New package ID: 0x2ee55011...
   
   # 2. Initialize new registry
   sui client call \
     --package 0x2ee55011... \
     --module whatsapp_integration \
     --function init_registry \
     --gas-budget 10000000
   # → New registry ID: 0x[NEW_REGISTRY_ID]
   
   # 3. Update whatsapp-registry-service.ts
   # Mark old entry as deprecated
   # Add new entry to WHATSAPP_REGISTRIES[testnet]
   
   # 4. Update environment variables
   # .env.local
   # /whatsapp-bot-backend/.env.local
   
   # 5. Restart services
   pkill -f "npm run dev"
   npm run dev
   ```

## File Structure

```
src/services/
├── whatsapp-registry-service.ts    # Registry management (NEW)
├── network-config.ts               # Network configuration
└── circle-service.ts               # Circle package management (similar pattern)
```

## API Reference

### Core Functions
- `getCurrentWhatsAppRegistry()` - Get active registry config
- `getCurrentWhatsAppPackageId()` - Get active package ID
- `getCurrentWhatsAppRegistryId()` - Get active registry object ID

### Query Functions
- `getAllWhatsAppRegistries()` - Get all registries (including deprecated)
- `getActiveWhatsAppRegistries()` - Get active registries only
- `getRegistryByPackageId(packageId)` - Find registry by package
- `getRegistryByObjectId(registryId)` - Find registry by object ID

### Utility Functions
- `isRegistryDeprecated(packageId)` - Check if registry is deprecated
- `getMigrationSuggestion(packageId)` - Get suggested migration target
- `validateWhatsAppRegistry()` - Validate configuration
- `logWhatsAppRegistry()` - Log current config (debugging)

## Troubleshooting

### Type Mismatch Error
**Error**: `CommandArgumentError { arg_idx: 0, kind: TypeMismatch }`

**Cause**: Using registry from one package with code from different package

**Solution**:
1. Create new registry with new package
2. Update environment variables
3. Restart services
4. Use new registry for all transactions

### No Active Registry
**Error**: `No active WhatsApp registry configured for testnet`

**Cause**: Missing or invalid environment variables

**Solution**:
```bash
# Update .env.local with:
NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID=0x...
NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID=0x...

# Or use legacy names:
NEXT_PUBLIC_WHATSAPP_PACKAGE_ID=0x...
NEXT_PUBLIC_WHATSAPP_REGISTRY_ID=0x...
```

## Best Practices

1. ✅ Always mark old registries as `deprecated: true`
2. ✅ Update environment variables before restarting
3. ✅ Keep historical registries for reference/debugging
4. ✅ Log configuration at app startup
5. ✅ Validate configuration before making transactions
6. ✅ Use same registry ID for both frontend and bot backend

7. ❌ Don't delete old registry entries
8. ❌ Don't forget to mark as deprecated
9. ❌ Don't mix registry IDs across deployments
10. ❌ Don't restart without updating env variables
