import crypto from 'crypto';
import { createLogger, format, transports } from 'winston';
import { WhatsAppUserSession } from '../types/whatsapp';
import { OAuthProvider, SetupData } from '../services/zkLoginService';
import { EnokiZkLoginService } from '../services/enokiZkLoginService';
import { sessionConfig } from '../config/whatsapp.config';

// Configure logger
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.File({ filename: 'whatsapp-auth.log' }),
    new transports.Console()
  ],
});

export interface WhatsAppAuthToken {
  id: string;
  phoneNumber: string;
  token: string;
  provider: OAuthProvider;
  createdAt: Date;
  expiresAt: Date;
  used: boolean;
  loginUrl?: string;
}

export interface AuthenticationResult {
  success: boolean;
  suiAddress?: string;
  error?: string;
  authUrl?: string;
}

// ✅ SECURE: Only store minimal, non-sensitive mapping data
export interface SecurePhoneMapping {
  phoneNumber: string;
  suiAddress: string;
  provider: OAuthProvider;
  userSub: string; // OAuth subject ID for re-verification
  lastAuthenticated: Date;
  verificationStatus: 'pending' | 'verified' | 'failed';
  // ❌ NO sensitive data like zkProofs, private keys, etc.
}

export class WhatsAppSecureAuthBridgeService {
  private static instance: WhatsAppSecureAuthBridgeService;
  private authTokens: Map<string, WhatsAppAuthToken> = new Map();
  private phoneToSuiMappings: Map<string, SecurePhoneMapping> = new Map();
  private enokiService: EnokiZkLoginService;

  private constructor() {
    this.enokiService = EnokiZkLoginService.getInstance();
    this.initializeService();
  }

  public static getInstance(): WhatsAppSecureAuthBridgeService {
    if (!WhatsAppSecureAuthBridgeService.instance) {
      WhatsAppSecureAuthBridgeService.instance = new WhatsAppSecureAuthBridgeService();
    }
    return WhatsAppSecureAuthBridgeService.instance;
  }

  private initializeService(): void {
    // Clean up expired tokens every 5 minutes
    setInterval(() => {
      this.cleanupExpiredTokens();
    }, 5 * 60 * 1000);

    logger.info('WhatsApp Secure Auth Bridge service initialized with Enoki integration');
  }

  /**
   * ✅ SECURE: Check authentication without accessing sensitive data
   */
  public isPhoneNumberAuthenticated(phoneNumber: string): boolean {
    const mapping = this.phoneToSuiMappings.get(phoneNumber);
    return mapping?.verificationStatus === 'verified';
  }

  /**
   * ✅ SECURE: Get Sui address (non-sensitive public data)
   */
  public getSuiAddressForPhone(phoneNumber: string): string | null {
    const mapping = this.phoneToSuiMappings.get(phoneNumber);
    return mapping?.verificationStatus === 'verified' ? mapping.suiAddress : null;
  }

  /**
   * ✅ SECURE: Generate fresh account data from Enoki when needed
   * Don't store sensitive data - regenerate it securely through Enoki
   */
  public async getAccountDataForPhone(phoneNumber: string): Promise<{
    userAddr: string;
    provider: OAuthProvider;
    requiresFreshAuth: boolean;
  } | null> {
    const mapping = this.phoneToSuiMappings.get(phoneNumber);
    if (!mapping || mapping.verificationStatus !== 'verified') {
      return null;
    }

    // ✅ For blockchain operations, we would need to re-authenticate
    // or use Enoki's session management to get fresh credentials
    logger.info(`Account data requested for ${phoneNumber}. Consider re-authentication for sensitive operations.`);
    
    // Return minimal account info - for full operations, user needs fresh auth
    return {
      userAddr: mapping.suiAddress,
      provider: mapping.provider,
      // ❌ No sensitive zkProofs, private keys stored here
      requiresFreshAuth: true
    };
  }

