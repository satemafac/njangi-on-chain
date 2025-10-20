# Circle Package ID Fix

## Problem
When attempting to delete a circle created with an **old package ID**, the dashboard was using the **new package ID** from `.env.local`, causing errors like:

```
Cannot delete: Unable to find required wallet data. The circle may be in an inconsistent state. 
Details: No wallet ID found in events for this circle.
```

This occurred because:
1. Circles created with old package IDs have their wallet events under the old package ID
2. The deletion process was only querying events using the current package ID
3. Cross-package-ID compatibility was missing for delete operations

## Solution
We now **track the package ID per circle** and use it for all operations on that circle:

### 1. **Circle Interface Enhancement** (`src/pages/dashboard.tsx`)
- Added `packageId?: string` field to the `Circle` interface
- This stores the package ID that was used to create each specific circle

### 2. **Package ID Extraction** (`src/pages/dashboard.tsx`)
In `processCircleObject()`, we now:
```typescript
// Extract package ID from object type (format: 0x<packageId>::module::Type)
let extractedPackageId: string | undefined;
if (objectData?.data?.type && typeof objectData.data.type === 'string') {
  const typeMatch = objectData.data.type.match(/^(0x[a-fA-F0-9]+)::/);
  if (typeMatch) {
    extractedPackageId = typeMatch[1];
    console.log(`📦 Extracted package ID ${extractedPackageId} from circle ${finalCircleId}`);
  }
}

return {
  // ... other fields
  packageId: extractedPackageId // Store package ID for this circle
};
```

### 3. **Pass Package ID During Deletion** (`src/pages/dashboard.tsx`)
In `deleteCircleWithZkLogin()`:
```typescript
// Find the circle to get its wallet ID and package ID
const circle = circles.find(c => c.id === circleId);
const walletId = circle?.walletId;
const circlePackageId = circle?.packageId; // Get the package ID this circle was created with

console.log("Using circle-specific package ID:", circlePackageId || '(using default)');

// Use the AuthContext's deleteCircle method with circle-specific package ID
const result = await authDeleteCircle(circleId, walletId, circlePackageId);
```

### 4. **AuthContext Updates** (`src/contexts/AuthContext.tsx`)
Updated function signature to accept package ID:
```typescript
const deleteCircle = async (circleId: string, walletId?: string, packageId?: string) => {
  // ...
  console.log(`AuthContext: Using package ID: ${packageId || '(default)'}`);
  
  const response = await fetch('/api/zkLogin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      action: 'deleteCircle', 
      account,
      circleId,
      walletId,
      packageId, // Pass the circle-specific package ID
      network: getCurrentNetwork()
    })
  });
}
```

### 5. **API Handler Updates** (`src/pages/api/zkLogin.ts`)

#### Extract Package ID from Request:
```typescript
const circleId = req.body.circleId;
let walletId = req.body.walletId;
const circlePackageId = req.body.packageId; // Circle-specific package ID from frontend

console.log(`Circle-specific package ID from frontend: ${circlePackageId || '(not provided)'}`);
```

#### Use Circle-Specific Package ID for Event Queries:
```typescript
// Use circle-specific package ID for querying events, fall back to default
const packageIdForEvents = circlePackageId || PACKAGE_ID;
console.log(`Querying wallet events with package ID: ${packageIdForEvents}`);

const events = await suiClient.queryEvents({
  query: {
    MoveEventType: `${packageIdForEvents}::njangi_custody::CustodyWalletCreated`
  },
  limit: 100
});
```

#### Use Circle-Specific Package ID for Transaction:
```typescript
// Use the package ID from the frontend if provided, otherwise fetch from blockchain
const packageIdToUse = circlePackageId || 
                       await getCirclePackageId(circleId, session.account!.userAddr) || 
                       getCurrentPackageId();

console.log(`Using package ID ${packageIdToUse} for circle ${circleId} (from frontend: ${!!circlePackageId})`);

txResult = await instance.sendTransaction(
  session.account!,
  (txb: Transaction) => {
    txb.setSender(session.account!.userAddr);
    
    txb.moveCall({
      target: `${packageIdToUse}::njangi_circles::delete_circle`,
      arguments: [
        txb.object(circleId),
        txb.object(walletId)
      ]
    });
  },
  { gasBudget: 100000000 }
);
```

## Benefits

1. ✅ **Cross-Package Compatibility**: Circles created with old package IDs can now be deleted successfully
2. ✅ **Efficient Event Queries**: Wallet events are queried from the correct package ID without unnecessary retries
3. ✅ **Future-Proof**: New package upgrades won't break operations on old circles
4. ✅ **Backward Compatible**: Falls back to blockchain queries if package ID is not available
5. ✅ **Performance**: Avoids unnecessary multi-package queries when package ID is known

## Testing

To verify the fix works:

1. **Create a circle** with the current package ID
2. **Upgrade the package** (update `.env.local` with new package ID)
3. **Try to delete the circle** created in step 1
4. **Result**: The deletion should succeed, using the old package ID automatically

## Related Files Modified

- `src/pages/dashboard.tsx` - Circle interface, package ID extraction, deletion flow
- `src/contexts/AuthContext.tsx` - deleteCircle function signature
- `src/pages/api/zkLogin.ts` - API handler for delete operation


