# Records of Processing Activities (GDPR Art. 30 — internal)

_Last updated: 2026-07-05. Owner: founder. Controller: {{COMPANY_LEGAL_NAME}}
(placeholder pending counsel — same entity as the ToS). Scope: the Njangi
On-Chain web app. Companion: [dpa-inventory.md](dpa-inventory.md),
[compliance-roadmap-cex-dex-non-kyc.md](compliance-roadmap-cex-dex-non-kyc.md)._

The product is deliberately data-minimal: no names, government IDs, or
documents are collected. This table is the complete inventory.

| # | Activity | Data | Subjects | Lawful basis | Storage | Retention |
|---|----------|------|----------|--------------|---------|-----------|
| 1 | Social sign-in (zkLogin) | OAuth `sub`/`aud` identifiers; derived wallet address | Users | Contract (providing the service) | Postgres `zklogin_sessions` (sessions), `salts` (encrypted salt) | Sessions: 24h expiry; salt: until account deletion |
| 2 | Wallet-recovery codes | Salted hashes of recovery codes | Users | Contract | Postgres `recovery_codes` | Until used or account deletion |
| 3 | WhatsApp notifications | Phone number / group id (AES-256-GCM encrypted on Walrus; HMAC index in Postgres); message content at send time | Circle admins/members who opt in | Consent (explicit link action) | Walrus (ciphertext) + Postgres `whatsapp_phone_index` (HMAC only) | Until unlink or deletion request; blobs expire unrenewed after deletion |
| 4 | Join requests | Wallet address, chosen display name, circle id | Prospective members | Contract | Postgres `join_requests` | Until processed + deletion request |
| 5 | Subscription billing | Email + billing details (held BY STRIPE); we store customer/subscription ids + status | Paying admins | Contract | Stripe; Postgres `subscriptions` | Stripe retention; ids kept for accounting (legal hold) |
| 6 | Legal acceptance log | `sub`/`aud`, doc id/version, locale, HMAC'd IP | Users | Legal obligation / legitimate interest (defense of claims) | Postgres `legal_acceptances` (append-only) | Retained (documented legal hold) |
| 7 | Deletion requests | Email, optional wallet address, free-text details, HMAC'd IP, phone HMAC (added at execution) | Requesters | Legal obligation (GDPR Art. 17) | Postgres `deletion_requests` | Retained as evidence of compliance |
| 8 | Sanctions screening log | Wallet address, context, result, list version | Users at entry choke points | Legal obligation (OFAC) / legitimate interest | Postgres `sanctions_screen_log` | Retained (program evidence; see docs/sanctions-program.md) |
| 9 | Rate limiting / abuse | HMAC'd or transient IP keys | All visitors | Legitimate interest (abuse prevention) | Postgres `rate_limits` | Window expiry |
| 10 | On-chain activity | Wallet addresses, transactions, circle state | Users | N/A — public blockchain (user-initiated) | Sui network | Permanent by design (disclosed in privacy policy) |

**Not collected:** names, government IDs, ID documents, selfies, precise
location, contacts, device fingerprints. KYC, when a user buys crypto,
happens at the exchange/ramp as an independent controller.

**International transfers:** processors in the US/EU (see
[dpa-inventory.md](dpa-inventory.md)); each provides SCCs/DPF per its DPA.

**Erasure path:** public form `/legal/data-deletion` → `deletion_requests`
row → operator runs `scripts/process-deletion-request.mjs` (deletes rows,
records phone HMAC so Walrus blobs are never renewed again and expire
on-network). On-chain data cannot be erased; disclosed in the policy.
