# Njangi Rotational Circle Smart Contract

## Overview
Njangi is a decentralized implementation of the classic Rotational Savings and Credit Association (ROSCA).  
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

## Security Deposits & Upcoming Yield
Security deposits protect the circle against missed contributions.  
We are integrating a staking module that will deploy these deposits to a DeFi yield source while they remain locked, allowing members to earn extra rewards.  
Stay tuned for details in a future release.

## Development Quick-Start
```bash
# Compile smart contract
cd move && sui move build

# Run Move unit tests
sui move test -p .
```
Front-end, API and automated scripts live under `web/` and `scripts/` directories.

## Roadmap
- 🔄 Yield-bearing security deposits (staking integration)  
- 📱 zkLogin authentication for seamless Web3 onboarding  
- 🌐 Multicurrency support & automatic stablecoin swaps  
- 🛡️ Formal verification of critical contract invariants

## License
[Specify License]
