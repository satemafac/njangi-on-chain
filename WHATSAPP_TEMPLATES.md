# WhatsApp Message Templates Guide

## Account Info
- **WhatsApp Business Account ID**: 1907226853259565
- **Phone Number**: 15557862168
- **Display Name**: Njangi On-Chain (In Review)

## Template Creation Instructions

All templates should be created in the WhatsApp Business Manager at:
https://business.facebook.com/wa/manage/message-templates/

**Settings for ALL templates:**
- Category: `UTILITY`
- Language: `English (US)` / `en_US`
- Header: None (text only for simplicity)
- Footer: None (or optional short text)

**IMPORTANT**: 
- Variables (`{{1}}`, `{{2}}`, etc.) cannot be at the start or end of the template body.
- Use **Call to Action > Visit Website** button with **Dynamic URL** for circle links instead of putting URLs in the body text.

**Button Setup (for all templates):**
- Type of Action: `Visit website`
- Button Text: See table below per template
- URL Type: `Dynamic`
- Website URL: `https://njangionchain.com/circle/{{1}}`
- Sample URL: `https://njangionchain.com/circle/0x55f318fef22249265fd3fd6f4b2f5dcd0315f98e20352f053cf223842acd7201`

Note: The button `{{1}}` variable is separate from body variables. Body uses `{{1}}`, `{{2}}`, etc. and button uses its own `{{1}}`.

---

## Template 1: `circle_link`
**Trigger**: When admin links WhatsApp to a circle

**Body:**
```
✅ *Circle Connected!*

Your WhatsApp is now linked to *{{1}}*. You'll automatically receive updates for:

📅 Cycle deadlines & payouts
💰 Member contributions
👥 New members & changes
🔔 Important alerts

Powered by Njangi On-Chain.
```

**Body Variables:**
1. `{{1}}` = Circle name (sample: `Family Savings`)

**Button:**
- Text: `View Circle`
- URL: `https://njangionchain.com/circle/{{1}}` (Dynamic)

---

## Template 2: `circle_unlink`
**Trigger**: When admin unlinks WhatsApp from a circle

**Body:**
```
🔓 *Circle Disconnected*

Your WhatsApp has been unlinked from *{{1}}*. You will no longer receive automatic notifications for this circle.

To reconnect, visit the circle management page.

Thank you for using Njangi On-Chain.
```

**Body Variables:**
1. `{{1}}` = Circle name (sample: `Family Savings`)

**Button:**
- Text: `Reconnect Circle`
- URL: `https://njangionchain.com/circle/{{1}}/manage` (Dynamic)

---

## Template 3: `member_joins`
**Trigger**: When admin approves a new member

**Body:**
```
👋 *New Member Joined!*

Circle *{{1}}* has a new member: {{2}} ({{3}}).

They can now participate in the circle. Ensure they pay their security deposit to complete onboarding.

Welcome aboard!
```

**Body Variables:**
1. `{{1}}` = Circle name (sample: `Family Savings`)
2. `{{2}}` = Member name (sample: `John Doe`)
3. `{{3}}` = Member address (sample: `0x7c0b...b680`)

**Button:**
- Text: `View Circle`
- URL: `https://njangionchain.com/circle/{{1}}` (Dynamic)

---

## Template 4: `deposit_received`
**Trigger**: When member pays security deposit

**Body:**
```
🔒 *Security Deposit Received*

Member {{1}} has secured their position in *{{2}}*.

💎 Amount: {{3}}
📅 Date: {{4}}
👥 Deposits: {{5}}/{{6}} members

The funds are safely held in the circle's smart vault.
```

**Body Variables:**
1. `{{1}}` = Member name (sample: `John Doe`)
2. `{{2}}` = Circle name (sample: `Family Savings`)
3. `{{3}}` = Deposit amount (sample: `0.25 SUI`)
4. `{{4}}` = Deposit date (sample: `Dec 8, 2025`)
5. `{{5}}` = Deposit count (sample: `2`)
6. `{{6}}` = Total members (sample: `3`)

**Button:**
- Text: `View Deposits`
- URL: `https://njangionchain.com/circle/{{1}}/contribute` (Dynamic)

---

## Template 5: `deposit_returned`
**Trigger**: When security deposit is returned (member removed or circle ended)

