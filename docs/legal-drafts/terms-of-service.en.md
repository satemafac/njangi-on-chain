---
title: "Njangi on Chain — Terms of Service"
version: 1.0.0
effective_date: "{{EFFECTIVE_DATE}}"
language: en
---

> **DRAFT — requires review by qualified counsel before publication.**
> This document is a professional draft prepared for internal review. It is not legal advice.
> Placeholders to resolve before publication: `{{EFFECTIVE_DATE}}`, `{{GOVERNING_LAW}}`,
> `{{COMPANY_LEGAL_NAME}}`, `{{COMPANY_ADDRESS}}`, `{{PRIVACY_CONTACT}}`, `{{CONTROLLING_LANGUAGE}}`.

# Terms of Service

**Version 1.0.0 — Effective {{EFFECTIVE_DATE}}**

These Terms of Service (the "Terms") are an agreement between you and {{COMPANY_LEGAL_NAME}}, {{COMPANY_ADDRESS}} ("Njangi", "we", "us"), the operator of the Njangi on Chain website, applications, and related services (together, the "Service"). By creating an account, accepting these Terms in the app, or using the Service, you agree to be bound by them. If you do not agree, do not use the Service.

These Terms are available in English and French. Both versions are provided to you; in the event of inconsistency, the {{CONTROLLING_LANGUAGE}} version prevails to the extent permitted by applicable law.

## 1. What the Service Is — and What It Is Not

Njangi on Chain is **coordination software** for self-organized rotational savings groups (known as njangis, tontines, or ROSCAs). The Service provides an interface to smart contracts deployed on the Sui blockchain that let a group of people you choose:

- create a savings circle with agreed contribution amounts and a rotation order;
- contribute crypto assets (stablecoins or SUI) into a **per-cycle escrow** held by the smart contract;
- have each cycle's pooled contributions claimed by the scheduled recipient;
- use coordination features such as WhatsApp notifications, goals, and analytics.

**Njangi is not a bank, credit institution, microfinance institution, deposit-taking institution, money transmitter, payment service provider, electronic money issuer, broker, exchange, or investment adviser.** We are not licensed or supervised as a financial institution in any jurisdiction, including by the BEAC or COBAC in the CEMAC region. We do not accept deposits, hold client money, extend credit, pay interest, or provide any yield, investment, or return on funds. **The Service offers no yield or interest product of any kind.**

We do not provide financial, investment, tax, or legal advice. Nothing in the Service is a recommendation to join any circle or to buy, hold, or sell any crypto asset.

## 2. Eligibility

To use the Service you must:

- be at least **18 years old** and have legal capacity to contract;
- not be located in, or a resident of, a jurisdiction where use of the Service is unlawful, and not use the Service in violation of the laws applicable to you;
- not be subject to sanctions, or listed on any applicable sanctions or prohibited-parties list;
- use the Service only for yourself, not on behalf of a third party (except as a duly authorized representative).

You are solely responsible for determining whether your participation in a savings circle and your use of crypto assets are lawful in your jurisdiction.

## 3. Your Account and Wallet (zkLogin)

The Service uses zkLogin: your Sui blockchain wallet address is derived from your Google, Facebook, or Apple account. There is no separate password and **we do not hold your private keys**.

You acknowledge and agree that:

- **if you lose access to the social account used to sign in, you may permanently lose access to your wallet and any funds it controls.** Recovery codes offered by the Service mitigate this risk only if you generate and store them safely;
- you are solely responsible for the security of your social account (strong password, two-factor authentication) and of your recovery codes;
- all transactions signed from your wallet are deemed authorized by you;
- we cannot reset, restore, or transfer your wallet for you.

## 4. Non-Custodial Architecture; No Control Over Funds

The Service is **non-custodial**. Funds contributed to a circle are held by smart contracts on the Sui blockchain, in escrow for the current cycle, under rules fixed in the published contract code. Njangi:

- **cannot move, freeze, seize, redirect, or recover user funds at its discretion.** The contracts contain no administrative function allowing us to do so;
- does not take possession of contributions or payouts at any time;
- cannot reverse, cancel, or modify a confirmed blockchain transaction;
- cannot compensate you for funds lost on-chain.

Payouts are **permissionless and member-initiated**: the scheduled recipient claims the cycle's pool directly from the contract. A member-initiated recovery mechanism exists in the contracts for certain failure scenarios; its operation is governed solely by the contract code, and Njangi cannot trigger it, accelerate it, or override it on your behalf.

