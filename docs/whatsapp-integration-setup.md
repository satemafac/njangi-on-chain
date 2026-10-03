# WhatsApp integration

WhatsApp is a notification channel for circles. A circle admin links a
WhatsApp number to the circle in the web app, and the app sends that number
updates about the circle. Creating a circle, joining, contributing and signing
in all happen in the web app, never in WhatsApp.

An earlier version of this page described a WhatsApp command bot that did
those things through chat commands. Its command and sign-in code was deleted
in November 2025. The standalone `whatsapp-bot-backend/` notification service
that followed was retired in June 2026, and
[`whatsapp-bot-backend/DEPRECATED.md`](../whatsapp-bot-backend/DEPRECATED.md)
maps each of its features to its replacement.

## What gets sent

Two Vercel crons send the circle notifications. Both run every 15 minutes (see
[`vercel.json`](../vercel.json)) and skip events older than 24 hours, so a
long outage doesn't replay stale messages.

- **Circle updates**, from `/api/cron/whatsapp-circle-events`, go to the
  number linked to the circle: link and unlink confirmations, members joining
  and being removed, security deposits paid and returned, payout-order
  changes and circle activation. The event streams are defined in
  [`src/lib/whatsapp-bot/circle-events.ts`](../src/lib/whatsapp-bot/circle-events.ts).
  The cron also has contribution and payout streams, but they never fire
  today; see [Known gaps](#known-gaps).
- **"It's your turn"**, from `/api/cron/cycle-finalized`, tells a round's
  recipient that the payout is ready to collect. It is triggered by the
  contribution that fills the round's pot (the escrow's `ContributionRecorded`
  event that brings it to the required number of payers), states the payout
  in the round's own coin, and is dropped if the recipient has already
  collected it or the round was refunded by the time the cron runs (every 15
  minutes). It goes to a number the recipient linked as a circle admin. Only
  circle admins can link a number, so a recipient who never linked one gets
  no nudge.

The same dispatcher also sends stale-attestation reminders
([`src/lib/attestation-stale.ts`](../src/lib/attestation-stale.ts)) and ramp
KYC confirmations ([`src/lib/ramp-kyc-bridge.ts`](../src/lib/ramp-kyc-bridge.ts)).

## Replies to incoming messages

[`src/pages/api/whatsapp/webhook.ts`](../src/pages/api/whatsapp/webhook.ts)
answers every text message sent to the business number:

| Message | Reply |
| --- | --- |
| `help` or `?` | The updates a linked number gets, from [`src/content/whatsapp-updates.ts`](../src/content/whatsapp-updates.ts), and the `/status <circle-id>` and `/help` commands |
| `/status <circle-id>` | That circle's live status, read from the chain |
| `/status` | The status of every circle linked to the sender's number |
| Anything else | A short acknowledgment that points to `/status` and `/help` |

Matching is loose: any message that contains `help` gets the help reply, and
any other message that contains `status` counts as `/status`.

## How it works

- **Linking.** On the circle's manage page,
  [`WhatsAppCircleIntegration`](../src/components/WhatsAppCircleIntegration.tsx)
  calls `POST /api/whatsapp/admin-link-circle`. The route checks that the
  caller is the circle's on-chain admin and runs the sanctions, address-drift
  and plan checks. It then encrypts the number with AES-256-GCM
  ([`src/lib/walrus-pii.ts`](../src/lib/walrus-pii.ts)) and stores the
  ciphertext on Walrus. The admin's browser signs
  `whatsapp_integration::link_circle`, which anchors the Walrus blob id and a
  random nonce on chain, never the number itself. A confirm call then adds
  the link to the `whatsapp_phone_index` table, keyed by an HMAC of the
  number. `POST /api/whatsapp/admin-unlink-circle` removes a link.
- **Showing the link.** The card reads
  `GET /api/whatsapp/admin-link-circle`. For the circle admin it adds
  `includeRecipient=true`, and the route decrypts the number only for a
  session it can tie to the on-chain admin. Even then it returns a mask
  (`+237 ••• ••• 1234`,
  [`src/lib/whatsapp-recipient-mask.ts`](../src/lib/whatsapp-recipient-mask.ts))
  and the date of the link, never the number. It opens the blob recorded in
  `whatsapp_phone_index` first, because renewal (below) changes the blob id
  there and not on chain. If the route refuses the session, the card still
  shows that the circle is linked and asks the admin to sign in again.
- **Sending.** Every notification goes through `sendMemberNotification` in
  [`src/lib/whatsapp-notifier.ts`](../src/lib/whatsapp-notifier.ts). It claims
  a dedupe slot, sends through the WhatsApp Cloud API, and records the
  attempt, sent or not, in the `whatsapp_notifications` table. The webhook's
  replies call the Cloud API directly.
- **Blob renewal.** Walrus keeps a blob for `WALRUS_STORAGE_EPOCHS` epochs,
  but the on-chain anchor never expires. Before a blob's storage runs out,
  the daily `/api/cron/walrus-renewal` stores the number again as a new blob
  and records the new blob id in `whatsapp_phone_index`. The on-chain anchor
  keeps the original blob id, so every lookup reads the index first and
  uses the anchored blob id only when the index has no row for the link.

## Known gaps