**Body:**
```
💰 *Security Deposit Returned*

A security deposit has been returned from *{{1}}*.

💎 Amount: {{2}}
📅 Date: {{3}}

The funds have been released back to the member's wallet.
```

**Body Variables:**
1. `{{1}}` = Circle name (sample: `Family Savings`)
2. `{{2}}` = Deposit amount (sample: `0.25 SUI`)
3. `{{3}}` = Return date (sample: `Dec 8, 2025`)

**Button:**
- Text: `View Circle`
- URL: `https://njangionchain.com/circle/{{1}}` (Dynamic)

---

## Template 6: `recieve_contribution`
**Trigger**: When member makes a cycle contribution

**Body:**
```
💰 *Contribution Received*

Circle *{{1}}* — Cycle {{2}}: Member {{3}} has contributed!

💎 Amount: {{4}}
📊 Progress: {{5}}/{{6}} members paid

Currently waiting on {{7}} more to trigger payout to {{8}}.

Keep the momentum going!
```

**Body Variables:**
1. `{{1}}` = Circle name (sample: `Family Savings`)
2. `{{2}}` = Cycle number (sample: `1`)
3. `{{3}}` = Contributor name (sample: `John Doe`)
4. `{{4}}` = Contribution amount (sample: `0.19 SUI`)
5. `{{5}}` = Paid count (sample: `2`)
6. `{{6}}` = Total members (sample: `3`)
7. `{{7}}` = Remaining count (sample: `1`)
8. `{{8}}` = Current beneficiary (sample: `Jane Smith`)

**Button:**
- Text: `Contribute Now`
- URL: `https://njangionchain.com/circle/{{1}}/contribute` (Dynamic)

---

## Template 7: `member_removed`
**Trigger**: When admin removes a member

**Body:**
```
🚫 *Member Removed*

Member {{1}} ({{2}}) has been removed from *{{3}}*.

📅 Date: {{4}}

The rotation order has been updated accordingly.
```

**Body Variables:**
1. `{{1}}` = Member name (sample: `John Doe`)
2. `{{2}}` = Member address (sample: `0x7c0b...b680`)
3. `{{3}}` = Circle name (sample: `Family Savings`)
4. `{{4}}` = Removal date (sample: `Dec 8, 2025`)

**Button:**
- Text: `View Circle`
- URL: `https://njangionchain.com/circle/{{1}}` (Dynamic)

---

## Template 8: `order_changed`
**Trigger**: When admin reorders member rotation positions

**Body:**
```
🔄 *Rotation Order Updated*

The payout rotation for *{{1}}* has been rearranged.

👥 Members: {{2}}
📅 Updated: {{3}}

The new order determines who receives payouts next. Check the circle for details.
```

**Body Variables:**
1. `{{1}}` = Circle name (sample: `Family Savings`)
2. `{{2}}` = Member count (sample: `3`)
3. `{{3}}` = Update date (sample: `Dec 8, 2025`)

**Button:**
- Text: `View Circle`
- URL: `https://njangionchain.com/circle/{{1}}` (Dynamic)

---

## Template 9: `live_circle`
**Trigger**: When circle is activated (goes live)

**Body:**
```
🎉 *Circle is LIVE!*

Circle *{{1}}* has been activated!

👥 Members: {{2}}
💰 Contribution: {{3}}
📅 First payout: {{4}}

✅ Contributions are now open
🔄 The rotation cycle has officially begun

All members should ensure they contribute on time.
```

**Body Variables:**
1. `{{1}}` = Circle name (sample: `Family Savings`)
2. `{{2}}` = Member count (sample: `3`)
3. `{{3}}` = Contribution amount (sample: `$0.30`)
4. `{{4}}` = First payout date (sample: `Dec 15, 2025`)

**Button:**
- Text: `Contribute Now`
- URL: `https://njangionchain.com/circle/{{1}}/contribute` (Dynamic)

---

## Template 10: `payout_processed`
**Trigger**: When payout is distributed to beneficiary

**Body:**
```
💸 *Payout Distributed!*

Circle *{{1}}* — Cycle {{2}}: Payout sent to {{3}}.

💎 Amount: {{4}}
📅 Date: {{5}}

The next cycle is ready to begin. All members should prepare their contributions.
```

