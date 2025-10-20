# Member Event Enhancements

## Overview
Enhanced the `MemberJoined` event in the SUI smart contracts to provide comprehensive member information, making it easier for the dashboard to detect and display member status without additional API calls.

## Changes Made

### 1. Move Smart Contract (`njangi_circles.move`)

#### Enhanced Event Structure
```move
public struct MemberJoined has copy, drop {
    circle_id: ID,
    member: address,
    position: Option<u64>,
    member_status: u8,                  // Member status (0=active, 1=pending, 2=suspended, 3=exited)
    currency_type: String,              // Currency code (e.g., "USD", "XAF", "NGN")
    contribution_amount_local: u64,     // Contribution amount in local currency
    security_deposit_local: u64,        // Security deposit in local currency
    deposit_paid: bool,                 // Whether the member has paid their deposit
    joined_at: u64,                     // Timestamp when member joined
}
```

#### Updated Event Emissions
All three locations where `MemberJoined` events are emitted now include full member details:
1. **Circle Creation** (line ~395): When admin creates a circle and becomes first member
2. **Single Member Approval** (line ~1140): When admin approves a member to join
3. **Batch Member Approval** (line ~1194): When admin approves multiple members at once

### 2. Dashboard TypeScript Interface (`dashboard.tsx`)

#### Enhanced Interface
```typescript
interface MemberJoinedEvent {
  circle_id: string;
  member: string;
  position?: number;
  member_status: number;                  // Member status (0=active, 1=pending, 2=suspended, 3=exited)
  currency_type: string;                  // Currency code (e.g., "USD", "XAF", "NGN")
  contribution_amount_local: string;      // Contribution amount in local currency
  security_deposit_local: string;         // Security deposit in local currency
  deposit_paid: boolean;                  // Whether the member has paid their deposit
  joined_at: string;                      // Timestamp when member joined
}
```

#### New Helper Constants
```typescript
const MEMBER_STATUS = {
  ACTIVE: 0,
  PENDING: 1,
  SUSPENDED: 2,
  EXITED: 3
} as const;
```

## Benefits

### 1. **Immediate Member Detection**
- Dashboard can now detect when a user has been accepted to a circle **immediately** when the `MemberJoined` event is emitted
- No need to wait for the first contribution to see member status

### 2. **Rich Event Filtering**
You can now filter events by:
```typescript
// Filter only active members
const activeMembers = events.filter(e => 
  e.parsedJson.member_status === MEMBER_STATUS.ACTIVE
);

// Filter members who haven't paid deposit yet
const unpaidMembers = events.filter(e => 
  !e.parsedJson.deposit_paid
);

// Filter by currency type
const usdCircles = events.filter(e => 
  e.parsedJson.currency_type === 'USD'
);
```

### 3. **Reduced API Calls**
- All essential member information is available in a single event
- No need for additional queries to determine member status, currency, or deposit status
- Faster dashboard loading and better UX

### 4. **Better Status Tracking**
The dashboard can now:
- Show pending members waiting to make deposits
- Display currency-specific information per circle
- Track deposit payment status accurately
- Show member join timestamps

## Usage Examples

### Example 1: Display Member Status Badge
```typescript
const getMemberStatusBadge = (event: MemberJoinedEvent) => {
  switch (event.member_status) {
    case MEMBER_STATUS.ACTIVE:
      return <Badge color="green">Active</Badge>;
    case MEMBER_STATUS.PENDING:
      return <Badge color="yellow">Pending</Badge>;
    case MEMBER_STATUS.SUSPENDED:
      return <Badge color="red">Suspended</Badge>;
    case MEMBER_STATUS.EXITED:
      return <Badge color="gray">Exited</Badge>;
  }
};
```

### Example 2: Filter User's Active Memberships
```typescript
const getUserActiveCircles = (events: any[], userAddress: string) => {
  return events
    .filter(event => {
      const data = event.parsedJson as MemberJoinedEvent;
      return (
        data.member === userAddress &&
        data.member_status === MEMBER_STATUS.ACTIVE
      );
    })
    .map(event => event.parsedJson.circle_id);
};
```

### Example 3: Display Deposit Requirements
```typescript
const DepositRequirement = ({ event }: { event: MemberJoinedEvent }) => {
  const amount = Number(event.security_deposit_local) / 100; // Convert cents to dollars
  return (
    <div>
      <p>Security Deposit Required: {formatCurrency(amount, event.currency_type)}</p>
      <p>Status: {event.deposit_paid ? '✅ Paid' : '⏳ Pending'}</p>
    </div>
  );
};
```

## Migration Notes

### For Frontend Developers
1. Update event listeners to handle new fields
2. Use `MEMBER_STATUS` constants for status comparisons
3. Update UI components to display additional member information
4. Remove workarounds that were waiting for contribution events

### For Backend/Blockchain Developers
1. After deploying updated contracts, the new events will be emitted automatically
2. Old events (pre-deployment) will still have the old structure
3. Consider backward compatibility when processing historical events

## Testing Checklist

- [ ] Create a new circle and verify admin's `MemberJoined` event includes all fields
- [ ] Approve a new member and check the event structure
- [ ] Approve multiple members at once and verify all events are complete
- [ ] Filter events by `member_status` in the dashboard
- [ ] Display deposit payment status correctly
- [ ] Show currency-specific information in the UI
- [ ] Verify `joined_at` timestamp is displayed correctly

## Next Steps

1. **Deploy Updated Contracts**: Deploy the enhanced `njangi_circles` module to the network
2. **Update Frontend**: Implement UI components that leverage the new event fields
3. **Add Filters**: Create filtering options in the dashboard based on member status
4. **Monitor Events**: Watch for the new event structure in production
5. **Document**: Update user-facing documentation with new member status indicators

## Related Files

- `/move/sources/njangi_circles.move` - Enhanced event struct and emissions
- `/move/sources/njangi_circle_config.move` - Config getters for currency info
- `/src/pages/dashboard.tsx` - Updated TypeScript interface and constants

## Support

If you encounter issues with event detection:
1. Verify the contract deployment includes the enhanced event structure
2. Check browser console for event parsing errors
3. Ensure the `MemberJoinedEvent` interface matches the contract definition
4. Review the member status constants are correctly used in filters


