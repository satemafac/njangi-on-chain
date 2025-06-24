# 🔐 Secure Storage & Enoki Integration for WhatsApp

## Overview

This document addresses storage and security concerns for the WhatsApp integration, showing how to properly leverage **Enoki's secure infrastructure** rather than storing sensitive data ourselves.

## 🎯 Key Security Principles

### ✅ What We Store (Minimal, Non-Sensitive)
```typescript
interface SecurePhoneMapping {
  phoneNumber: string;        // Public identifier
  suiAddress: string;         // Public blockchain address  
  provider: OAuthProvider;    // Which OAuth provider used
  userSub: string;           // OAuth subject ID for re-verification
  lastAuthenticated: Date;   // Timestamp for auditing
  verificationStatus: 'verified' | 'pending' | 'failed';
}
```

### ❌ What We DON'T Store (Sensitive Data)
```typescript
// ❌ NEVER store these - let Enoki handle them:
interface SensitiveData {
  zkProofs: any;           // Zero-knowledge proofs
  ephemeralPrivateKey: any; // Private keys
  userSalt: bigint;        // Cryptographic salt
  jwt: string;            // JWT tokens
  setupData: any;         // Authentication setup data
}
```

## 🏗️ Architecture: WhatsApp + Enoki Integration

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────┐
│   WhatsApp      │    │  Your Bridge     │    │   Enoki Service     │
│   Messages      │────▶  Service         │────▶ (Secure Storage)   │
└─────────────────┘    └──────────────────┘    └─────────────────────┘
                                │                         │
                                ▼                         ▼
                       ┌──────────────────┐    ┌─────────────────────┐
                       │ Phone→Address    │    │ zkLogin Proofs      │
                       │ Mappings         │    │ Private Keys        │
                       │ (Non-sensitive)  │    │ Salts & Tokens      │
                       └──────────────────┘    │ (Secure & Managed)  │
                                               └─────────────────────┘
```

## 🔄 Authentication Flow (Production-Ready)

### Phase 1: WhatsApp Command
```
User: /auth
↓
WhatsApp Bridge: Generate secure token + Enoki login URL
↓  
WhatsApp: Send auth link to user
```

### Phase 2: Web Authentication
```
User clicks link → Web auth page
↓
User selects OAuth provider (Google/Facebook/Apple)
↓
Enoki handles: JWT verification, salt generation, proof creation
↓
Bridge stores: Only phone→address mapping (non-sensitive)
```

### Phase 3: Blockchain Operations
```
User: /contribute 100 USDC
↓
Bridge: Lookup phone→address (fast)
↓
For sensitive operations: Request fresh auth from Enoki
↓
Execute blockchain transaction securely
```

## 🏦 Production Storage Strategy

### Option 1: Enhanced In-Memory + Persistence
```typescript
export class ProductionWhatsAppAuthBridge {
  // In-memory for fast lookups
  private phoneToSuiMappings: Map<string, SecurePhoneMapping> = new Map();
  
  // Persistent storage for production
  private async persistMapping(mapping: SecurePhoneMapping): Promise<void> {
    // PostgreSQL, MongoDB, or your preferred database
    await this.database.upsert('phone_mappings', mapping);
  }
  
  private async loadMappings(): Promise<void> {
    // Load mappings on service startup
    const mappings = await this.database.findAll('phone_mappings');
    mappings.forEach(mapping => {
      this.phoneToSuiMappings.set(mapping.phoneNumber, mapping);
    });
  }
}
```

### Option 2: Database-First Approach
```typescript
export class DatabaseAuthBridge {
  public async getSuiAddressForPhone(phoneNumber: string): Promise<string | null> {
    const mapping = await this.database.findOne('phone_mappings', { 
      phoneNumber, 
      verificationStatus: 'verified' 
    });
    return mapping?.suiAddress || null;
  }
  
