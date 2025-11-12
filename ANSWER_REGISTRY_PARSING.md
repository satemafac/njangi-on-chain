# How Registry IDs are Detected: Your Transaction Explained

## Your Question
> How are the registry IDs now being detected? Here's how the init transaction looks - are we parsing it properly?

## Answer: Yes! ✅

We are parsing your transaction **correctly**. Here's exactly how:

## Your init_registry Transaction

```json
{
  "transaction": {
    "kind": "ProgrammableTransaction",
    "transactions": [{
      "MoveCall": {
        "package": "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc",
        "module": "whatsapp_integration",
        "function": "init_registry"
      }
    }]
  },
  "effects": {
    "status": "success",
    "objectChanges": [
      {
        "type": "created",
        "sender": "0xdde1086c98c6023db8e3d8267992e4c9aeba3d0271f6bac85dc2f6daa8301c77",
        "owner": { "Shared": { "initial_shared_version": 349180745 } },
        "objectType": "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc::whatsapp_integration::WhatsAppLinksRegistry",
        "objectId": "0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459",
        "version": 349180745,
        "digest": "62oLFPRXXxQeywbSCriiFcqwssCnVpubjXC4n5VsiY1f"
      },
      {
        "type": "mutated",
        "objectType": "0x2::coin::Coin<0x2::sui::SUI>",
        "objectId": "0x0649a5b68500d73a7fb57bf2b4e9983562da1af970b7fd6fe24e247b7c9c7ed5"
      }
    ]
  }
}
```

## How We Parse It

### Step 1: Identify the Right Change

We look through `objectChanges` for:
```
type === "created"  AND
objectType includes "WhatsAppLinksRegistry"
```

✅ **Found it:**
```json
{
  "type": "created",
  "objectType": "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc::whatsapp_integration::WhatsAppLinksRegistry",
  "objectId": "0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459"
}
```

### Step 2: Extract Package ID

```typescript
// objectType format: "0xpackageid::module::struct"
const objectType = "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc::whatsapp_integration::WhatsAppLinksRegistry";

const packageId = objectType.split('::')[0];
// Split result: ["0xd0f586ee...", "whatsapp_integration", "WhatsAppLinksRegistry"]
// [0] = "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc"  ✅
```

### Step 3: Extract Registry ID

```typescript
// The objectId field IS the registry ID
const registryId = change.objectId;
// = "0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459"  ✅
```

### Step 4: Store

```typescript
discoveredRegistries.push({
  packageId: "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc",
  registryObjectId: "0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459",
  description: "Auto-discovered testnet registry from package 0xd0f586ee...",
  deprecated: false
});
```

## The Code

```typescript
// File: src/services/whatsapp-registry-service.ts

for (const tx of transactions.data) {
  if (tx.objectChanges) {
    for (const change of tx.objectChanges) {
      // ← We're checking each objectChange in objectChanges[]
      
      if (
        change.type === 'created' &&                        // ← Check: is it "created"?
        change.objectType?.includes('WhatsAppLinksRegistry')  // ← Check: is it WhatsAppLinksRegistry?
      ) {
        const registryId = change.objectId;           // ← Extract objectId
        const packageId = change.objectType?.split('::')[0];  // ← Extract packageId from objectType

        if (registryId && packageId && packageId !== '0x2') {
          discoveredRegistries.push({
            packageId,          // "0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc"
            registryObjectId: registryId,  // "0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459"
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

## What We Check

| Check | Your Transaction | Status |
|-------|------------------|--------|
| `change.type === 'created'` | ✅ type: "created" | **PASS** |
| `objectType.includes('WhatsAppLinksRegistry')` | ✅ objectType ends with "WhatsAppLinksRegistry" | **PASS** |
| `registryId` exists | ✅ objectId: "0x9e203f7d..." | **PASS** |
| `packageId` exists | ✅ objectType starts with "0xd0f586ee..." | **PASS** |
| `packageId !== '0x2'` | ✅ "0xd0f586ee..." ≠ "0x2" | **PASS** |

**Result: Registry is discovered! ✅**

## Why This Works

### The objectType Format

The `objectType` field from Sui has a specific format:

```
0x{package}::{module}::{struct}
│   │          │        │
│   │          │        └─ Struct name
│   │          └─────────── Module name
│   └───────────────────── Package ID (what we need!)
└─────────────────────────── Starts with 0x
```

In your case:
```
0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc :: whatsapp_integration :: WhatsAppLinksRegistry
└─────────────────────────────────────────────────────────────────────┬─────────────────────────────────────────┘
                                    │                                        │
                            We extract this                      This identifies the type
                            with .split('::')[0]
```

### Why objectId is the Registry

When Move calls `transfer::share_object()` in `init_registry`, it:
1. Creates a new `WhatsAppLinksRegistry` object
2. Assigns it a unique ID (`objectId`)
3. Marks it as shared (so anyone can read it)
4. Includes it in `objectChanges` with type "created"

The `objectId` field is the registry's unique identifier on-chain. This is what we use to query it later.

## Complete Flow for Your Transaction

```
1. You call init_registry on package 0xd0f586ee...
   │
2. Function executes and creates WhatsAppLinksRegistry
   │
3. Object is assigned ID: 0x9e203f7d...
   │
4. Object is shared (added to object pool)
   │
5. Blockchain returns effects with objectChanges
   │
6. Our code finds objectChanges[].created entries
   │
7. Matches: type="created" + objectType includes "WhatsAppLinksRegistry"
   │
8. Extracts:
   ├─ registryId = 0x9e203f7d...
   └─ packageId = 0xd0f586ee...
   │
9. Stores in WHATSAPP_REGISTRIES
   │
10. App can immediately use it! ✅
```

## Expected Log Output

When discovery runs:

```
🔍 Discovering WhatsApp registries for testnet from coin 0x0649a5b6...
✅ Discovered registry: 0x9e203f7d... from package 0xd0f586ee...
✅ Discovered registry: 0x65fad7ce... from package 0x2ee55011...
📱 WhatsApp Active Registries (testnet): {
  count: 2,
  registries: [
    { packageId: '0x2ee55011...', registryId: '0x65fad7ce...', description: 'Previous testnet package (before unlink fix)' },
    { packageId: '0xd0f586ee...', registryId: '0x9e203f7d...', description: 'Auto-discovered testnet registry from package 0xd0f586ee...' }
  ]
}
✅ Updated testnet registries: 2 total
```

## Why We're Confident It Works

1. ✅ **Correct structure**: Your transaction has the exact format we expect
2. ✅ **Type matching**: objectType clearly states "WhatsAppLinksRegistry"
3. ✅ **Package extraction**: Split on `::` gives us the correct package ID
4. ✅ **Registry ID**: objectId is the unique identifier we need
5. ✅ **Transaction verified**: Status is "success", not "failure"

## What Makes This Better Than Manual

| Aspect | Before | After |
|--------|--------|-------|
| Set env vars | 3-4 times per deploy | Never needed |
| Risk of mistakes | High (forget one var) | None (automatic) |
| Time to integrate | ~5 minutes + git push | 0 minutes (auto) |
| Support multiple versions | Must manage manually | Automatic |
| Scalability | Breaks at 5+ versions | Works for unlimited |

## Bottom Line

**Your new registry is automatically detected from the blockchain.** The code correctly:
- ✅ Identifies `init_registry` transactions
- ✅ Finds created `WhatsAppLinksRegistry` objects
- ✅ Extracts package ID from objectType
- ✅ Extracts registry ID from objectId
- ✅ Stores both in memory
- ✅ Makes available to your app

No manual work needed! Just deploy and the app discovers it on startup. 🚀

