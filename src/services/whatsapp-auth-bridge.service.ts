import crypto from 'crypto';
import { createLogger, format, transports } from 'winston';
import { WhatsAppUserSession } from '../types/whatsapp';
import { OAuthProvider, AccountData } from '../services/zkLoginService';
import { ZkLoginClient } from '../services/zkLoginClient';
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
  account?: AccountData;
  error?: string;
  authUrl?: string;
}

export interface PhoneNumberMapping {
  phoneNumber: string;
  suiAddress: string;
  accountData: AccountData;
  lastAuthenticated: Date;
  verificationStatus: 'pending' | 'verified' | 'failed';
}

export class WhatsAppAuthBridgeService {
  private static instance: WhatsAppAuthBridgeService;
  private authTokens: Map<string, WhatsAppAuthToken> = new Map();
  private phoneToSuiMappings: Map<string, PhoneNumberMapping> = new Map();
  private zkLoginClient: ZkLoginClient;
  private completionCallbacks: Map<string, (phoneNumber: string, success: boolean, account?: AccountData) => void> = new Map();

  private constructor() {
    this.zkLoginClient = ZkLoginClient.getInstance();
    this.initializeService();
  }

  public static getInstance(): WhatsAppAuthBridgeService {
    if (!WhatsAppAuthBridgeService.instance) {
      WhatsAppAuthBridgeService.instance = new WhatsAppAuthBridgeService();
    }
    return WhatsAppAuthBridgeService.instance;
  }

  private initializeService(): void {
    // Clean up expired tokens every 5 minutes
    setInterval(() => {
      this.cleanupExpiredTokens();
    }, 5 * 60 * 1000);

    logger.info('WhatsApp Auth Bridge service initialized');
  }

  /**
   * Check if a phone number is already authenticated
   */
  public isPhoneNumberAuthenticated(phoneNumber: string): boolean {
    const mapping = this.phoneToSuiMappings.get(phoneNumber);
    return mapping?.verificationStatus === 'verified';
  }

  /**
   * Get Sui address for an authenticated phone number
   */
  public getSuiAddressForPhone(phoneNumber: string): string | null {
    const mapping = this.phoneToSuiMappings.get(phoneNumber);
    return mapping?.verificationStatus === 'verified' ? mapping.suiAddress : null;
  }

  /**
   * Get account data for an authenticated phone number
   */
  public getAccountDataForPhone(phoneNumber: string): AccountData | null {
    const mapping = this.phoneToSuiMappings.get(phoneNumber);
    return mapping?.verificationStatus === 'verified' ? mapping.accountData : null;
  }