**There is no deposit insurance.** Funds in circles are not protected by any government deposit-guarantee scheme, and no person — including Njangi — guarantees their return.

Suspension or termination of your access to the Service interface (Section 12) does not affect the smart contracts, which remain accessible on the public Sui network independent of Njangi.

## 5. Savings Circles; Member Disputes

Savings circles are private arrangements **between their members**. You choose whom you form a circle with. You acknowledge that:

- **Njangi does not vet, endorse, or guarantee any circle member**, does not underwrite counterparty risk, and is not a party to any circle;
- a circle only completes if its members keep contributing; a member who stops contributing can delay or prevent payouts, including yours;
- security deposits and other circle parameters are enforced solely as encoded in the smart contracts;
- any dispute between circle members (including non-payment, ordering of payouts, or exclusion of a member) is a matter between those members. Njangi has no obligation, and in a non-custodial system no technical ability, to adjudicate or remedy such disputes by moving funds.

You agree to deal honestly with your circle members and to use circles only with people with whom you have an actual savings arrangement.

## 6. Crypto Assets; Acknowledgment of Risks

Contributions and payouts are made in crypto assets (stablecoins or SUI) on the Sui network (testnet or mainnet, as indicated in the app). You acknowledge the risks described in the **Risk Disclosure**, which forms part of these Terms, including: price volatility (including stablecoin de-pegging), irreversibility of transactions, smart-contract defects, oracle/price-feed errors, blockchain network failures, wallet-access loss, and regulatory uncertainty. **You may lose some or all of the value you contribute.**

Features identified as running on **testnet** use tokens with no monetary value and are provided for evaluation only.

## 7. Fiat Purchases via Partners

If you buy crypto assets with fiat currency through the Service, the purchase is executed **on the platform of an independent partner** (such as Coinbase, MoonPay, or Transak), under that partner's own terms, fees, and licenses. The partner — not Njangi — performs identity verification (KYC) and anti-money-laundering checks. **Njangi never receives, holds, or settles your fiat money.** We are not responsible for a partner's acts, omissions, fees, delays, refusals, or availability in your country. A confirmation that a partner completed its checks may be recorded on-chain solely as an opaque cryptographic hash containing no personal data.

## 8. Subscriptions and Billing

The core of the Service is available on a **Free tier** (currently: one circle with up to three members). A **Premium subscription** (currently **USD 9.99 per month**) unlocks coordination features such as larger and additional circles, WhatsApp notifications, smart goals, and analytics.

- **Billing.** Subscriptions are billed through **Stripe**, our payment processor. Your card and payment details are collected and processed by Stripe under its own terms and privacy policy; Njangi never receives your full card details.
- **Renewal and cancellation.** Subscriptions renew automatically each billing period. You may **cancel at any time**; cancellation takes effect at the **end of the current billing period**, and you keep Premium features until then. Except where required by law, fees already paid are not refunded pro rata.
- **Price changes.** We will give you at least 30 days' notice of price changes; they apply from your next billing period after the notice.
- **What is never paywalled.** Access to your funds is never conditioned on payment. **Claiming a payout, withdrawing or recovering funds, and the member-initiated recovery mechanism are available on all tiers, at no charge from Njangi, at all times.** If your subscription lapses, you lose Premium coordination features only.
- Network gas fees and partner fees (Section 7) are independent of any Njangi subscription.

## 9. Prohibited Uses

You agree not to:

- use the Service for any unlawful purpose, including money laundering, terrorist financing, sanctions evasion, fraud, or pyramid/Ponzi schemes;
- misrepresent your identity, impersonate another person, or create accounts for persons under 18;
- defraud, mislead, or coerce circle members, or organize circles you do not intend to honor;
- attempt to exploit, manipulate, or interfere with the smart contracts, the Service, or other users' wallets, or introduce malicious code;
- scrape, resell, or commercially exploit the Service without our written consent;
- circumvent any access, rate-limiting, or security measure;
- use the Service from a jurisdiction where it is prohibited, or to evade a partner's compliance controls.

We may suspend or terminate interface access for breach (Section 12). Because the system is non-custodial, suspension does not and cannot confiscate on-chain funds.

## 10. Intellectual Property

