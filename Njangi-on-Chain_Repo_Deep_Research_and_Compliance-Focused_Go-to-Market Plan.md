# Njangi-on-Chain compliant remediation plan

## Executive summary
Current code enables admin custody/forced payouts and includes placeholder yield transfers + on-chain WhatsApp IDs. Full code-referenced backlog + diagrams: [Download](sandbox:/mnt/data/njangi_on_chain_compliance_remediation_plan.md). citeturn2view0turn6view0turn7view1turn8view0

## Blockers to ship
1) Remove/feature-gate yield & exchange. 2) Delete admin_trigger_payout/admin_force_payout; replace with per-cycle CycleEscrow + recipient Claim (user-pull). 3) Strict coin allowlist + exact oracle feed (no substring matching). 4) zkLogin: client-side signing; never persist server keys. citeturn3view0turn3view3turn0search0turn0search9

## Phased roadmap
P0 2w: tests green, risky modules off. P1 4w: escrow+claim MVP. P2 4w: partner fiat pilots + sanctions/KYC gating + geo blocks. P3: audits + scale. citeturn0search1turn10search0turn10search1turn0search5

## Trigger → control
Custody/payments→no admin fund movement; e-money→no omnibus balances; securities→no yield; AML/sanctions→partner rails + screening; privacy→no PII on-chain. citeturn10search2turn11search1turn11search6