- **Contribution and payout updates never go out.** Their streams listen for
  `ContributionMade`, `StablecoinContributionMade` and `PayoutProcessed`.
  Those events come from the retired payment rail, and no circle on the
  per-round escrow emits them. PR #43 repoints the streams to the escrow's
  own events.
- **Group links are refused.** A business number can message only groups it
  created through Meta's Groups API. That API is open only to Official
  Business Accounts, members join by invite link (8 at most), and a send
  addresses the group by the id the API returned, not a `…@g.us` id from the
  WhatsApp app. So the link form takes only a phone number, and
  `POST /api/whatsapp/admin-link-circle` answers `linkType` 2 with 400
  `WHATSAPP_GROUP_LINKS_UNSUPPORTED`. The check is in the route only: the
  Move module still accepts `LINK_TYPE_GROUP`. A group link made before
  PR #64 stays linked until the admin unlinks it. It receives nothing,
  because every sender reads only a phone number, and the manage card marks
  it "⚠️ Not supported".
- **The link confirmation promises more than is sent.** The help reply and
  the manage card list only the updates in
  [`src/content/whatsapp-updates.ts`](../src/content/whatsapp-updates.ts),
  but the confirmation is not built from that file. Its text, from the
  `circle_linked` stream, says contribution and payout updates will follow,
  and the `circle_link` template in
  [`WHATSAPP_TEMPLATES.md`](../WHATSAPP_TEMPLATES.md) adds cycle deadlines.
  None of those go out today.
- **A deposit refunded by a stop-and-refund gets no message.** The help reply
  and the manage card promise "Security deposits paid or returned". A return
  is sent only when an admin removes a member, which emits
  `SecurityDepositReturned`. A stop-and-refund (`execute_recovery` or
  `trigger_auto_release`) emits `RecoveryMemberRefunded` instead, and no
  stream reads it.

## Setting it up

1. **Meta app, webhook and credentials.** Follow
   [WhatsApp API setup](whatsapp-api-setup.md). It covers the Meta app, the
   business phone number, the server-only `WHATSAPP_*` variables in Vercel,
   and the webhook, which subscribes to the `messages` field only.
2. **Registry ids.** The Move publish writes the
   `NEXT_PUBLIC_<NETWORK>_WHATSAPP_PACKAGE_ID` and
   `NEXT_PUBLIC_<NETWORK>_WHATSAPP_REGISTRY_ID` pair to `.env.local`. The same
   guide explains how to copy it to Vercel.
3. **Postgres.** `npm run migrate:postgres` creates `whatsapp_phone_index`,
   `whatsapp_notifications`, `cycle_finalized_cursor` and
   `walrus_renewal_audit`.
4. **PII keys.** `WALRUS_PII_MASTER_KEY` encrypts linked numbers, and
   `WALRUS_LOOKUP_SALT` keys the lookup index. `npm run generate:secrets`
   fills both. Once numbers are linked, never just replace the master key:
   each stored number opens only with the key that sealed it. Rotate it as
   [Rotating the WhatsApp PII keys](environment.md#rotating-the-whatsapp-pii-keys)
   describes. The salt can't be rotated yet; that section explains why.
5. **Crons.** Set `CRON_SECRET`. Vercel sends it with each cron call, and the
   cron routes reject calls without it.
6. **Templates.** Read the next section before you rely on notifications in
   production.

## Templates and the 24-hour window

Every notification is business-initiated. WhatsApp delivers free-form text
only inside the 24-hour window that opens when the recipient last messaged
the business number. Outside that window, Meta delivers only approved
templates and rejects anything else with error 131047. The webhook's replies
are always inside a window, because they answer a message.

While `WHATSAPP_TEMPLATES_ENABLED` is `false` (the default), the notifier sends
free-form text. That works for testing, but it doesn't reach anyone outside
the window. To switch to templates (the header comment of
`src/lib/whatsapp-notifier.ts` has the same steps):

1. Create each template in WhatsApp Manager, category Utility. The code sends
   `circle_link`, `circle_unlink`, `member_joins`, `deposit_returned`,
   `member_removed`, `order_changed` and `payout_processed`. Their bodies are
   in [`WHATSAPP_TEMPLATES.md`](../WHATSAPP_TEMPLATES.md).
2. Check the language code. The crons send every template as `en`, but
   `WHATSAPP_TEMPLATES.md` says to create them as `en_US`. Meta treats those
   as different languages and fails a send whose language has no approved
   version (error 132001), so make the two agree before you switch.
3. Match each template's placeholders to the parameters the code passes (see
   `src/lib/whatsapp-bot/circle-events.ts`). A mismatch fails with error
   132000.
4. Once every template is approved, set `WHATSAPP_TEMPLATES_ENABLED=true` in
   Vercel and redeploy.

Security deposits, contributions, circle activation and the "your turn" nudge
have no template wired yet. They stay free-form text even with the flag on,
so they reach only people inside the window. The nudge used to borrow
`payout_processed`, but that template's approved copy says the payout was
already sent, which is false while the pot waits to be collected, so it needs
an approved template of its own.

## Checking it works

- Send `help` to the business number. The reply should arrive within
  seconds, and the logs show `Incoming WhatsApp message`.
- After a notification should have gone out, look for its row in
  `whatsapp_notifications`. `success` says whether it was sent, and `error`
  says why not; `no_link` means no linked number was found.
