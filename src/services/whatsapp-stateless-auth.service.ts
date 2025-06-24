import crypto from 'crypto';
import { createLogger, format, transports } from 'winston';
import { WhatsAppUserSession } from '../types/whatsapp';
import { OAuthProvider, SetupData } from '../services/zkLoginService';
import { EnokiZkLoginService } from '../services/enokiZkLoginService';

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

export interface WhatsAppAuthTokenWithSetup extends WhatsAppAuthToken {
  setupData?: SetupData;
}

export interface AuthenticationResult {
  success: boolean;
  suiAddress?: string;
  error?: string;
  authUrl?: string;
  isNewAuthentication?: boolean;
}

// ✅ STATELESS: Minimal in-memory data with built-in expiration
export interface StatelessPhoneMapping {
  phoneNumber: string;
  suiAddress: string;
  provider: OAuthProvider;
  userSub: string;
  authenticatedAt: Date;
  expiresAt: Date; // ✨ Auto-expiring sessions
  lastActivity: Date;
  verificationStatus: 'verified' | 'pending' | 'failed';
}

/**
 * 🚀 STATELESS WhatsApp Authentication Service
 * 
 * Key Features:
 * - Pure in-memory storage (no database required)
 * - Auto-expiring sessions with smart refresh
 * - Graceful degradation on service restart
 * - Seamless re-authentication patterns
 * - Enoki integration for all sensitive operations
 */
export class StatelessWhatsAppAuthService {
  private static instance: StatelessWhatsAppAuthService;
  
  // ✨ Pure in-memory storage - no persistence needed
  private authTokens: Map<string, WhatsAppAuthTokenWithSetup> = new Map();
  private phoneMappings: Map<string, StatelessPhoneMapping> = new Map();
  private enokiService: EnokiZkLoginService;
  
  // ⚙️ Configuration
  private readonly SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours
  private readonly AUTH_TOKEN_DURATION = 30 * 60 * 1000; // 30 minutes
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

  private constructor() {
    this.enokiService = EnokiZkLoginService.getInstance();
    this.initializeService();
  }

  public static getInstance(): StatelessWhatsAppAuthService {
    if (!StatelessWhatsAppAuthService.instance) {
      StatelessWhatsAppAuthService.instance = new StatelessWhatsAppAuthService();
    }
    return StatelessWhatsAppAuthService.instance;
  }

  private initializeService(): void {
    // 🧹 Auto-cleanup expired data
    setInterval(() => {
      this.cleanupExpiredData();
    }, this.CLEANUP_INTERVAL);

    logger.info('Stateless WhatsApp Auth Service initialized (no database required)');
  }

  /**
   * ✅ FAST: Check if phone is authenticated (in-memory lookup)
   */
  public isPhoneAuthenticated(phoneNumber: string): boolean {
    const mapping = this.phoneMappings.get(phoneNumber);
    if (!mapping) return false;
    
    // Check expiration
    if (new Date() > mapping.expiresAt) {
      this.phoneMappings.delete(phoneNumber);
      return false;
    }
    
    return mapping.verificationStatus === 'verified';
  }

  /**
   * ✅ FAST: Get Sui address (O(1) lookup)
   */
  public getSuiAddressForPhone(phoneNumber: string): string | null {
    const mapping = this.phoneMappings.get(phoneNumber);
    if (!mapping || mapping.verificationStatus !== 'verified') {
      return null;
    }

    // Check expiration
    if (new Date() > mapping.expiresAt) {
      this.phoneMappings.delete(phoneNumber);
      return null;
    }

    // Update last activity
    mapping.lastActivity = new Date();
    return mapping.suiAddress;
  }

