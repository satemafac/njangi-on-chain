# Data-Processor / DPA Inventory (internal)

_Last updated: 2026-10-01. Owner: founder. Review annually (roadmap Phase B
cadence) and whenever a processor is added. Companion:
[records-of-processing.md](records-of-processing.md)._

| Processor | Role | Data touched | DPA / terms | Transfer mechanism | Status |
|-----------|------|--------------|-------------|--------------------|--------|
| Vercel Inc. | App hosting, serverless functions, edge network, cron | Everything the app processes in flight; request logs | https://vercel.com/legal/dpa | EU-US DPF + SCCs | ☐ accepted in dashboard — verify |
| Neon Inc. | Managed Postgres | All Postgres tables (see records §) | https://neon.tech/dpa | SCCs | ☐ accepted — verify |
| Stripe, Inc. | Subscription billing | Email + billing (Stripe-collected); we hold ids only | https://stripe.com/legal/dpa | EU-US DPF + SCCs | ☐ auto-incorporated in Stripe ToS — verify |
| Meta Platforms (WhatsApp Business Platform) | Notification delivery | Phone/group + message content at send time | https://www.whatsapp.com/legal/business-data-processing-terms | SCCs | ☐ verify current BSP terms |
| Google / Apple / Meta (OAuth) | Sign-in | Independent controllers for their own auth data | n/a (controller-to-controller) | n/a | — |
| Mysten Labs, Inc. (Enoki) | zkLogin salt + zkProof at every sign-in; sponsored gas when `GAS_SPONSORSHIP_ENABLED` is on | OAuth ID token (`iss`/`sub`/`aud`, plus email/name/picture where the provider includes them), ephemeral public key, nonce randomness, max epoch; for sponsorship, the transaction bytes, sender address and user signature | [Enoki Portal Terms](https://www.mystenlabs.com/terms-of-service/enokiportal) (last updated 2023-04-09): the customer instructs Mysten to process the data in the OAuth2 credentials it submits, and Mysten uses them to generate each user's salt. No DPA referenced; no retention or transfer terms | None stated (US entity; Mysten's privacy policy names no SCCs/DPF) | ☐ no DPA located — request one, or get counsel's view on the Portal Terms |
| Walrus network operators | Encrypted PII blob storage | Ciphertext only (AES-256-GCM, keys never leave us) | Decentralized network — no DPA available; treated as storage of anonymous data (encryption = supplementary measure) | n/a | Documented posture; confirm with counsel |
| Sui RPC providers (fullnodes) | Chain reads/writes | Public chain data only | n/a | n/a | — |
| Coinbase / MoonPay / Transak | Fiat ramps (OFF at launch) | Independent controllers for KYC when enabled | Each partner's own terms | Partner's mechanism | Dormant until ramps re-enabled |

**Checklist before mainnet (owner):**

- [ ] Verify each ☐ row: DPA actually accepted/countersigned on the account.
- [ ] Record account emails/org ids used with each processor.
- [ ] Counsel confirms the Walrus "ciphertext-only" posture (roadmap A6).
- [ ] Enoki: get a DPA from Mysten Labs or counsel's sign-off on the Portal
      Terms. Those terms also let Mysten end the service for any reason,
      after reasonable steps to notify us, and every user's salt (so every
      wallet address) depends on it (CLAUDE.md, "Address-affecting
      configuration").
