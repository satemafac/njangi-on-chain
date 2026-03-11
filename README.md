<img width="1714" alt="image" src="https://github.com/user-attachments/assets/9e928b07-3395-4cc6-9e17-b7b2b7950742" />

# Njangi On-Chain Rotational Circle Smart Contract
Try it out https://njangi-on-chain-1014e48e59ae.herokuapp.com/

## Overview
Njangi On-Chain is a decentralized implementation of the classic Rotational Savings and Credit Association (ROSCA).  
Members contribute a fixed amount of stable-value tokens each cycle, and the pooled funds are paid out to one member per cycle following a predefined rotation order.  
All logic is enforced on-chain by a Move smart contract deployed to the Sui blockchain.

## Why Rotational Circles?
• Simple, time-tested community finance model.  
• Guaranteed payout once per cycle for every member.  
• Transparent treasury—every deposit, payout and penalty is publicly auditable on Sui.  
• Automated enforcement removes the need for an off-chain treasurer.

## Core Workflow
1. **Create Circle** – The creator defines: contribution amount, total members, payout order and cycle duration.  
2. **Join Circle** – Prospective members submit a security deposit plus their first contribution.  
3. **Cycle Contributions** – During each cycle every member deposits the fixed amount before the deadline.  
4. **Automated Payout** – At cycle close the contract automatically transfers the pooled balance to that cycle's designated recipient.  
5. **Completion** – After the final cycle, security deposits are released (minus any penalties) and the circle is closed.


<img width="1722" alt="image" src="https://github.com/user-attachments/assets/dbc5dcf2-6345-4a5e-9d3a-633f910c43bd" />

<img width="1722" alt="image" src="https://github.com/user-attachments/assets/055a9b24-3014-4cbb-9a4d-971e780d96c9" />

<img width="1720" alt="image" src="https://github.com/user-attachments/assets/9ef55a5a-bcac-4199-b452-ef8051d6f96a" />


## Contract Interface (Move)
```move
public fun create_circle(
    name: vector<u8>,
    contribution_amount: u64,
    cycle_duration: u64,          // seconds
    payout_order: vector<address>,
    ctx: &mut TxContext
): (NjangiCircle, AdminCap);

public fun join_circle(
    circle: &mut NjangiCircle,
    security_deposit: Coin<USDC>,
    first_contribution: Coin<USDC>,
    ctx: &mut TxContext
);

public fun make_contribution(
    circle: &mut NjangiCircle,
    payment: Coin<USDC>,
    ctx: &mut TxContext
);

public fun claim_payout(
    circle: &mut NjangiCircle,
    ctx: &mut TxContext
);
```
*The actual contract contains additional helper functions and event emitters; see `/move/sources/` for full code.*

## 🚀 **Deployment**

The Njangi contracts use a dynamic network configuration system for seamless deployment to both testnet and mainnet.

### **Quick Deployment**

```bash
cd move

# Deploy to testnet
./deploy.sh testnet

# Deploy to mainnet (requires funded wallet)
./deploy.sh mainnet
```

### **Mainnet Wallet Funding**

**Send SUI tokens to this address for mainnet deployment:**
```
0xdde1086c98c6023db8e3d8267992e4c9aeba3d0271f6bac85dc2f6daa8301c77
```
**Recommended amount:** 5-10 SUI for gas fees

### **Network Management**

```bash
# Check current configuration
./scripts/switch-network.sh status

# Switch networks
./scripts/switch-network.sh mainnet
./scripts/switch-network.sh testnet
```

## 📚 **Documentation**

- **📦 [Deployment Guide](docs/deployment-guide.md)** - Complete deployment documentation
- **⚡ [Quick Reference](move/DEPLOYMENT.md)** - Essential commands for deployment
- **🏗️ [Move Contracts](move/README.md)** - Smart contract documentation
- **🔧 [Environment Configuration](docs/environment.md)** - Canonical root env workflow, validation, and Heroku sync
- **💳 [Coinbase Onramp Setup and Operations](docs/coinbase-onramp-setup-operations.md)** - Env setup, API route reference, troubleshooting
- **✅ [Coinbase Onramp Staging and Rollout Checklist](docs/coinbase-onramp-staging-rollout-checklist.md)** - UAT scenarios, production checklist, rollback runbook

## Security Deposits & Upcoming Yield
Security deposits protect the circle against missed contributions.  
We are integrating a staking module that will deploy these deposits to a DeFi yield source while they remain locked, allowing members to earn extra rewards.  
Stay tuned for details in a future release.

## Development Quick-Start
```bash
# Compile smart contract
cd move && sui move build --skip-fetch-latest-git-deps

# Run Move unit tests
sui move test -p .
```
Front-end, API and automated scripts live under `web/` and `scripts/` directories.

## Roadmap
- 🔄 Yield-bearing security deposits (staking integration)  
- 📱 zkLogin authentication for seamless Web3 onboarding  
- 🌐 Multicurrency support & automatic stablecoin swaps  
- 🛡️ Formal verification of critical contract invariants