**Body Variables:**
1. `{{1}}` = Circle name (sample: `Family Savings`)
2. `{{2}}` = Cycle number (sample: `1`)
3. `{{3}}` = Recipient name (sample: `Jane Smith`)
4. `{{4}}` = Payout amount (sample: `0.57 SUI`)
5. `{{5}}` = Payout date (sample: `Dec 15, 2025`)

**Button:**
- Text: `Contribute Now`
- URL: `https://njangionchain.com/circle/{{1}}/contribute` (Dynamic)

---

## Template 11: `cycle_complete`
**Trigger**: When all contributions are collected for a cycle

**Body:**
```
🎊 *All Contributions Collected!*

Circle *{{1}}* — Cycle {{2}}: All members have contributed! The pot is ready.

🎯 Beneficiary: {{3}}
💎 Pot Size: {{4}}
📅 Date: {{5}}

Admin: Please trigger the payout to distribute funds.
```

**Body Variables:**
1. `{{1}}` = Circle name (sample: `Family Savings`)
2. `{{2}}` = Cycle number (sample: `1`)
3. `{{3}}` = Beneficiary name (sample: `Jane Smith`)
4. `{{4}}` = Pot size (sample: `0.57 SUI`)
5. `{{5}}` = Completion date (sample: `Dec 14, 2025`)

**Button:**
- Text: `Manage Circle`
- URL: `https://njangionchain.com/circle/{{1}}/manage` (Dynamic)

---

## Template 12: `contribution_reminder`
**Trigger**: 24 hours before payout date (automated)

**Body:**
```
⏰ *Contribution Reminder*

Circle *{{1}}* — Cycle {{2}} payout is approaching.

📅 Payout scheduled: {{3}}
⏳ Time remaining: ~{{4}} hours

The following members haven't contributed yet: {{5}}

Please ensure all contributions are made before the payout to keep the circle on track.
```

**Body Variables:**
1. `{{1}}` = Circle name (sample: `Family Savings`)
2. `{{2}}` = Cycle number (sample: `1`)
3. `{{3}}` = Payout date (sample: `Thu, Dec 15, 2025`)
4. `{{4}}` = Hours remaining (sample: `20`)
5. `{{5}}` = Pending member list (sample: `John Doe, Jane Smith`)

**Button:**
- Text: `Contribute Now`
- URL: `https://njangionchain.com/circle/{{1}}/contribute` (Dynamic)

---

## Template 13: `contribution_reminder_weekly`
**Trigger**: 24 hours before weekly payout (automated)

**Body:**
```
⏰ *Weekly Contribution Reminder*

Circle *{{1}}* — Week {{2}} payout is approaching.

📅 Payout scheduled: {{3}}
⏳ Time remaining: ~{{4}} hours

The following members haven't contributed yet: {{5}}

Please ensure all contributions are made before the weekly payout.
```

**Body Variables:**
1. `{{1}}` = Circle name (sample: `Family Savings`)
2. `{{2}}` = Cycle number (sample: `3`)
3. `{{3}}` = Payout date (sample: `Thu, Dec 12, 2025`)
4. `{{4}}` = Hours remaining (sample: `18`)
5. `{{5}}` = Pending member list (sample: `John Doe, Jane Smith`)

**Button:**
- Text: `Contribute Now`
- URL: `https://njangionchain.com/circle/{{1}}/contribute` (Dynamic)

---

## Template 14: `payout_trigger_reminder`
**Trigger**: 2 hours after payout time if not processed (automated)

**Body:**
```
🚨 *Payout Action Required*

Circle *{{1}}* — Cycle {{2}} payout is overdue.

⏰ Overdue by: ~{{3}} hours
🎯 Beneficiary: {{4}}
💎 Payout amount: {{5}}

Please trigger the payout to distribute funds. Delays affect member trust.
```

**Body Variables:**
1. `{{1}}` = Circle name (sample: `Family Savings`)
2. `{{2}}` = Cycle number (sample: `1`)
3. `{{3}}` = Hours overdue (sample: `4`)
4. `{{4}}` = Beneficiary name (sample: `Jane Smith`)
5. `{{5}}` = Payout amount (sample: `0.57 SUI`)

**Button:**
- Text: `Manage Circle`
- URL: `https://njangionchain.com/circle/{{1}}/manage` (Dynamic)

---

## Template 15: `payout_upcoming`
**Trigger**: When payout day is approaching

