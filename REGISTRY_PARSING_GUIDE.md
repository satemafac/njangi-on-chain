# WhatsApp Registry ID Parsing Guide

## How Registry IDs are Detected from init_registry Transactions

### Transaction Structure

When you call `init_registry`, the Sui blockchain creates a new `WhatsAppLinksRegistry` object and returns transaction effects like this:

```json
{
  "effects": {
    "status": "success",
    "objectChanges": [
      {
        "type": "created",
        "objectType": "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc::whatsapp_integration::WhatsAppLinksRegistry",
        "objectId": "0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459"
      }
    ]
  }
}
```

### Parsing Logic

Our code scans `objectChanges` and extracts registry information from created `WhatsAppLinksRegistry` objects:

```
objectChanges[]
    ↓
    For each change:
        ↓
        ✓ change.type === "created"
        ✓ change.objectType includes "WhatsAppLinksRegistry"
        ↓
        Extract: objectId
        Extract: objectType.split('::')[0]
        ↓
        registryObjectId = objectId
        packageId = objectType.split('::')[0]
```

### Parsing Example

**Input Transaction:**
```json
{
  "objectType": "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc::whatsapp_integration::WhatsAppLinksRegistry",
  "objectId": "0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459"
}
```

**Processing:**

```
objectType = "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc::whatsapp_integration::WhatsAppLinksRegistry"
            ↓
            .split('::')
            ↓
            [0] = "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc"
            [1] = "whatsapp_integration"
            [2] = "WhatsAppLinksRegistry"

packageId = [0] = "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc"
```

**Output Registry Config:**

```javascript
{
  packageId: "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc",
  registryObjectId: "0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459",
  description: "Auto-discovered testnet registry from package 0xd0f586ee...",
  deprecated: false
}
```

## Code Implementation

```typescript
// File: src/services/whatsapp-registry-service.ts

for (const tx of transactions.data) {
  if (tx.objectChanges) {
    for (const change of tx.objectChanges) {
      // Look for created WhatsAppLinksRegistry objects
      // objectType format: "0xpackageid::module::struct"
      if (
        change.type === 'created' &&
        change.objectType?.includes('WhatsAppLinksRegistry')
      ) {
        const registryId = change.objectId;
        // Extract package ID (first part before ::)
        const packageId = change.objectType?.split('::')[0];

        if (registryId && packageId && packageId !== '0x2') {
          discoveredRegistries.push({
            packageId, // Already just the package ID
            registryObjectId: registryId,
            description: `Auto-discovered ${network} registry from package ${packageId.slice(0, 10)}...`,
            deprecated: false,
          });
          
          console.log(`✅ Discovered registry: ${registryId.slice(0, 10)}... from package ${packageId.slice(0, 10)}...`);
        }
      }
    }
  }
}
```

## Key Points

1. **objectType Format**: `0x<packageId>::<module>::<struct>`
   - We extract the package ID by taking everything before the first `::`
   
2. **Multiple Registries**: Each `init_registry` call creates a new `WhatsAppLinksRegistry` object
   - Each gets its own unique `objectId` (registry ID)
   - All from the same package share the same `packageId`

3. **Validation**: We check:
   - ✅ `type === 'created'` - Only count newly created objects
   - ✅ `objectType.includes('WhatsAppLinksRegistry')` - Only count registry objects
   - ✅ `packageId !== '0x2'` - Filter out system packages

4. **Deduplication**: If same registry is discovered multiple times, only the latest is kept (by auto-discovery order)

## Example: Multiple Deployments

If you deployed the contract twice with different packages:

**Deployment 1:**
```
Package: 0x2ee55011e9d3c27a2743f83fb9f4498de8cdb6078cc175bec03362326f9ec1a1
Registry: 0xc4f2bfc4e0022cef04e71ce7f9aecf9b3dfc3dc13085f15e2dbf5e4ace1bde12
```

**Deployment 2:**
```
Package: 0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc
Registry: 0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459
```

**Auto-Discovery Result:**
Both registries are discovered and stored, with the newer one being the "current" (not deprecated).

## Verification

To verify the parsing is working correctly:

1. **Check logs** when `initializeWhatsAppRegistries()` is called:
   ```
   ✅ Discovered registry: 0x9e203f7d... from package 0xd0f586ee...
   ```

2. **Query discovered registries**:
   ```typescript
   import { getActiveWhatsAppRegistries } from '@/services/whatsapp-registry-service';
   
   console.log(getActiveWhatsAppRegistries('testnet'));
   // Shows all auto-discovered registries
   ```

3. **Manual verification** on SuiScan:
   - Go to: `https://suiscan.xyz/testnet/object/<registry-id>/tx-blocks`
   - Look for `init_registry` transaction
   - Verify the objectId matches our discovered ID

## Troubleshooting

### Registry Not Discovered

Check:
1. ✅ Deployment coin ID is correct
2. ✅ Transaction is in the coin's history
3. ✅ `objectType` contains `WhatsAppLinksRegistry`
4. ✅ `type` is `"created"` (not `"mutated"`)
5. ✅ Package ID is not `0x2` (system package filter)

### Wrong Package ID

Verify the parsing by checking the `objectType` in the transaction:
- Should be: `0x<package>::whatsapp_integration::WhatsAppLinksRegistry`
- Everything before `::` is the package ID

### Multiple Registries from Same Package

If you called `init_registry` multiple times with the same package:
- Each call creates a NEW registry object
- All share the same package ID
- All are stored and can be marked as deprecated manually if needed

## Future: Event-Based Discovery

Currently we query transaction history. In the future, we could listen to events:

```typescript
// Listen for CircleLinked events emitted by whatsapp_integration module
const unsubscribe = suiClient.subscribeEvent({
  filter: {
    MoveEvent: {
      package: packageId,
      module: 'whatsapp_integration',
      eventType: 'WhatsAppRegistryCreated', // If we emit such an event
    }
  },
  onMessage: (event) => {
    // Extract registry ID from event
    // Update registries in real-time
  }
});
```

This would provide real-time updates instead of batch discovery.

