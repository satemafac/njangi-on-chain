# Counsel review brief — Njangi On-Chain

_Forward this to counsel with the three draft documents in `docs/legal-drafts/` (Terms of Service, Privacy Policy, Risk Disclosure — EN + FR). It describes the product, the specific questions we need answered, and the 6 blanks to fill. Goal: sign-off on the drafts + a clear licensing posture before we take real money from real users._

---

## 1. What the product is (for counsel)

**Njangi On-Chain** is a **non-custodial coordination app for rotational savings groups** (known as *njangi* / *tontine* / ROSCA — a group where members contribute a fixed amount each cycle and take turns receiving the pooled payout). It runs on the Sui public blockchain.

Key facts that shape the legal posture:

- **Non-custodial.** The operator never holds, controls, or can move user funds. Money lives in per-cycle **smart-contract escrow**; payouts are permissionless (any member can trigger the contract) and recovery is member-initiated. There is no admin key that can discretionarily move funds. (See Terms §4, "Non-Custodial Architecture.")
- **Authentication** is social login (Google/Facebook/Apple) mapped to a blockchain wallet via zero-knowledge proofs (zkLogin/Enoki). The user controls their own wallet: the ephemeral signing key is generated in the browser and is never transmitted to the server. The server issues the salt and the zero-knowledge proof — that is authentication — but does not assemble signatures, so it cannot initiate a transaction on a user's behalf. *Updated for accuracy (2026-08-16):* the legacy signing capability has been removed outright — the server method that turned a caller-supplied key into a signature no longer exists, and keypair construction, private-key decoding and signature assembly are absent from both server code trees, enforced by a build-failing lint rule and a test. Legacy dispatch endpoints remain but can only answer that the action must be signed in the caller's browser.
- **Funding is by direct crypto transfer.** Users fund their in-app wallet by transferring a USD stablecoin (USDC) from a centralized exchange (Binance, Coinbase, etc.) over the Sui network. **The app itself does not sell crypto, does not touch fiat, and does not operate a fiat on-ramp.** (Third-party fiat ramps — Coinbase/MoonPay/Transak — are a possible future add-on; when used they run their own KYC/AML under their own licenses. They are OFF at launch.)
- **Revenue is a software subscription, not a cut of funds.** The operator charges an optional **$9.99/mo "Premium" subscription** for *coordination features only* (higher member limits, WhatsApp notifications, gas-fee sponsorship). **No fee is ever taken from contributions, payouts, or any fund flow.** The core savings mechanics are free and are never gated behind payment.
- **Target users:** the Cameroon / CEMAC region (Central Africa, CFA franc / XAF) and the diaspora (US / EU). The app is bilingual (English + French).
- **Limited personal data.** The only meaningful PII is an optional WhatsApp phone number for notifications, stored **encrypted** (AES-256) on decentralized storage (Walrus); only an opaque pointer is on-chain. No names, government IDs, or document scans are collected by the app (any KYC happens at the exchange/ramp, not here).
- **Compliance today:** KYC/AML is performed by the exchanges and ramp partners at the fiat boundary, under their licenses. The app has an *optional* per-group on-chain "attestation" gate but does **not** itself run sanctions screening, travel-rule capture, or transaction monitoring. We understand these may be required for regulated markets and have scoped them as future work; **we need your view on whether the current posture is defensible for a small Cameroon-first pilot.**

The operating entity appears to be **AnuTech LLC** (please confirm — this determines three of the blanks below).

---

## 2. The specific questions we need answered

1. **Licensing / registration posture.** Given the non-custodial architecture, the subscription-not-fund-fee revenue model, and partner-run KYC — does the operator need money-transmitter / MSB / VASP / e-money licensing (a) in its jurisdiction of incorporation, and (b) with respect to serving **US-person diaspora** users? Where is the line, and what keeps us on the safe side of it?
2. **CEMAC / Cameroon exposure.** COBAC (the CEMAC banking regulator) issued a 2022 restriction on crypto aimed at regulated financial institutions. As a non-custodial software provider that (i) coordinates savings groups and (ii) publishes *educational guides* on how to move USDC to/from exchanges — do we create exposure? Does the informal "community savings / tontine" framing carry any legal weight, or none?
3. **The funding guides.** The app shows users step-by-step help to withdraw USDC from their own exchange account to their own wallet (and back out to cash out). Does providing that guidance risk being characterized as money transmission, brokering, or facilitating unlicensed exchange? How should the guides be framed/disclaimed to stay clearly educational?
4. **Consumer-protection sufficiency.** Are the draft ToS / Privacy / Risk documents adequate for the target markets (Cameroon + US/EU diaspora)? Any mandatory disclosures, cooling-off rights, or dispute-resolution requirements missing? The Risk Disclosure is presented as a scroll-to-end acceptance gate before a user can join a group.
5. **Data protection.** WhatsApp numbers are encrypted on **decentralized** storage where a blob may not be trivially deletable, though we rotate/expire encryption. Is our handling defensible under GDPR-style deletion rights (relevant for EU diaspora)? The Privacy Policy describes a manual deletion-request process.
6. **The blanks + redlines.** Fill the 6 placeholders (Section 3) and redline anything in the drafts you'd change.

---

## 3. The 6 blanks to fill (appear across all three documents)

| Placeholder | What it is | Likely answer |
|---|---|---|
| `{{COMPANY_LEGAL_NAME}}` | The legal operating entity | AnuTech LLC (confirm) |
| `{{COMPANY_ADDRESS}}` | Registered business address | (entity's registered address) |
| `{{GOVERNING_LAW}}` | Jurisdiction whose law governs the Terms + where disputes are heard | (flows from entity jurisdiction) |
| `{{CONTROLLING_LANGUAGE}}` | Which language version controls if EN and FR conflict | recommend **English** (confirm) |
| `{{PRIVACY_CONTACT}}` | Email/address for privacy + data-deletion requests | (a monitored address) |
| `{{EFFECTIVE_DATE}}` | Date the Terms take effect | (launch date) |

**Note:** three of these (`COMPANY_LEGAL_NAME`, `COMPANY_ADDRESS`, `GOVERNING_LAW`) all flow from one upstream decision — *which entity, incorporated where*. If AnuTech LLC is the entity, that's settled; if a new/different entity is planned for this product, decide that first.

---

## 4. Where the documents live + how acceptance works

- Drafts: `docs/legal-drafts/{terms-of-service,privacy-policy,risk-disclosure}.{en,fr}.md`
- Acceptance mechanism: on first use, the user must scroll through the Risk Disclosure to the end and check acceptance boxes for all three documents before they can join a savings group. Acceptance is recorded (timestamp + version + identity + hashed IP), append-only, and re-prompted when a document version changes. Spec: `docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md`.
- Every draft currently carries a visible **DRAFT** banner; we remove it on your sign-off.

---

## 5. What we need back

1. The 6 filled values.
2. Any redlines to the three documents.
3. A short written view on the licensing posture (Question 1) and the CEMAC pilot (Questions 2–3) — enough for us to decide go/no-go on a small first cohort.

That's the gate. Once we have it, we drop in the values, remove the DRAFT banners, and we're clear to onboard real users.