The Service's software, branding, and content are owned by Njangi or its licensors. Open-source components, including published smart-contract code, remain governed by their respective licenses. We grant you a limited, revocable, non-exclusive, non-transferable license to use the Service for its intended purpose. You retain rights to content you submit, and grant us a license to process it as needed to operate the Service.

## 11. Third-Party Services

The Service interoperates with third parties we do not control, including the Sui network and its validators, Walrus decentralized storage, OAuth providers (Google, Facebook, Apple), Meta's WhatsApp Business Platform, Stripe, fiat-ramp partners, and price oracles. Their availability and conduct are outside our control, and your use of them may be subject to their own terms. To the maximum extent permitted by law, we are not liable for third-party services.

## 12. Suspension and Termination

You may stop using the Service at any time. We may suspend or terminate your access to the Service interface, with notice where practicable, if you breach these Terms, if required by law, or if continued provision creates legal or security risk. Sections that by their nature should survive (including 4, 5, 13–16) survive termination. **Termination of interface access does not block your on-chain funds**: the contracts remain publicly accessible, and claiming and recovery functions remain callable on the Sui network.

## 13. Disclaimers

THE SERVICE, INCLUDING THE SMART CONTRACTS AND ANY INFORMATION DISPLAYED (INCLUDING PRICES AND BALANCES), IS PROVIDED **"AS IS" AND "AS AVAILABLE"**, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, OR UNINTERRUPTED OPERATION. WE DO NOT WARRANT THAT THE SMART CONTRACTS ARE FREE OF DEFECTS OR THAT ANY CIRCLE WILL COMPLETE. SOME JURISDICTIONS DO NOT ALLOW CERTAIN WARRANTY EXCLUSIONS; IN THAT CASE THEY APPLY TO THE MAXIMUM EXTENT PERMITTED.

## 14. Limitation of Liability

To the maximum extent permitted by applicable law:

- Njangi, its officers, employees, and agents are **not liable for indirect, incidental, special, consequential, or punitive damages**, or for loss of profits, data, goodwill, or crypto assets, arising from or related to the Service;
- Njangi is **not liable for**: losses caused by the conduct of circle members (including non-contribution or fraud); blockchain network or validator failures; smart-contract defects or exploits; oracle or price-feed errors; loss of access to your social login or recovery codes; acts or omissions of third-party services (Section 11); or events beyond our reasonable control;
- **Njangi's aggregate liability** for all claims arising out of or relating to the Service is limited to the **greater of (a) the subscription fees you paid to Njangi in the twelve (12) months preceding the event giving rise to the claim, and (b) one hundred (100) US dollars**.

Nothing in these Terms excludes or limits liability that cannot be excluded or limited under applicable law, including liability for fraud, willful misconduct, or gross negligence where such limitation is not permitted.

## 15. Indemnification

You agree to indemnify and hold harmless Njangi and its officers, employees, and agents from claims, damages, and reasonable costs (including legal fees) arising from your breach of these Terms, your violation of applicable law, or your disputes with circle members or other third parties, except to the extent caused by our own breach or misconduct.

## 16. Governing Law and Disputes

These Terms are governed by the laws of **{{GOVERNING_LAW}}**, without regard to conflict-of-laws rules. The courts of {{GOVERNING_LAW}} have jurisdiction over disputes arising from these Terms, subject to any mandatory consumer-protection rules granting you the right to proceed in your place of residence. The parties will attempt in good faith to resolve any dispute amicably before initiating proceedings.

## 17. Changes to These Terms

We may amend these Terms. Each version carries a version number and effective date. For **material changes**, we will notify you in the app and/or by email at least **30 days** before the new version takes effect, and the app will ask you to **review and accept the new version** before continuing to use features covered by the change. If you do not accept, you must stop using the Service; your on-chain funds remain claimable per Section 12. The current and prior versions will remain available in the app.

## 18. Miscellaneous

- **Taxes.** You are solely responsible for any taxes arising from your circle participation or crypto-asset transactions.
- **Severability.** If a provision is held invalid, the remainder stays in effect.
- **Assignment.** You may not assign these Terms; we may assign them in connection with a reorganization or transfer of the Service, with notice to you.
- **Entire agreement.** These Terms, the Privacy Policy, and the Risk Disclosure are the entire agreement between you and Njangi concerning the Service.
- **No waiver.** Failure to enforce a provision is not a waiver.

## 19. Contact

{{COMPANY_LEGAL_NAME}}, {{COMPANY_ADDRESS}} — {{PRIVACY_CONTACT}}