  public async isPhoneNumberAuthenticated(phoneNumber: string): Promise<boolean> {
    const count = await this.database.count('phone_mappings', {
      phoneNumber,
      verificationStatus: 'verified'
    });
    return count > 0;
  }
}
```

### Option 3: Hybrid Approach (Recommended)
```typescript
export class HybridSecureAuthBridge {
  private cache: Map<string, SecurePhoneMapping> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  
  public async getSuiAddressForPhone(phoneNumber: string): Promise<string | null> {
    // Try cache first
    const cached = this.cache.get(phoneNumber);
    if (cached && this.isCacheValid(cached)) {
      return cached.suiAddress;
    }
    
    // Fallback to database
    const mapping = await this.database.findVerifiedMapping(phoneNumber);
    if (mapping) {
      this.cache.set(phoneNumber, { ...mapping, cachedAt: new Date() });
      return mapping.suiAddress;
    }
    
    return null;
  }
}
```

## 🚀 Blockchain Operations: Fresh Auth Pattern

```typescript
export class SecureBlockchainOperations {
  /**
   * For sensitive operations, we get fresh credentials from Enoki
   */
  public async executeCircleContribution(
    phoneNumber: string, 
    amount: number,
    circleId: string
  ): Promise<TransactionResult> {
    
    // 1. Verify user is authenticated
    const suiAddress = await this.authBridge.getSuiAddressForPhone(phoneNumber);
    if (!suiAddress) {
      throw new Error('User not authenticated');
    }
    
    // 2. For blockchain operations, get fresh credentials from Enoki
    const freshAuth = await this.requestFreshAuthentication(phoneNumber);
    
    // 3. Execute transaction using Enoki's secure infrastructure
    return await this.enokiService.sendTransaction(
      freshAuth.accountData,
      (txb) => {
        // Prepare circle contribution transaction
        this.circleService.prepareContribution(txb, circleId, amount, suiAddress);
      }
    );
  }
  
  private async requestFreshAuthentication(phoneNumber: string): Promise<{
    accountData: AccountData;
    expiresAt: Date;
  }> {
    // Option A: Re-authentication flow
    // Send user a fresh auth link for sensitive operations
    
    // Option B: Use Enoki's session management
    // Check if existing session is valid, refresh if needed
    
    // Option C: Short-lived operation tokens
    // Generate time-limited tokens for specific operations
    
    throw new Error('Fresh authentication required - implementation pending');
  }
}
```

## 🔒 Security Benefits of Enoki Integration

### 1. **Managed Infrastructure**
- ✅ Enoki handles salt generation and storage
- ✅ Secure proof generation in managed environment  
- ✅ No need to run your own prover services
- ✅ Automatic security updates and maintenance

### 2. **Zero-Knowledge Security**
- ✅ Private keys never leave Enoki's secure environment
- ✅ zkLogin proofs generated server-side
- ✅ Your application only gets public addresses
- ✅ Cryptographic integrity maintained

### 3. **Scalability**
- ✅ Enoki handles high-volume proof generation
- ✅ No need to scale your own cryptographic infrastructure
- ✅ Pay-per-use model vs maintaining servers

### 4. **Compliance**
- ✅ Enoki provides SOC 2 compliant infrastructure
- ✅ Your app stores minimal PII (just phone numbers)
- ✅ Sensitive cryptographic data handled by experts

## 📊 Data Flow Example

```typescript
// User sends: /contribute 100 USDC to circle-123
const whatsappMessage = {
  from: "+1234567890",
  text: "/contribute 100 USDC to circle-123"
};

// 1. Fast lookup (non-sensitive data)
const suiAddress = await authBridge.getSuiAddressForPhone("+1234567890");
// Result: "0x742d35Cc77c2e...a5b4C6B4c6Bb2f"

// 2. Parse command
const { command, amount, circleId } = parseWhatsAppCommand(whatsappMessage.text);

// 3. For blockchain operation, get fresh auth from Enoki
const accountData = await enokiService.getFreshAccountData(suiAddress);

// 4. Execute transaction securely
const result = await enokiService.sendTransaction(accountData, (txb) => {
  circleService.prepareContribution(txb, circleId, amount, suiAddress);
});

// 5. Send confirmation to WhatsApp
await whatsappService.sendMessage("+1234567890", 
  `✅ Contributed ${amount} USDC to ${circleId}\nTransaction: ${result.digest}`
);
```

## 🎯 Next Steps

1. **✅ Current**: Secure phone→address mapping with minimal data storage
2. **🔄 Next**: Implement fresh authentication patterns with Enoki
3. **📱 Then**: Build WhatsApp command parsing and circle operations
4. **🔐 Finally**: Add notification and audit systems

## Environment Variables (Enoki Integration)

```env
# Enoki Service (Primary)
NEXT_PUBLIC_ENOKI=your_enoki_api_key

# WhatsApp Business API
WHATSAPP_ACCESS_TOKEN=your_whatsapp_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_VERIFY_TOKEN=your_verify_token
WHATSAPP_APP_SECRET=your_app_secret

# OAuth Providers (for Enoki)
NEXT_PUBLIC_GOOGLE_CLIENT_ID=your_google_client_id
NEXT_PUBLIC_FACEBOOK_CLIENT_ID=your_facebook_client_id
NEXT_PUBLIC_APPLE_CLIENT_ID=your_apple_client_id
```

---

**✨ Summary**: By leveraging Enoki's secure infrastructure, we store only minimal phone→address mappings while letting Enoki handle all sensitive cryptographic operations. This provides the security of a managed service with the flexibility of custom WhatsApp integration. 