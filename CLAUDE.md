# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Move Smart Contracts
```bash
# Build contracts
cd move && sui move build

# Run tests
cd move && sui move test

# Build and publish (interactive script)
cd move && ./build_and_test.sh

# Build only (skip publishing)
cd move && ./build_and_test.sh --build-only
```

### Frontend Development
```bash
# Development server with Turbopack
npm run dev

# Production build
npm run build

# Start production server
npm start

# Linting
npm run lint
```

### zkLogin Services (Docker)
```bash
# Start zkLogin prover services
docker-compose up -d

# Alternative: Local zkLogin services
./start-zklogin-services.sh
```

## Architecture Overview

### Core System Integration
This is a **DeFi-enabled rotational savings application** built on Sui blockchain with three integrated systems:

1. **zkLogin Authentication**: Social OAuth (Google/Facebook/Apple) → zkProofs → Sui addresses via Enoki service
2. **Move Smart Contracts**: Modular circle management with integrated yield generation capabilities  
3. **Cetus DEX Integration**: Real protocol integration for yield generation from security deposits

### Key Components

**Move Contracts (move/sources/)**:
- `njangi_core.move`: Time utilities, decimal scaling, currency conversion
- `njangi_circles.move`: Circle lifecycle, rotation logic, treasury management
- `njangi_yield_integration.move`: Real Cetus & NAVI protocol integration

**Frontend Services (src/services/)**:
- `zkLoginService.ts`: Social auth wrapper
- `enokiZkLoginService.ts`: Complete zkLogin implementation
- `cetus-service.ts`: DEX integration with real testnet addresses
- `yield-tracking-service.ts`: Blockchain event aggregation for earnings

**Yield Management (src/components/YieldManagement/)**:
- Abstraction layer presenting DeFi strategies as familiar financial products
- Real-time APR fetching from live Cetus/NAVI APIs
- Strategy types: Conservative (NAVI), Balanced (NAVI+Cetus), Aggressive (Advanced)

### Transaction Flow Pattern
```
Frontend → zkLogin API (/api/zkLogin) → Move Contract → Event Parsing → UI Updates
```

### Development Workflow Rules

**Move Contract Development**:
- Always `cd move` before building/testing contracts
- Use `./build_and_test.sh` for comprehensive build/publish/test cycle
- Package ID updates automatically sync to `.env.local` as `NEXT_PUBLIC_PACKAGE_ID`

**zkLogin Integration**:
- Development uses Docker services (ports 5001, 5003)
- zkLogin session state persists across OAuth flows
- Address generation is deterministic based on social identity

**Cetus Integration**:
- Uses real testnet addresses and pools
- Pool ID: `0xb01b068bd0360bb3308b81eb42386707e460b7818816709b7f51e1635d542d40` (SUI-USDC)
- Package: `0x0c7ae833c220aa73a3643a0d508afa4ac5d50d97312ea4584e35f9eb21b9df12`

**Yield System Architecture**:
- Two-step process: YieldConfig creation → SecurityDeposit processing
- Dynamic fields store member-specific yield data on-chain
- Event-driven earnings tracking with real-time calculations

### Database Integration
- Primary: Sui blockchain (financial data, circle state)
- Secondary: SQLite/PostgreSQL (join requests, UI preferences)
- Session persistence via file-based zkLogin state

### Testing Strategy
- Move contracts: `sui move test` for unit tests
- Frontend: Uses real testnet integration for development
- zkLogin: Docker services provide isolated auth environment

### Environment Configuration
Key environment variables:
- `NEXT_PUBLIC_PACKAGE_ID`: Auto-updated by build script
- `ZKLOGIN_SECRET`: Session encryption
- Various API keys for Cetus, NAVI, zkLogin services