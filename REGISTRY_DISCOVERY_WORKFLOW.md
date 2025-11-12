# WhatsApp Registry Discovery Workflow

Complete end-to-end guide from deploying a new WhatsApp contract to automatic registry discovery.

## Phase 1: Deploy New Contract

### Step 1: Build and Deploy

```bash
cd move
sui client publish --gas-budget 500000000 \
  --json > deployment.json

# Extract package ID
export NEW_PACKAGE_ID=$(cat deployment.json | jq -r '.result.packageId')
echo "New Package: $NEW_PACKAGE_ID"
```

### Step 2: Initialize Registry

Use the deployment coin to fund the registry initialization:

```bash
sui client call \
  --package "$NEW_PACKAGE_ID" \
  --module whatsapp_integration \
  --function init_registry \
  --gas-coin 0x0649a5b68500d73a7fb57bf2b4e9983562da1af970b7fd6fe24e247b7c9c7ed5 \
  --gas-budget 10000000 \
  --json > init_registry.json

# Extract the created registry object ID
export NEW_REGISTRY_ID=$(cat init_registry.json | jq -r '.result.effects.created[0].reference.objectId')
echo "New Registry: $NEW_REGISTRY_ID"
```

**Example Output:**
```
New Package: 0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc
New Registry: 0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459
```

## Phase 2: Automatic Discovery

### How the Discovery Works

```
1. App Starts
   ↓
2. initializeWhatsAppRegistries() called
   ↓
3. discoverWhatsAppRegistries('testnet') executed
   ↓
4. Query deployment coin transaction history
   ├─ GET transactions from: 0x0649a5b68500d73a7fb57bf2b4e9983562da1af970b7fd6fe24e247b7c9c7ed5
   ├─ Scan objectChanges in each transaction
   └─ Look for: type='created' AND objectType includes 'WhatsAppLinksRegistry'
   ↓
5. Extract from matching transactions:
   ├─ objectId → registryObjectId
   └─ objectType.split('::')[0] → packageId
   ↓
6. Store in WHATSAPP_REGISTRIES
   ↓
7. Available to app immediately
```

### Automatic Discovery Data Flow

**Transaction in Blockchain:**
```json
{
  "effects": {
    "created": [{
      "reference": {
        "objectId": "0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459"
      }
    }],
    "objectChanges": [{
      "type": "created",
      "objectType": "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc::whatsapp_integration::WhatsAppLinksRegistry",
      "objectId": "0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459"
    }]
  }
}
```

**Parsing:**
```typescript
// In discoverWhatsAppRegistries()
const registryId = change.objectId;
  // → "0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459"

const packageId = change.objectType.split('::')[0];
  // → "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc"
```

**Result in Memory:**
```typescript
WHATSAPP_REGISTRIES.testnet = [
  {
    packageId: "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc",
    registryObjectId: "0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459",
    description: "Auto-discovered testnet registry from package 0xd0f586ee...",
    deprecated: false
  }
]
```

## Phase 3: Use in Application

### Automatic Integration

Once discovered, the registry is automatically available:

```typescript
// In any component or API route
import { getActiveWhatsAppRegistries, getCurrentWhatsAppRegistry } from '@/services/whatsapp-registry-service';

// Get all active registries (includes auto-discovered ones)
const registries = getActiveWhatsAppRegistries('testnet');

// Get the current (latest non-deprecated) registry
const current = getCurrentWhatsAppRegistry('testnet');

// Result automatically includes the newly discovered registry!
```

### Usage in API Routes

```typescript
// api/whatsapp/admin-link-circle.ts
export async function POST(request: Request) {
  const { circleId, phoneNumber, network = 'testnet' } = await request.json();
  
  // Automatically gets discovered registries
  const registries = getActiveWhatsAppRegistries(network);
  
  // Use the current registry (auto-discovered or manual fallback)
  const currentRegistry = getCurrentWhatsAppRegistry(network);
  
  // Call Move function with correct registry ID
  // No env var update needed!
}
```

### Usage in Frontend

```typescript
// components/WhatsAppCircleIntegration.tsx
async function handleLinkCircle(circleId: string) {
  const currentNetwork = getCurrentNetwork();
  
  const response = await fetch('/api/whatsapp/admin-link-circle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      circleId,
      phoneNumber: userPhone,
      network: currentNetwork // Tells API which network registries to use
    })
  });
  
  // API automatically uses discovered registry for that network
}
```

## Phase 4: Verification

### Check Discovery Logs

When app starts, you'll see:

```
🚀 Initializing WhatsApp registries from blockchain...
🔍 Discovering WhatsApp registries for testnet from coin 0x0649a5b6...
✅ Discovered registry: 0x9e203f7d... from package 0xd0f586ee...
✅ Discovered registry: 0x65fad7ce... from package 0x2ee55011...
📱 WhatsApp Active Registries (testnet): {
  count: 2,
  registries: [
    { packageId: '0x2ee55011...', registryId: '0x65fad7ce...', description: '...' },
    { packageId: '0xd0f586ee...', registryId: '0x9e203f7d...', description: '...' }
  ]
}
✅ Updated testnet registries: 2 total
✅ WhatsApp registries initialized successfully
```

### Manual Verification

```typescript
// In browser console or server-side code
import { getAllWhatsAppRegistries, getActiveWhatsAppRegistries } from '@/services/whatsapp-registry-service';

// See all registries (deprecated + active)
console.log(getAllWhatsAppRegistries('testnet'));

// See only active
console.log(getActiveWhatsAppRegistries('testnet'));

// See current (being used)
import { getCurrentWhatsAppRegistry } from '@/services/whatsapp-registry-service';
console.log(getCurrentWhatsAppRegistry('testnet'));
```

### On-Chain Verification

Visit SuiScan to verify:

```
https://suiscan.xyz/testnet/object/0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459
```

Should show:
- **Owner**: Shared
- **Type**: `0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc::whatsapp_integration::WhatsAppLinksRegistry`
- **First Transaction**: `init_registry` call

## Complete Timeline

### Step-by-Step: Deploy to Automatic Use

```
Time    │ Action                           │ Status
────────┼──────────────────────────────────┼──────────────────
T+0     │ Deploy contract                  │ 🔨 Building
T+10s   │ Get new package ID               │ ✅ 0xd0f586ee...
T+15s   │ Call init_registry               │ 🔨 Executing
T+20s   │ Transaction confirmed            │ ✅ Registry created
        │                                  │    ID: 0x9e203f7d...
T+30s   │ App startup                      │ 🚀 Starting
T+35s   │ initializeWhatsAppRegistries()   │ 🔄 Discovering...
T+45s   │ Query deployment coin history    │ ✅ Found 2 registries
T+50s   │ Update WHATSAPP_REGISTRIES       │ ✅ In memory
T+51s   │ Ready to use                     │ ✅ New registry active!
────────┴──────────────────────────────────┴──────────────────
         Total time: ~51 seconds from deploy to active
         Manual updates needed: 0
```

## Comparison: Before vs After

### Before (Manual)

```bash
# After deploying new contract
export NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID=0xd0f586ee...
export NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID=0x9e203f7d...

# Update on Heroku
heroku config:set -a njangionchain NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID=0xd0f586ee...
heroku config:set -a njangionchain NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID=0x9e203f7d...

# Redeploy app
git push heroku main

# Risk: Forgot to set env vars → "Package object does not exist"
```

### After (Automatic)

```bash
# After deploying new contract
# ✅ That's it! App will discover on next startup

# Just redeploy when ready
git push heroku main

# App automatically discovers all registries
# ✅ No env vars to update
# ✅ No risk of forgetting
# ✅ Supports multiple versions automatically
```

## Troubleshooting Discovery

### Registry Not Found

**Check 1: Verify transaction exists**
```bash
# Find the init_registry transaction in deployment coin history
https://suiscan.xyz/testnet/object/0x0649a5b68500d73a7fb57bf2b4e9983562da1af970b7fd6fe24e247b7c9c7ed5/tx-blocks
```

**Check 2: Verify objectType format**
```json
{
  "objectType": "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc::whatsapp_integration::WhatsAppLinksRegistry"
}
// Must include ::WhatsAppLinksRegistry at the end
```

**Check 3: Force refresh**
```typescript
import { forceRefreshWhatsAppRegistries } from '@/lib/whatsapp-registry-init';

await forceRefreshWhatsAppRegistries();
console.log('Refreshed!');
```

## Performance Considerations

- **RPC Queries**: 1 per 24 hours (cached)
- **Discovery Time**: ~5-10 seconds (first startup)
- **Memory Footprint**: ~1KB per registry
- **Fallback**: If discovery fails, uses env vars

## Next Enhancements

1. **Event Listening**: Subscribe to `WhatsAppRegistryCreated` events for real-time discovery
2. **Periodic Refresh**: Auto-refresh every X hours
3. **Multiple Coins**: Support discovery from multiple deployment coins
4. **Version Tracking**: Store deployment timestamps with each registry