  /**
   * ✅ SECURE: Start authentication process with Enoki
   */
  public async initiateAuthentication(
    phoneNumber: string, 
    provider: OAuthProvider = 'Google'
  ): Promise<AuthenticationResult> {
    try {
      logger.info(`Starting secure authentication for ${phoneNumber} with ${provider}`);

      // Check if already authenticated
      if (this.isPhoneNumberAuthenticated(phoneNumber)) {
        return {
          success: true,
          suiAddress: this.getSuiAddressForPhone(phoneNumber)!,
        };
      }

      // Generate secure auth token
      const authToken = this.generateAuthToken(phoneNumber, provider);

      // ✅ Use Enoki's secure zkLogin flow
      const { loginUrl } = await this.enokiService.beginLogin(provider);

      // Store only the login URL with token
      authToken.loginUrl = loginUrl;
      this.authTokens.set(authToken.id, authToken);

      // Create authentication URL with our token for tracking
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
      const authUrl = `${baseUrl}/auth/whatsapp?token=${authToken.token}&phone=${encodeURIComponent(phoneNumber)}&provider=${provider}`;

      logger.info(`Generated secure auth URL for ${phoneNumber}`);

      return {
        success: true,
        authUrl,
      };

    } catch (error) {
      logger.error(`Authentication initiation failed for ${phoneNumber}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Authentication failed',
      };
    }
  }

  /**
   * ✅ SECURE: Complete authentication using Enoki's secure flow
   */
  public async completeAuthentication(
    token: string,
    phoneNumber: string,
    jwtToken: string,
    setupData: SetupData
  ): Promise<AuthenticationResult> {
    try {
      logger.info(`Completing secure authentication for ${phoneNumber}`);

      // Find and validate auth token
      const authToken = this.findAuthTokenByToken(token);
      if (!authToken) {
        throw new Error('Invalid or expired authentication token');
      }

      if (authToken.phoneNumber !== phoneNumber) {
        throw new Error('Phone number mismatch');
      }

      if (authToken.used) {
        throw new Error('Authentication token already used');
      }

      if (new Date() > authToken.expiresAt) {
        throw new Error('Authentication token expired');
      }

      // ✅ Use Enoki's secure callback handling
      const authResult = await this.enokiService.handleCallback(jwtToken, setupData);

      // ✅ SECURE: Store only minimal, non-sensitive mapping data
      const secureMapping: SecurePhoneMapping = {
        phoneNumber,
        suiAddress: authResult.address,
        provider: authToken.provider,
        userSub: authResult.sub, // For re-verification if needed
        lastAuthenticated: new Date(),
        verificationStatus: 'verified',
      };

      this.phoneToSuiMappings.set(phoneNumber, secureMapping);

      // Mark token as used
      authToken.used = true;

      logger.info(`Secure authentication completed for ${phoneNumber} -> ${authResult.address}`);

      return {
        success: true,
        suiAddress: authResult.address,
      };

    } catch (error) {
      logger.error(`Authentication completion failed for ${phoneNumber}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Authentication completion failed',
      };
    }
  }

  /**
   * ✅ SECURE: Execute blockchain operations with fresh Enoki authentication
   * Note: This is a placeholder - actual implementation would accept an operation callback
   */
  public async executeSecureBlockchainOperation(
    phoneNumber: string
  ): Promise<never> {
    const mapping = this.phoneToSuiMappings.get(phoneNumber);
    if (!mapping || mapping.verificationStatus !== 'verified') {
      throw new Error('User not authenticated');
    }

    // For sensitive operations, we need fresh credentials from Enoki
    // This could be implemented as:
    // 1. Re-authentication flow
    // 2. Enoki session management
    // 3. Short-lived operation tokens from Enoki

    logger.info(`Blockchain operation requested for authenticated user ${phoneNumber}`);
    
    // This is where you'd integrate with Enoki's session management
    // or require fresh authentication for sensitive operations
    throw new Error('Fresh authentication required for blockchain operations');
  }

  /**
   * ✅ SECURE: Session management for WhatsApp integration
   */
  public updateWhatsAppSession(
    session: WhatsAppUserSession,
    phoneNumber: string
  ): WhatsAppUserSession {
    const mapping = this.phoneToSuiMappings.get(phoneNumber);
    if (!mapping || mapping.verificationStatus !== 'verified') {
      return session;
    }

    return {
      ...session,
      suiAddress: mapping.suiAddress,
      isAuthenticated: true,
      lastActivity: new Date(),
    };
  }

  // ... (other helper methods remain the same)

  private generateAuthToken(phoneNumber: string, provider: OAuthProvider): WhatsAppAuthToken {
    const tokenId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + sessionConfig.flowTimeout);

    return {
      id: tokenId,
      phoneNumber,
      token,
      provider,
      createdAt: now,
      expiresAt,
      used: false,
    };
  }

  private findAuthTokenByToken(token: string): WhatsAppAuthToken | null {
    for (const authToken of this.authTokens.values()) {
      if (authToken.token === token) {
        return authToken;
      }
    }
    return null;
  }

  private cleanupExpiredTokens(): void {
    const now = new Date();
    const expiredTokens: string[] = [];

    for (const [tokenId, authToken] of this.authTokens.entries()) {
      if (now > authToken.expiresAt || authToken.used) {
        expiredTokens.push(tokenId);
      }
    }

    expiredTokens.forEach(tokenId => {
      this.authTokens.delete(tokenId);
    });

    if (expiredTokens.length > 0) {
      logger.info(`Cleaned up ${expiredTokens.length} expired auth tokens`);
    }
  }

  /**
   * ✅ SECURE: Get service statistics without exposing sensitive data
   */
  public getStats(): Record<string, unknown> {
    return {
      activeTokens: this.authTokens.size,
      authenticatedPhones: this.phoneToSuiMappings.size,
      verifiedMappings: Array.from(this.phoneToSuiMappings.values())
        .filter(mapping => mapping.verificationStatus === 'verified').length,
      enokiIntegration: true,
      secureStorage: true,
    };
  }
} 