  /**
   * 🔄 SMART: Handle authentication with graceful re-auth
   */
  public async handleAuthenticationRequest(
    phoneNumber: string,
    provider: OAuthProvider = 'Google'
  ): Promise<AuthenticationResult> {
    try {
      // Check if already authenticated and not expired
      if (this.isPhoneAuthenticated(phoneNumber)) {
        const suiAddress = this.getSuiAddressForPhone(phoneNumber)!;
        logger.info(`Phone ${phoneNumber} already authenticated with address ${suiAddress}`);
        
        return {
          success: true,
          suiAddress,
          isNewAuthentication: false
        };
      }

      // Start new authentication flow
      logger.info(`Starting fresh authentication for ${phoneNumber} with ${provider}`);
      return await this.initiateNewAuthentication(phoneNumber, provider);

    } catch (error) {
      logger.error(`Authentication request failed for ${phoneNumber}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Authentication failed',
      };
    }
  }

  /**
   * 🚀 SEAMLESS: Smart re-authentication for expired sessions
   */
  public async ensureAuthenticated(phoneNumber: string): Promise<AuthenticationResult> {
    if (this.isPhoneAuthenticated(phoneNumber)) {
      return {
        success: true,
        suiAddress: this.getSuiAddressForPhone(phoneNumber)!,
        isNewAuthentication: false
      };
    }
    
    // Session expired or service restarted - need fresh auth
    logger.info(`Session expired for ${phoneNumber}, requesting fresh authentication`);
    
    return {
      success: false,
      error: 'Authentication expired. Please authenticate again.',
      // Could include a fresh auth URL here
    };
  }

  /**
   * 🔐 SECURE: Initiate new authentication with Enoki
   */
  private async initiateNewAuthentication(
    phoneNumber: string,
    provider: OAuthProvider
  ): Promise<AuthenticationResult> {
    // Generate secure auth token
    const authToken = this.generateAuthToken(phoneNumber, provider);

    // ✅ Use Enoki's secure zkLogin flow
    const { loginUrl, setupData } = await this.enokiService.beginLogin(provider);

    // Store setup data with token for callback
    authToken.loginUrl = loginUrl;
    this.authTokens.set(authToken.id, { ...authToken, setupData });

    // Create authentication URL
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
    const authUrl = `${baseUrl}/auth/whatsapp?token=${authToken.token}&phone=${encodeURIComponent(phoneNumber)}&provider=${provider}`;

    logger.info(`Generated fresh auth URL for ${phoneNumber}`);

    return {
      success: true,
      authUrl,
      isNewAuthentication: true
    };
  }

  /**
   * ✅ SECURE: Complete authentication using Enoki
   */
  public async completeAuthentication(
    token: string,
    phoneNumber: string,
    jwtToken: string,
    setupData: SetupData
  ): Promise<AuthenticationResult> {
    try {
      // Find and validate auth token
      const authToken = this.findAuthTokenByToken(token);
      if (!authToken) {
        throw new Error('Invalid or expired authentication token');
      }

      this.validateAuthToken(authToken, phoneNumber);

      // ✅ Use Enoki's secure callback handling
      const authResult = await this.enokiService.handleCallback(jwtToken, setupData);

      // ✨ Store minimal mapping with auto-expiration
      const now = new Date();
      const mapping: StatelessPhoneMapping = {
        phoneNumber,
        suiAddress: authResult.address,
        provider: authToken.provider,
        userSub: authResult.sub,
        authenticatedAt: now,
        expiresAt: new Date(now.getTime() + this.SESSION_DURATION),
        lastActivity: now,
        verificationStatus: 'verified',
      };

      this.phoneMappings.set(phoneNumber, mapping);

      // Mark token as used
      authToken.used = true;

      logger.info(`Authentication completed for ${phoneNumber} -> ${authResult.address} (expires in ${this.SESSION_DURATION / 1000 / 60} minutes)`);

      return {
        success: true,
        suiAddress: authResult.address,
        isNewAuthentication: true
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
   * 🚀 BLOCKCHAIN: Execute operations with fresh Enoki credentials
   */
  public async executeBlockchainOperation<T>(
    phoneNumber: string,
    operationName: string,
    operation: (suiAddress: string) => Promise<T>
  ): Promise<T> {
    // Ensure user is authenticated
    const suiAddress = this.getSuiAddressForPhone(phoneNumber);
    if (!suiAddress) {
      throw new Error('User not authenticated. Please send /auth first.');
    }

    logger.info(`Executing ${operationName} for ${phoneNumber} (${suiAddress})`);

    // For blockchain operations, we use the address with fresh Enoki auth as needed
    // The actual transaction signing happens through Enoki's secure infrastructure
    return await operation(suiAddress);
  }

  /**
   * 📱 SESSION: Update WhatsApp session state
   */
  public getWhatsAppSession(phoneNumber: string): WhatsAppUserSession {
    const mapping = this.phoneMappings.get(phoneNumber);
    
    return {
      phoneNumber,
      suiAddress: mapping?.suiAddress || undefined,
      isAuthenticated: this.isPhoneAuthenticated(phoneNumber),
      authenticatedAt: mapping?.authenticatedAt || undefined,
      expiresAt: mapping?.expiresAt || undefined,
      lastActivity: mapping?.lastActivity || new Date(),
      conversationState: 'idle',
      currentCommand: undefined,
      commandData: {},
    };
  }

  /**
   * 🧹 MAINTENANCE: Cleanup expired data automatically
   */
  private cleanupExpiredData(): void {
    const now = new Date();
    let cleanedTokens = 0;
    let cleanedMappings = 0;

    // Clean expired auth tokens
    for (const [tokenId, authToken] of this.authTokens.entries()) {
      if (now > authToken.expiresAt || authToken.used) {
        this.authTokens.delete(tokenId);
        cleanedTokens++;
      }
    }

    // Clean expired phone mappings
    for (const [phoneNumber, mapping] of this.phoneMappings.entries()) {
      if (now > mapping.expiresAt) {
        this.phoneMappings.delete(phoneNumber);
        cleanedMappings++;
      }
    }

    if (cleanedTokens > 0 || cleanedMappings > 0) {
      logger.info(`Cleaned ${cleanedTokens} expired tokens and ${cleanedMappings} expired mappings`);
    }
  }

  /**
   * 📊 MONITORING: Get service statistics
   */
  public getServiceStats(): {
    activeTokens: number;
    authenticatedUsers: number;
    memoryUsage: string;
    uptime: string;
    storageType: string;
  } {
    const now = new Date();
    const activeMappings = Array.from(this.phoneMappings.values())
        .filter(mapping => now < mapping.expiresAt).length;

    return {
      activeTokens: this.authTokens.size,
      authenticatedUsers: activeMappings,
      memoryUsage: 'In-memory only',
      uptime: process.uptime().toString(),
      storageType: 'Stateless (no database)'
    };
  }

  // Helper methods
  private generateAuthToken(phoneNumber: string, provider: OAuthProvider): WhatsAppAuthToken {
    const tokenId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    
    return {
      id: tokenId,
      phoneNumber,
      token,
      provider,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.AUTH_TOKEN_DURATION),
      used: false,
    };
  }

  private findAuthTokenByToken(token: string): (WhatsAppAuthToken & { setupData?: SetupData }) | null {
    for (const authToken of this.authTokens.values()) {
      if (authToken.token === token) {
        return authToken as WhatsAppAuthToken & { setupData?: SetupData };
      }
    }
    return null;
  }

  private validateAuthToken(authToken: WhatsAppAuthToken, phoneNumber: string): void {
    if (authToken.phoneNumber !== phoneNumber) {
      throw new Error('Phone number mismatch');
    }

    if (authToken.used) {
      throw new Error('Authentication token already used');
    }

    if (new Date() > authToken.expiresAt) {
      throw new Error('Authentication token expired');
    }
  }
}

// 🚀 Export singleton for easy use
export const whatsappAuth = StatelessWhatsAppAuthService.getInstance(); 