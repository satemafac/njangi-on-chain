# WhatsApp Registry Auto-Discovery: Quick Reference

## TL;DR

Your new registry ID is **automatically discovered** from the blockchain. No manual env var updates needed! 🎉

## Your New Registry

```
Package ID: 0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc
Registry ID: 0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459
Network: testnet
Discovery Coin: 0x0649a5b68500d73a7fb57bf2b4e9983562da1af970b7fd6fe24e247b7c9c7ed5
```

## How We Find It

```
Your init_registry transaction
        ↓
        objectChanges[].created
        ↓
        objectType: "0xd0f586ee...::whatsapp_integration::WhatsAppLinksRegistry"
        ↓
        Extract: Package ID = "0xd0f586ee..." (before ::)
        Extract: Registry ID = "0x9e203f7d..." (objectId)
        ↓
        Auto-discovered! ✅
```

## One-Line Parsing

```typescript
// Extract from transaction objectType
const objectType = "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc::whatsapp_integration::WhatsAppLinksRegistry";

const packageId = objectType.split('::')[0];
// → "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc"

const registryId = change.objectId;
// → "0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459"
```

## What We Match

In transaction `objectChanges`:

```json
{
  "type": "created",                    ← We look for "created"
  "objectType": "0xd0f586ee...::whatsapp_integration::WhatsAppLinksRegistry",  ← Contains "WhatsAppLinksRegistry"
  "objectId": "0x9e203f7d..."           ← Registry ID we extract
}
```

## Transaction Flow

```
1. You call: sui client call --function init_registry
   ↓
2. Blockchain executes and creates WhatsAppLinksRegistry object
   ↓
3. Transaction effects include objectChanges with "created" entries
   ↓
4. Our code scans objectChanges
   ↓
5. Finds: type="created" + objectType includes "WhatsAppLinksRegistry"
   ↓
6. Extracts: packageId + registryId
   ↓
7. Stored in WHATSAPP_REGISTRIES (in memory)
   ↓
8. Available to app immediately (next startup or via forceRefresh)
```

## How Parsing Works

### Input: Full objectType

```
0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc::whatsapp_integration::WhatsAppLinksRegistry
```

### Operation: Split by `::`

```
.split('::')
    ↓
[0] = 0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc  ← PACKAGE ID
[1] = whatsapp_integration                                                   ← MODULE
[2] = WhatsAppLinksRegistry                                                  ← STRUCT
```

### Output: Extracted Values

```javascript
{
  packageId: "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc",
  registryObjectId: "0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459",
  description: "Auto-discovered testnet registry from package 0xd0f586ee..."
}
```

## Files Involved

| File | Purpose |
|------|---------|
| `src/services/whatsapp-registry-service.ts` | Core parsing & discovery logic |
| `src/lib/whatsapp-registry-init.ts` | Initialization & caching |
| `WHATSAPP_REGISTRY_AUTO_DISCOVERY.md` | Full documentation |
| `REGISTRY_PARSING_GUIDE.md` | Detailed parsing explanation |
| `REGISTRY_DISCOVERY_WORKFLOW.md` | End-to-end workflow guide |

## Key Code Locations

### Discovery Function

```typescript
// src/services/whatsapp-registry-service.ts

export async function discoverWhatsAppRegistries(network: NetworkType) {
  // Query deployment coin transaction history
  // Look for created WhatsAppLinksRegistry objects
  // Extract packageId and registryObjectId
  // Return array of discovered registries
}
```

### Initialization

```typescript
// src/lib/whatsapp-registry-init.ts

export async function initializeWhatsAppRegistries() {
  // Called on app startup
  // Calls refreshRegistriesFromBlockchain()
  // Includes 24-hour caching
}
```

### Usage

```typescript
// Anywhere in your app
import { getActiveWhatsAppRegistries, getCurrentWhatsAppRegistry } from '@/services/whatsapp-registry-service';

const current = getCurrentWhatsAppRegistry('testnet');
// Automatically includes auto-discovered registry!
```