**Body:**
```
📅 *Upcoming Payout*

Circle *{{1}}* — Cycle {{2}} payout is scheduled.

🎯 Beneficiary: {{3}} ({{4}})
💎 Amount: {{5}}
📅 Date: {{6}}

Ensure all contributions are in before the payout date.
```

**Body Variables:**
1. `{{1}}` = Circle name (sample: `Family Savings`)
2. `{{2}}` = Cycle number (sample: `1`)
3. `{{3}}` = Beneficiary name (sample: `Jane Smith`)
4. `{{4}}` = Beneficiary wallet (sample: `0x20b9...92cb`)
5. `{{5}}` = Payout amount (sample: `0.57 SUI`)
6. `{{6}}` = Payout date (sample: `Thu, Dec 15, 2025`)

**Button:**
- Text: `Contribute Now`
- URL: `https://njangionchain.com/circle/{{1}}/contribute` (Dynamic)

---

## Quick Reference Table

| # | Template Name | Trigger | Button Text | Button URL |
|---|---|---|---|---|
| 1 | `circle_link` | Admin links WhatsApp | View Circle | `/circle/{{1}}` |
| 2 | `circle_unlink` | Admin unlinks WhatsApp | Reconnect Circle | `/circle/{{1}}/manage` |
| 3 | `member_joins` | Admin approves member | View Circle | `/circle/{{1}}` |
| 4 | `deposit_received` | Member pays deposit | View Deposits | `/circle/{{1}}/contribute` |
| 5 | `deposit_returned` | Deposit returned | View Circle | `/circle/{{1}}` |
| 6 | `recieve_contribution` | Member contributes | Contribute Now | `/circle/{{1}}/contribute` |
| 7 | `member_removed` | Admin removes member | View Circle | `/circle/{{1}}` |
| 8 | `order_changed` | Admin reorders rotation | View Circle | `/circle/{{1}}` |
| 9 | `live_circle` | Circle activated | Contribute Now | `/circle/{{1}}/contribute` |
| 10 | `payout_processed` | Payout distributed | Contribute Now | `/circle/{{1}}/contribute` |
| 11 | `cycle_complete` | All contributions in | Manage Circle | `/circle/{{1}}/manage` |
| 12 | `contribution_reminder` | 24h before payout | Contribute Now | `/circle/{{1}}/contribute` |
| 13 | `contribution_reminder_weekly` | 24h before weekly payout | Contribute Now | `/circle/{{1}}/contribute` |
| 14 | `payout_trigger_reminder` | 2h after missed payout | Manage Circle | `/circle/{{1}}/manage` |
| 15 | `payout_upcoming` | Payout day approaching | Contribute Now | `/circle/{{1}}/contribute` |

---

## Button Setup Instructions

For each template:

1. Click **+ Add button**
2. Select **Call to Action**
3. Set:
   - Type of Action: **Visit website**
   - Button Text: See table above
   - URL Type: **Dynamic**
   - Website URL: See table for correct path per template
4. Add the appropriate sample URL:

**Sample URLs by button type:**
| Button | URL Pattern | Sample URL |
|---|---|---|
| View Circle | `https://njangionchain.com/circle/{{1}}` | `https://njangionchain.com/circle/0x55f318fef22249265fd3fd6f4b2f5dcd0315f98e20352f053cf223842acd7201` |
| Contribute Now | `https://njangionchain.com/circle/{{1}}/contribute` | `https://njangionchain.com/circle/0x55f318fef22249265fd3fd6f4b2f5dcd0315f98e20352f053cf223842acd7201/contribute` |
| Manage Circle | `https://njangionchain.com/circle/{{1}}/manage` | `https://njangionchain.com/circle/0x55f318fef22249265fd3fd6f4b2f5dcd0315f98e20352f053cf223842acd7201/manage` |
| Reconnect Circle | `https://njangionchain.com/circle/{{1}}/manage` | `https://njangionchain.com/circle/0x55f318fef22249265fd3fd6f4b2f5dcd0315f98e20352f053cf223842acd7201/manage` |
| View Deposits | `https://njangionchain.com/circle/{{1}}/contribute` | `https://njangionchain.com/circle/0x55f318fef22249265fd3fd6f4b2f5dcd0315f98e20352f053cf223842acd7201/contribute` |

This replaces all inline URLs from the body text with a clean, tappable button at the bottom of each message.
