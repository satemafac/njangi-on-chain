# Records of Processing Activities (GDPR Art. 30 — internal)

_Last updated: 2026-10-01. Owner: founder. Controller: {{COMPANY_LEGAL_NAME}}
(placeholder pending counsel — same entity as the ToS). Scope: the Njangi
On-Chain web app. Companion: [dpa-inventory.md](dpa-inventory.md),
[compliance-roadmap-cex-dex-non-kyc.md](compliance-roadmap-cex-dex-non-kyc.md)._

The product is deliberately data-minimal: no names, government IDs, or
documents are collected. This table is meant to be the complete inventory.
☐ Tables that hold wallet addresses or other personal data but have no row
yet: `mainnet_signups`, `compliance_attestation_queue`,
`whatsapp_notifications`, `gas_sponsorship_usage` / `gas_sponsorship_pending`,
`record_share_tokens`, `circle_testimonials`, `member_badges`,
`member_rewards`.

| # | Activity | Data | Subjects | Lawful basis | Storage | Retention |
|---|----------|------|----------|--------------|---------|-----------|
| 1 | Social sign-in (zkLogin) | OAuth ID token (`iss`/`sub`/`aud`, plus email, name and picture where the provider includes them); zkLogin salt; derived wallet address | Users | Contract (providing the service) | Enoki (Mysten Labs) derives the salt and generates the zkProof at every sign-in (processor, see [dpa-inventory.md](dpa-inventory.md)); Postgres `zklogin_sessions` (session payload incl. a copy of the salt + proof, AES-256-GCM; `sub`/`aud`/address in plain columns); browser `sessionStorage` (tab-scoped signer, incl. the salt) | Sessions: 24h TTL, then deleted (lazily, on the next session read; a new login also deletes the user's older sessions), and the salt copy goes with them. Browser copy: until sign-out (incl. the 15-min idle auto-logout) or tab close. Enoki side: no retention term stated (☐ dpa-inventory) |
| 2 | Legacy salt records (retired) | Encrypted salts (`salts`) and salted hashes of recovery codes (`recovery_codes`) from the self-hosted salt service | Anyone who signed in through that service before 2025-05-24, if rows remain | None ongoing: the purpose ended when salts moved to Enoki (2025-05-24) | Postgres `salts`, `recovery_codes`; nothing has written or read them since (see [zklogin-salt-source.md](zklogin-salt-source.md)) | No new rows. Remaining rows are deleted on a verified request (executor step 3). ☐ Owner: count them and decide on a purge |
| 3 | WhatsApp notifications | Phone number / group id (AES-256-GCM encrypted on Walrus; HMAC index in Postgres); message content at send time | Circle admins/members who opt in | Consent (explicit link action) | Walrus (ciphertext) + Postgres `whatsapp_phone_index` (HMAC only) | Until unlink or deletion request; blobs expire unrenewed after deletion |
| 4 | Join requests | Wallet address, chosen display name, circle id | Prospective members | Contract | Postgres `join_requests` | Until processed + deletion request |
| 5 | Subscription billing | Email + billing details (held BY STRIPE); we store customer/subscription ids + status | Paying admins | Contract | Stripe; Postgres `subscriptions` | Stripe retention; ids kept for accounting (legal hold) |
| 6 | Legal acceptance log | `sub`/`aud`, doc id/version, locale, HMAC'd IP | Users | Legal obligation / legitimate interest (defense of claims) | Postgres `legal_acceptances` (append-only) | Retained (documented legal hold) |
| 7 | Deletion requests | Email, optional wallet address, free-text details, HMAC'd IP, phone HMAC (added at execution) | Requesters | Legal obligation (GDPR Art. 17) | Postgres `deletion_requests` | Retained as evidence of compliance |
| 8 | Sanctions screening log | Wallet address, context, result, list version | Users at entry choke points | Legal obligation (OFAC) / legitimate interest | Postgres `sanctions_screen_log` | Retained (program evidence; see docs/sanctions-program.md) |
| 9 | Rate limiting / abuse | HMAC'd or transient IP keys | All visitors | Legitimate interest (abuse prevention) | Postgres `rate_limits` | Window expiry |
| 10 | On-chain activity | Wallet addresses, transactions, circle state | Users | N/A — public blockchain (user-initiated) | Sui network | Permanent by design (disclosed in privacy policy) |
| 11 | Address-drift detection | `iss`/`sub`/`aud`, provider, each wallet address a sign-in resolved to, first/last seen, login count | Users | ☐ Legitimate interest (proposed): warning users before they fund an address their login no longer reaches | Postgres `zklogin_address_bindings` (append-only) | ☐ Undecided: append-only by design, and the deletion executor does not erase these rows today |

**Not collected:** names, government IDs, ID documents, selfies, precise
location, contacts, device fingerprints. KYC, when a user buys crypto,
happens at the exchange/ramp as an independent controller.

**International transfers:** processors in the US/EU (see
[dpa-inventory.md](dpa-inventory.md)); each provides SCCs/DPF per its DPA,
except Enoki (Mysten Labs, US), which has no DPA on file yet (☐ in the
inventory).

**Erasure path:** public form `/legal/data-deletion` → `deletion_requests`
row → operator runs `scripts/process-deletion-request.mjs` (deletes rows,
records phone HMAC so Walrus blobs are never renewed again and expire
on-network). On-chain data cannot be erased; disclosed in the policy.

**Identity verification before erasure (mandatory):** the public form is
unauthenticated by design (a locked-out user must still be able to request
deletion) and its `user_address` is a *public on-chain value* — it does not
prove the requester owns that wallet. The executor's destructive steps
delete rows keyed to a wallet address (`join_requests`, `zklogin_sessions`)
and to an OAuth identity (legacy `salts`/`recovery_codes`). Run on a spoofed
request, they would destroy a stranger's data, which is itself a
personal-data breach (GDPR Art. 4(12)); Art. 12(6) lets us ask for proof of
identity first. So they must only run against a **proven** identity:

- **Signed-in requests** are captured with the server-verified zkLogin
  identity (`verified_sub`/`verified_aud`/`identity_verified`, taken from the
  HttpOnly session cookie, never from the request body). The executor runs
  its identity-keyed deletes only against those columns.
- **Anonymous (locked-out) requests** have `identity_verified = false`. The
  executor SKIPS the address- and identity-keyed deletes and leaves the
  request in `status = processing`. Before completing it, the operator MUST
  verify the requester controls the wallet out-of-band (e.g. a signed message
  from the address, or a support-desk identity check), then re-run with
  `--sub <s> --aud <a> --force-unverified-identity`.

None of these deletes affects wallet access. Since 2025-05-24 every login
gets its salt from Enoki (`getUserSalt` in
`src/services/enokiZkLoginService.ts`), so no row in `salts` derives the
address of a wallet any login reaches today. Until 2026-10-01 this section
said the delete permanently locked the wallet; that described the retired
self-hosted salt service.

Never mark a wallet-bearing request `completed` while rows keyed to its
identity still exist — that would falsely record an erasure that did not
happen.