## Verification Checklist

- ✅ Transaction type is "created" (not "mutated")
- ✅ objectType includes "WhatsAppLinksRegistry"
- ✅ objectId is the registry ID
- ✅ objectType starts with "0x..." (package ID)
- ✅ Deployment coin ID is correct (0x0649a5b6...)
- ✅ Network matches (testnet)
- ✅ No filtering by system package (0x2)

## Debug: See All Registries

```typescript
import { getAllWhatsAppRegistries } from '@/services/whatsapp-registry-service';

// Print what was discovered and what's manually configured
console.log(getAllWhatsAppRegistries('testnet'));

// Example output:
[
  {
    packageId: '0x2ee55011...',
    registryObjectId: '0xc4f2bfc4...',
    description: 'Previous testnet package (before unlink fix)',
    deprecated: true
  },
  {
    packageId: '0xd0f586ee...',        ← YOUR NEW REGISTRY!
    registryObjectId: '0x9e203f7d...',
    description: 'Auto-discovered testnet registry from package 0xd0f586ee...',
    deprecated: false
  }
]
```

## Common Questions

### Q: Do I need to set env vars?
**A:** No! Registry is auto-discovered from blockchain. Env vars are optional fallback only.

### Q: When is it discovered?
**A:** On app startup (or when you call `forceRefreshWhatsAppRegistries()`). 24-hour cache after that.

### Q: What if discovery fails?
**A:** App uses manually configured env vars as fallback. No downtime, just less automatic.

### Q: How long does discovery take?
**A:** ~5-10 seconds. Only happens once per 24 hours due to caching.

### Q: Can I have multiple registries?
**A:** Yes! All auto-discovered registries are stored. Latest non-deprecated is used as "current".

### Q: What's the deployment coin?
**A:** The Sui coin used to fund your `init_registry` transaction (0x0649a5b6... for testnet).

## Visual: Data Flow

```
Sui Blockchain
├─ Deployment Coin (0x0649a5b6...)
│  └─ Transaction History
│     ├─ init_registry TX 1
│     │  └─ objectChanges.created
│     │     └─ WhatsAppLinksRegistry (0x65fad7ce...)  ← Old registry
│     ├─ init_registry TX 2
│     │  └─ objectChanges.created
│     │     └─ WhatsAppLinksRegistry (0x9e203f7d...)  ← YOUR NEW REGISTRY
│     └─ ...more TXs...
│
↓ Query & Parse
│
WHATSAPP_REGISTRIES (In Memory)
├─ testnet:
│  ├─ [0] { packageId: 0x2ee55011..., registryId: 0x65fad7ce..., deprecated: true }
│  └─ [1] { packageId: 0xd0f586ee..., registryId: 0x9e203f7d..., deprecated: false }  ← CURRENT
│
↓ Available to App
│
getCurrentWhatsAppRegistry('testnet')
└─ Returns: [1] (the newest, non-deprecated one)
   └─ Ready to use in link/unlink operations ✅
```

## Deployment Coin Tracking

| Network | Deployment Coin ID | Where Used |
|---------|-------------------|-----------|
| testnet | 0x0649a5b68500d73a7fb57bf2b4e9983562da1af970b7fd6fe24e247b7c9c7ed5 | All init_registry calls for testnet |
| mainnet | From env var: NEXT_PUBLIC_MAINNET_DEPLOYMENT_COIN | All init_registry calls for mainnet |

The deployment coin is just used to **fund** init_registry transactions. Its transaction history is where we find all created registries.

## Next: Using the Registry

Now that your registry is auto-discovered:

1. ✅ No env var updates needed
2. ✅ Link/Unlink operations use it automatically
3. ✅ Supports multiple versions seamlessly
4. ✅ Backward compatible with old registries
5. ✅ Ready to deploy another version anytime

Just call your link/unlink endpoints and they'll use the latest registry! 🚀