  /**
   * Start authentication process for a WhatsApp user
   */
  public async initiateAuthentication(
    phoneNumber: string, 
    provider: OAuthProvider = 'Google'
  ): Promise<AuthenticationResult> {
    try {
      logger.info(`Starting authentication for ${phoneNumber} with ${provider}`);

      // Check if already authenticated
      if (this.isPhoneNumberAuthenticated(phoneNumber)) {
        return {
          success: true,
          suiAddress: this.getSuiAddressForPhone(phoneNumber)!,
          account: this.getAccountDataForPhone(phoneNumber)!,
        };
      }

      // Generate secure auth token
      const authToken = this.generateAuthToken(phoneNumber, provider);

      // Start zkLogin flow
      const { loginUrl } = await this.zkLoginClient.beginLogin(provider);

      // Store login URL with token
      authToken.loginUrl = loginUrl;
      
      this.authTokens.set(authToken.id, authToken);

      // Create authentication URL with token
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
      const authUrl = `${baseUrl}/auth/whatsapp?token=${authToken.token}&phone=${encodeURIComponent(phoneNumber)}`;

      logger.info(`Generated auth URL for ${phoneNumber}: ${authUrl}`);

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
   * Complete authentication after OAuth callback
   */
  public async completeAuthentication(
    token: string,
    phoneNumber: string,
    jwtToken: string
  ): Promise<AuthenticationResult> {
    try {
      logger.info(`Completing authentication for ${phoneNumber} with token ${token}`);

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

      // Complete zkLogin authentication
      const accountData = await this.zkLoginClient.handleCallback(jwtToken);

      // Store phone number to Sui address mapping
      const mapping: PhoneNumberMapping = {
        phoneNumber,
        suiAddress: accountData.userAddr,
        accountData,
        lastAuthenticated: new Date(),
        verificationStatus: 'verified',
      };

      this.phoneToSuiMappings.set(phoneNumber, mapping);

      // Mark token as used
      authToken.used = true;

      logger.info(`Authentication completed for ${phoneNumber} -> ${accountData.userAddr}`);

      // Trigger completion callback if registered
      const callback = this.completionCallbacks.get(phoneNumber);
      if (callback) {
        try {
          callback(phoneNumber, true, accountData);
          this.completionCallbacks.delete(phoneNumber);
        } catch (callbackError) {
          logger.error(`Error in completion callback for ${phoneNumber}:`, callbackError);
        }
      }

      return {
        success: true,
        suiAddress: accountData.userAddr,
        account: accountData,
      };

    } catch (error) {
      logger.error(`Authentication completion failed for ${phoneNumber}:`, error);
      
      // Trigger failure callback if registered
      const callback = this.completionCallbacks.get(phoneNumber);
      if (callback) {
        try {
          callback(phoneNumber, false);
          this.completionCallbacks.delete(phoneNumber);
        } catch (callbackError) {
          logger.error(`Error in failure callback for ${phoneNumber}:`, callbackError);
        }
      }
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Authentication completion failed',
      };
    }
  }

  /**
   * Verify authentication token
   */
  public verifyAuthToken(token: string, phoneNumber: string): boolean {
    const authToken = this.findAuthTokenByToken(token);
    
    if (!authToken) {
      return false;
    }

    return (
      authToken.phoneNumber === phoneNumber &&
      !authToken.used &&
      new Date() <= authToken.expiresAt
    );
  }

  /**
   * Generate temporary authentication URL for WhatsApp user
   */
  public generateAuthenticationUrl(phoneNumber: string, provider: OAuthProvider = 'Google'): string {
    const authToken = this.generateAuthToken(phoneNumber, provider);
    this.authTokens.set(authToken.id, authToken);

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
    return `${baseUrl}/auth/whatsapp?token=${authToken.token}&phone=${encodeURIComponent(phoneNumber)}`;
  }

  /**
   * Revoke authentication for a phone number
   */
  public revokeAuthentication(phoneNumber: string): boolean {
    const mapping = this.phoneToSuiMappings.get(phoneNumber);
    if (mapping) {
      this.phoneToSuiMappings.delete(phoneNumber);
      logger.info(`Authentication revoked for ${phoneNumber}`);
      return true;
    }
    return false;
  }

  /**
   * Update session with authentication data
   */
  public updateWhatsAppSession(
    session: WhatsAppUserSession,
    accountData: AccountData
  ): WhatsAppUserSession {
    return {
      ...session,
      suiAddress: accountData.userAddr,
      isAuthenticated: true,
      zkLoginProof: {
        provider: accountData.provider,
        userAddr: accountData.userAddr,
        zkProofs: accountData.zkProofs,
        userSalt: accountData.userSalt,
        sub: accountData.sub,
        aud: accountData.aud,
      },
      lastActivity: new Date(),
    };
  }

  /**
   * Get authentication status for phone number
   */
  public getAuthenticationStatus(phoneNumber: string): {
    isAuthenticated: boolean;
    suiAddress?: string;
    lastAuthenticated?: Date;
    provider?: string;
  } {
    const mapping = this.phoneToSuiMappings.get(phoneNumber);
    
    if (!mapping || mapping.verificationStatus !== 'verified') {
      return { isAuthenticated: false };
    }

    return {
      isAuthenticated: true,
      suiAddress: mapping.suiAddress,
      lastAuthenticated: mapping.lastAuthenticated,
      provider: mapping.accountData.provider,
    };
  }

  /**
   * Generate secure authentication token
   */
  private generateAuthToken(phoneNumber: string, provider: OAuthProvider): WhatsAppAuthToken {
    const tokenId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + sessionConfig.flowTimeout); // 30 minutes

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

  /**
   * Find auth token by token string
   */
  private findAuthTokenByToken(token: string): WhatsAppAuthToken | null {
    for (const authToken of this.authTokens.values()) {
      if (authToken.token === token) {
        return authToken;
      }
    }
    return null;
  }

  /**
   * Clean up expired tokens
   */
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
   * Get service statistics
   */
  public getStats(): Record<string, unknown> {
    return {
      activeTokens: this.authTokens.size,
      authenticatedPhones: this.phoneToSuiMappings.size,
      verifiedMappings: Array.from(this.phoneToSuiMappings.values())
        .filter(mapping => mapping.verificationStatus === 'verified').length,
    };
  }

  /**
   * Export phone mappings for backup/restore
   */
  public exportMappings(): PhoneNumberMapping[] {
    return Array.from(this.phoneToSuiMappings.values());
  }

  /**
   * Import phone mappings from backup
   */
  public importMappings(mappings: PhoneNumberMapping[]): void {
    mappings.forEach(mapping => {
      this.phoneToSuiMappings.set(mapping.phoneNumber, mapping);
    });
    logger.info(`Imported ${mappings.length} phone number mappings`);
  }

  /**
   * Register a callback to be called when authentication completes
   */
  public registerCompletionCallback(
    phoneNumber: string, 
    callback: (phoneNumber: string, success: boolean, account?: AccountData) => void
  ): void {
    this.completionCallbacks.set(phoneNumber, callback);
    logger.info(`Registered completion callback for ${phoneNumber}`);
  }

  /**
   * Remove completion callback for a phone number
   */
  public removeCompletionCallback(phoneNumber: string): void {
    this.completionCallbacks.delete(phoneNumber);
  }

  /**
   * Clear pending authentication for a phone number
   */
  public clearPendingAuth(phoneNumber: string): void {
    // This method can be called by WhatsApp service to clear pending auth state
    logger.info(`Cleared pending auth for ${phoneNumber}`);
  }
} 