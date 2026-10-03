# TypeMismatch Error: Fixed ✅

> Written 2025-11; the ids below were current then. Since 2026-03 the current
> package and registry ids come only from env (the hardcoded fallback is gone),
> and nothing discovers registries on chain. See [Next Deployment](#next-deployment).

## The Problem

You were getting this error:
```
CommandArgumentError { arg_idx: 0, kind: TypeMismatch } in command 0
```

When trying to link a circle.

## Root Cause

**Package and Registry Mismatch:**

```
Transaction was calling:
├─ package: 0x2ee55011...  (OLD package)
│  function: link_circle
│
└─ with registry: 0x9e203f7d...  (NEW registry - created by 0xd0f586ee...)
```

**Move's type system is strict:**
- The registry object type: `0xd0f586ee...::whatsapp_integration::WhatsAppLinksRegistry`
- The function package: `0x2ee55011...::whatsapp_integration::link_circle`
- These don't match! → TypeMismatch error

## The Fix

Updated the fallback registry configuration to use the **current deployment**:

```typescript
// BEFORE (Wrong - mismatched packages)
packageId: '0x2ee55011e9d3c27a2743f83fb9f4498de8cdb6078cc175bec03362326f9ec1a1'  // OLD
registryObjectId: '0x65fad7ceeb6a960af0702280052c85b9e4e467f33531e9b8d3f08c6244bf0150'  // Also OLD

// AFTER (Correct - matching pair)
packageId: '0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc'  // NEW
registryObjectId: '0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459'  // NEW
```

## Why This Matters

Move's type system requires **matching pairs**:

```
Package A
  └─ function link_circle
     └─ expects: RegistryType from Package A

↓ ↓ ↓

Must use:
├─ link_circle from Package A
└─ Registry created by Package A (same package, same types)

NOT:
├─ link_circle from Package A
└─ Registry created by Package B ❌ TYPE MISMATCH!
```

## Registry Configuration

### Current Testnet Configuration

```javascript
WHATSAPP_REGISTRIES.testnet = [
  {
    // DEPRECATED - Old deployment (before unlink fix)
    packageId: '0x2ee55011...',
    registryObjectId: '0xc4f2bfc4...',
    deprecated: true
  },
  {
    // CURRENT - New deployment (with unlink fix)
    packageId: '0xd0f586ee...',           ← Updated ✅
    registryObjectId: '0x9e203f7dd2...',  ← Updated ✅
    deprecated: false
  }
]
```

### Priority Order

When linking/unlinking circles:
1. **Environment variables** (if set)
   - `NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID`
   - `NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID`
2. **Env var fallbacks** (legacy names)
   - `NEXT_PUBLIC_WHATSAPP_PACKAGE_ID`
   - `NEXT_PUBLIC_WHATSAPP_REGISTRY_ID`
   - `SUI_WHATSAPP_LINKS_REGISTRY_ID`
3. **Nothing.** The hardcoded fallback this note fixed (`0xd0f586ee...` /
   `0x9e203f7d...`) was removed in 2026-03. With none of the vars above set,
   there is no current registry.

## What Changed

File: `src/services/whatsapp-registry-service.ts`

```diff
  registryObjectId: process.env.NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID 
    || process.env.NEXT_PUBLIC_WHATSAPP_REGISTRY_ID 
    || process.env.SUI_WHATSAPP_LINKS_REGISTRY_ID 
-   || '0x65fad7ceeb6a960af0702280052c85b9e4e467f33531e9b8d3f08c6244bf0150',
+   || '0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459',

  packageId: process.env.NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID 
    || process.env.NEXT_PUBLIC_WHATSAPP_PACKAGE_ID 
-   || '0x2ee55011e9d3c27a2743f83fb9f4498de8cdb6078cc175bec03362326f9ec1a1',
+   || '0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc',
```

## Testing the Fix

Now when you link a circle:

1. ✅ Frontend sends link request with `network: 'testnet'`
2. ✅ Backend calls `getActiveWhatsAppRegistries('testnet')`
3. ✅ Gets matching pair:
   - Package: `0xd0f586ee...`
   - Registry: `0x9e203f7d...`
4. ✅ Calls `link_circle` from correct package
5. ✅ Passes registry from same package
6. ✅ Type check passes ✅
7. ✅ Transaction succeeds! 🎉

## Why We Keep the Old Registry

The deprecated registry is kept because:
- ✅ Circles linked with old package might still need querying
- ✅ Can look up historical links
- ✅ Backward compatibility
- ✅ Migration path is clear (deprecated flag shows which is current)

## Next Deployment

There is no auto-discovery: the app reads the current pair only from env.
After a fresh publish, which needs a new registry:

1. `move/build_and_test.sh` writes the new package id to
   `NEXT_PUBLIC_<NET>_WHATSAPP_PACKAGE_ID` in `.env.local`.
2. `scripts/bootstrap-package.mjs` calls `init_registry` and writes the new
   registry id to `NEXT_PUBLIC_<NET>_WHATSAPP_REGISTRY_ID`. It keeps the
   current value only if that value is a live shared registry of the new
   package's lineage. The old registry's type comes from the old lineage, so
   it is replaced: nothing to blank by hand. (Until 2026-10 the script skipped
   the call for any value starting with `0x`, which paired the new package with
   the old registry, the mismatch above.)
3. Set both ids in the Vercel env (Production and Preview) and redeploy.
   Next.js inlines `NEXT_PUBLIC_*` at build time, so a running deployment
   keeps the old pair until it is rebuilt.

## Summary

| Item | Value |
|------|-------|
| **Error** | TypeMismatch in link_circle call |
| **Cause** | Package/registry mismatch |
| **Fix** | Updated fallback to current deployment IDs |
| **New Package** | `0xd0f586ee...` |
| **New Registry** | `0x9e203f7d...` |
| **Status** | ✅ FIXED |

**Try linking a circle now - it should work!** 🚀

