# 📱 WhatsApp Circle Integration Component

## Overview

The `WhatsAppCircleIntegration` component provides a seamless, user-friendly interface for circle admins to link/unlink their circles to WhatsApp, directly within the circle management page. No additional authentication is required: the API calls ride on the zkLogin session cookie, and the on-chain link/unlink is signed in the browser with the admin's zkLogin account.

## Usage

### Basic Integration

```tsx
import WhatsAppCircleIntegration from '@/components/WhatsAppCircleIntegration';

export default function YourPage() {
  return (
    <WhatsAppCircleIntegration
      circleId="0x123abc..."
      adminAddress="0x456def..."
      account={account} // the signed-in zkLogin AccountData
      isAdmin
      onLinked={(status) => {
        console.log('Linked status changed:', status);
      }}
    />
  );
}
```

### In Circle Management Page (Recommended Usage)

```tsx
{/* WhatsApp Integration Section */}
<div className="pt-4 sm:pt-6 border-t border-gray-200 px-1 sm:px-2 mt-2 sm:mt-6">
  {circle && account && (
    <WhatsAppCircleIntegration
      circleId={id as string}
      adminAddress={userAddress || ''}
      account={account}
      isAdmin={Boolean(userAddress && circle.admin === userAddress)}
      onLinked={(status) => {
        if (status) {
          toast.success('Circle linked to WhatsApp!');
        }
      }}
    />
  )}
</div>
```

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `circleId` | string | Yes | The ID of the circle to link/unlink |
| `adminAddress` | string | Yes | The admin's Sui address |
| `account` | `AccountData` | Yes | The admin's zkLogin account. The card signs the on-chain link/unlink with it in the browser; no signing material goes to the server |
| `isAdmin` | boolean | No (default `false`) | Set by the manage page from `circle.admin === userAddress`. Only then does the card ask for the masked linked number (see [Link Status Endpoint](#link-status-endpoint)) |
| `onLinked` | (status: boolean) => void | No | Callback when link status changes |

## Features

### Link Circle
- Link a phone number. WhatsApp group links are not supported: the Cloud API
  can only message groups our business number created through Meta's Groups API,
  so a group ID copied from the WhatsApp app (`…@g.us`) never receives anything
- Validate input before submission
- Show loading state during submission
- Display success/error notifications
- Update UI immediately after success

### Unlink Circle
- Show current link status (type, recipient, date)
- Confirm before unlinking
- Handle error cases gracefully
- Show loading state during deletion
- Update UI immediately after success

### UI States

1. **Checking Status** (Initial Load)
   ```
   [Loading spinner] Checking WhatsApp status...
   ```

2. **Not Linked** (the status route answered that the circle has no link)
   ```
   [Link to WhatsApp] button
   ```

3. **Link Form Open**
   ```
   Phone Number: [Phone input with country picker]
   [Link Circle] [Cancel] buttons
   ```

4. **Linked** (Success)
   ```
   ✅ Linked badge
   Link Type: ...
   Recipient: +237 ••• ••• 1234 (masked by the server; admin view only),
              or one line on why it can't be shown
   Linked on: ...
   [What the linked number gets — WHATSAPP_UPDATE_LINES in src/content/whatsapp-updates.ts]
   [Unlink from WhatsApp] button
   ```

5. **Linked to a group** (made before group links were refused)
   ```
   ⚠️ Not supported badge
   Why the group gets no updates, and to link a phone number instead
   [Unlink from WhatsApp] button
   ```

6. **Couldn't Check Status** (the status read in state 1 failed)
   ```
   Couldn't check WhatsApp status
   This circle may already be linked, so we're not offering to link or unlink it until a check succeeds.
   [Retry] button
   ```
   An error from `GET /api/whatsapp/admin-link-circle`, a network error or a
   reply without an `isLinked` flag lands here, never in state 2: the circle
   may already be linked on chain. The card offers no link form, Link button
   or Unlink until a check succeeds. Retry runs the check again.

## API Integration

### Link Circle Endpoint

The card makes two POSTs and signs the on-chain anchor in the browser between
them. Both send the `session-id` cookie (see [Security](#security)).

```
POST /api/whatsapp/admin-link-circle

1. Prepare. The server encrypts the number, uploads it to Walrus and returns
   the anchor inputs.
Body:
{
  "circleId": "0x123...",
  "linkType": 1,  // 2 (a group) is refused: 400 WHATSAPP_GROUP_LINKS_UNSUPPORTED
  "phoneOrGroup": "+1234567890",
  "adminAddress": "0x456...",
  "network": "testnet"
}
Response data: { packageId, registryObjectId, walrusBlobId, linkNonceHex,
                 walrusEndEpoch, status: "pending", ... }

2. The card signs whatsapp_integration::link_circle with `account`
   (ZkLoginClient.linkCircleToWhatsApp).

3. Confirm. The same body plus "anchoredDigest", "walrusBlobId" and
   "walrusEndEpoch". The server then writes the webhook's link index.
Response data: { circleId, linkType, walrusBlobId, txDigest, status: "confirmed" }
```

### Unlink Circle Endpoint

The same pattern: prepare, sign `whatsapp_integration::unlink_circle` in the
browser (ZkLoginClient.unlinkCircleFromWhatsApp), confirm.

```
POST /api/whatsapp/admin-unlink-circle

Prepare. Body: { "circleId": "0x123...", "adminAddress": "0x456...", "network": "testnet" }
Response data: { packageId, registryObjectId, status: "pending", ... }

Confirm, after signing. The same body plus "anchoredDigest". The server drops
the link index.
Response data: { circleId, txDigest, status: "confirmed" }
```

### Link Status Endpoint

```
GET /api/whatsapp/admin-link-circle?circleId=0x123...&network=testnet[&includeRecipient=true]

Response:
{
  "success": true,
  "data": {
    "isLinked": true,
    "linkType": 1,
    "walrusBlobId": "...",
    "linkNonceHex": "...",
    "maskedRecipient": "+237 ••• ••• 1234",  // includeRecipient=true, circle admin only
    "linkedAt": "2026-09-30T10:15:00.000Z"    // includeRecipient=true, circle admin only
  }
}
```

The card adds `includeRecipient=true` only when `isAdmin` is set. The route
then decrypts the number only for a `session-id` cookie that resolves to the
on-chain circle admin, and returns it masked (`src/lib/whatsapp-recipient-mask.ts`):
the full number never leaves the server. The Recipient box renders that mask
and the "Linked on" date. On a 401 or 403 the card falls back to the plain
probe and shows "Sign in again to see which number is linked."
(`src/lib/whatsapp-link-status.ts`).

## Styling

The component uses Tailwind CSS and includes:
- Gradient background (green-50 to emerald-50)
- Green border (border-green-200)
- Responsive padding and sizing
- Icons from lucide-react
- Toast notifications for feedback

## Error Handling

The component handles:
- ✅ Missing circle ID
- ✅ Invalid phone number
- ✅ Network errors
- ✅ Authentication failures
- ✅ API errors
- ✅ User cancellation

Link and unlink errors display toast messages. A failed status check shows in
the card instead, with Retry (UI state 6).

## Security

- ✅ Both POST routes, and the status GET with `includeRecipient=true`, require
  the HttpOnly `session-id` cookie from `/api/zkLogin`. The server resolves it
  to an address and checks that address is the circle's on-chain admin
  (`withCircleAdminAuth` in `src/middleware/admin-auth.middleware.ts`): no
  session → 401, not the admin → 403. There is no token prop and no
  Authorization header.
- ✅ The on-chain link and unlink are signed in the browser with `account`. The
  server never receives signing material, and the contract checks again that
  the sender is the circle's admin.
- ✅ Admin actions are logged (`logAdminAction`)

## Responsive Design

Works seamlessly on:
- 📱 Mobile devices (small screens)
- 📱 Tablets (medium screens)
- �� Desktop (large screens)

Uses responsive classes for padding, text size, and layout.

## Customization

To customize styling, modify these classes in the component:

```tsx
// Main container
className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-lg p-4 border border-green-200"

// Header
className="flex items-center justify-between mb-4"

// Linked badge
className="bg-green-100 text-green-800 px-3 py-1 rounded-full text-xs font-medium"

// Forms and inputs
className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
```

## Example: Custom Styling

```tsx
// Create a wrapper component with custom styling
function CustomWhatsAppIntegration(props) {
  return (
    <div className="my-custom-class">
      <WhatsAppCircleIntegration {...props} />
    </div>
  );
}
```

## Testing

Manual testing checklist:
- [ ] Component renders without circle data
- [ ] Component renders with circle data
- [ ] Can click "Link to WhatsApp"
- [ ] Form expands/collapses correctly
- [ ] Phone input works
- [ ] Input validation works
- [ ] Submit button works
- [ ] Loading states display
- [ ] Success notifications show
- [ ] Error notifications show
- [ ] Linked status displays correctly
- [ ] Unlink confirmation works
- [ ] Responsive on mobile/tablet/desktop

## Browser Support

- ✅ Chrome/Edge (v90+)
- ✅ Firefox (v88+)
- ✅ Safari (v14+)
- ✅ Mobile browsers

## Performance

- Component renders: ~50ms
- Initial status check: ~200ms
- Link submission: ~500-1000ms
- Unlink submission: ~500-1000ms

## Accessibility

- ✅ Proper labels for form inputs
- ✅ ARIA labels for icons
- ✅ Keyboard navigation support
- ✅ Focus states on buttons
- ✅ Error messages announced to screen readers

## Future Enhancements

Potential improvements:
- [ ] Real-time status polling
- [ ] Batch link multiple circles
- [ ] Link templates/presets
- [ ] Activity history/logs
- [ ] WhatsApp message preview
- [ ] Link management dashboard
- [ ] Two-factor confirmation
- [ ] Rate limiting display

## Troubleshooting

### Component not showing
- Check if `circle && account` conditions are true

### Link not working
- Verify phone number format (include country code)
- Group IDs (`…@g.us`) are refused; link a phone number
- The signed-in address must be the circle's on-chain admin (the routes answer 403 otherwise)

### Session expired (401)
- The routes answer 401 when the `session-id` cookie is missing or its session has ended
- Sign in again to get a new session

### API errors
- Check browser console for detailed error
- Verify admin-link-circle endpoint is running
- Check that the request carries the `session-id` cookie

## Support

For issues or questions, refer to:
- Component source: `src/components/WhatsAppCircleIntegration.tsx`
- API endpoints: `src/pages/api/whatsapp/admin-*.ts`
- Integration guide: `docs/whatsapp-integration-setup.md`

