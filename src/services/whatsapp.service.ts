import axios, { AxiosResponse } from 'axios';
import crypto from 'crypto';
import { createLogger, format, transports } from 'winston';
import { 
  WhatsAppMessage, 
  WhatsAppAPIResponse, 
  WhatsAppWebhookPayload, 
  WhatsAppWebhookMessage,
  WhatsAppTextMessage,
  WhatsAppInteractiveMessage,
  WhatsAppTemplateMessage,
  WhatsAppUserSession,
  WhatsAppAuditLog
} from '../types/whatsapp';
import { 
  whatsappConfig, 
  whatsappApiUrl, 
  sessionConfig, 
  errorMessages,
  successMessages
} from '../config/whatsapp.config';
import { WhatsAppAuthBridgeService } from './whatsapp-auth-bridge.service';

// Configure logger
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.File({ filename: 'whatsapp.log' }),
    new transports.Console()
  ],
});

export class WhatsAppService {
  private static instance: WhatsAppService;
  private sessions: Map<string, WhatsAppUserSession> = new Map();
  private auditLogs: WhatsAppAuditLog[] = [];
  private authBridge: WhatsAppAuthBridgeService;

  private constructor() {
    this.authBridge = WhatsAppAuthBridgeService.getInstance();
    this.initializeService();
  }

  public static getInstance(): WhatsAppService {
    if (!WhatsAppService.instance) {
      WhatsAppService.instance = new WhatsAppService();
    }
    return WhatsAppService.instance;
  }

  private initializeService(): void {
    // Clean up expired sessions every 5 minutes
    setInterval(() => {
      this.cleanupExpiredSessions();
    }, 5 * 60 * 1000);

    logger.info('WhatsApp service initialized');
  }

  /**
   * Verify webhook signature for security
   */
  public verifyWebhookSignature(payload: string, signature: string): boolean {
    try {
      const expectedSignature = crypto
        .createHmac('sha256', whatsappConfig.appSecret)
        .update(payload)
        .digest('hex');
      
      const signatureHash = signature.replace('sha256=', '');
      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(signatureHash)
      );
    } catch (error) {
      logger.error('Webhook signature verification failed:', error);
      return false;
    }
  }

  /**
   * Handle incoming webhook messages
   */
  public async handleWebhookMessage(payload: WhatsAppWebhookPayload): Promise<void> {
    try {
      for (const entry of payload.entry) {
        for (const change of entry.changes) {
          if (change.field === 'messages' && change.value.messages) {
            for (const message of change.value.messages) {
              await this.processIncomingMessage(message);
            }
          }
        }
      }
    } catch (error) {
      logger.error('Error handling webhook message:', error);
      throw error;
    }
  }

  /**
   * Process individual incoming messages
   */
  private async processIncomingMessage(message: WhatsAppWebhookMessage): Promise<void> {
    const phoneNumber = message.from;
    const messageText = message.text?.body || '';
    
    logger.info(`Processing message from ${phoneNumber}: ${messageText}`);
    
    try {
      // Get or create user session
      let session = this.getSession(phoneNumber);
      if (!session) {
        session = this.createSession(phoneNumber);
      }

      // Update last activity
      session.lastActivity = new Date();
      
      // Log the interaction
      await this.logAuditEvent(phoneNumber, 'message_received', {
        messageId: message.id,
        messageType: message.type,
        content: messageText,
      });

      // For now, just send a simple response
      // This will be expanded with command parsing and flow management
      await this.sendWelcomeMessage(phoneNumber);

    } catch (error) {
      logger.error(`Error processing message from ${phoneNumber}:`, error);
      await this.sendErrorMessage(phoneNumber, errorMessages.NETWORK_ERROR);
    }
  }

  /**
   * Send a text message
   */
  public async sendTextMessage(phoneNumber: string, text: string): Promise<WhatsAppAPIResponse | null> {
    const message: WhatsAppTextMessage = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'text',
      text: {
        body: text,
      },
    };

    return this.sendMessage(message);
  }

  /**
   * Send an interactive message with buttons
   */
  public async sendInteractiveMessage(
    phoneNumber: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>,
    headerText?: string,
    footerText?: string
  ): Promise<WhatsAppAPIResponse | null> {
    const message: WhatsAppInteractiveMessage = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: headerText ? {
          type: 'text',
          text: headerText,
        } : undefined,
        body: {
          text: bodyText,
        },
        footer: footerText ? {
          text: footerText,
        } : undefined,
        action: {
          buttons: buttons.map(button => ({
            type: 'reply',
            reply: {
              id: button.id,
              title: button.title,
            },
          })),
        },
      },
    };

    return this.sendMessage(message);
  }

  /**
   * Send a template message
   */
  public async sendTemplateMessage(
    phoneNumber: string,
    templateName: string,
    languageCode: string = 'en',
    parameters?: Array<{ type: 'text'; text: string }>
  ): Promise<WhatsAppAPIResponse | null> {
    const message: WhatsAppTemplateMessage = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'template',
      template: {
        name: templateName,
        language: {
          code: languageCode,
        },
        components: parameters ? [{
          type: 'body',
          parameters: parameters,
        }] : undefined,
      },
    };

    return this.sendMessage(message);
  }

  /**
   * Generic message sending method
   */
  private async sendMessage(message: WhatsAppMessage): Promise<WhatsAppAPIResponse | null> {
    try {
      const response: AxiosResponse<WhatsAppAPIResponse> = await axios.post(
        whatsappApiUrl,
        message,
        {
          headers: {
            'Authorization': `Bearer ${whatsappConfig.accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      logger.info(`Message sent successfully to ${message.to}`);
      
      // Log the sent message
      await this.logAuditEvent(message.to, 'message_sent', {
        messageType: message.type,
        success: true,
      });

      return response.data;
    } catch (error) {
      logger.error(`Failed to send message to ${message.to}:`, error);
      
      // Log the failure
      await this.logAuditEvent(message.to, 'message_send_failed', {
        messageType: message.type,
        error: error instanceof Error ? error.message : 'Unknown error',
        success: false,
      });
      
      return null;
    }
  }

  /**
   * Send welcome message to new users
   */
  private async sendWelcomeMessage(phoneNumber: string): Promise<void> {
    // Check if user is authenticated
    const isAuthenticated = this.authBridge.isPhoneNumberAuthenticated(phoneNumber);
    
    let welcomeText: string;
    
    if (isAuthenticated) {
      const status = this.authBridge.getAuthenticationStatus(phoneNumber);
      welcomeText = `Welcome back to Njangi! 🎉\n\n${successMessages.AUTHENTICATION_SUCCESS}\n\nYour Sui Address: ${status.suiAddress}\n\nI can help you:\n• Create new savings circles (/create)\n• Join existing circles (/join)\n• Make contributions (/contribute)\n• Check your status (/status)\n\nType /help to see all available commands.`;
    } else {
      welcomeText = `Welcome to Njangi! 🎉\n\nI'm your Njangi assistant. To get started, you'll need to authenticate your account.\n\nType /auth to connect your phone number to a blockchain address.\n\nAfter authentication, I can help you:\n• Create new savings circles\n• Join existing circles\n• Make contributions\n• Check your status\n\nType /help to see all available commands.`;
    }
    
    await this.sendTextMessage(phoneNumber, welcomeText);
  }

  /**
   * Handle authentication command
   */
  public async handleAuthenticationCommand(phoneNumber: string, provider: 'Google' | 'Facebook' | 'Apple' = 'Google'): Promise<void> {
    try {
      // Check if already authenticated
      if (this.authBridge.isPhoneNumberAuthenticated(phoneNumber)) {
        const status = this.authBridge.getAuthenticationStatus(phoneNumber);
        await this.sendTextMessage(
          phoneNumber, 
          `✅ You're already authenticated!\n\nSui Address: ${status.suiAddress}\nProvider: ${status.provider}\nLast authenticated: ${status.lastAuthenticated?.toLocaleString()}`
        );
        return;
      }

      // Initiate authentication
      const result = await this.authBridge.initiateAuthentication(phoneNumber, provider);

      if (result.success && result.authUrl) {
        await this.sendTextMessage(
          phoneNumber,
          `🔐 Please complete your authentication:\n\n👉 ${result.authUrl}\n\nThis link will expire in 30 minutes. After authenticating, you'll be able to manage your Njangi circles!`
        );
      } else {
        await this.sendErrorMessage(phoneNumber, result.error || 'Failed to start authentication');
      }

    } catch (error) {
      logger.error(`Authentication command failed for ${phoneNumber}:`, error);
      await this.sendErrorMessage(phoneNumber, errorMessages.NETWORK_ERROR);
    }
  }

  /**
   * Check if user is authenticated for restricted commands
   */
  public isUserAuthenticated(phoneNumber: string): boolean {
    return this.authBridge.isPhoneNumberAuthenticated(phoneNumber);
  }

  /**
   * Get user's Sui address
   */
  public getUserSuiAddress(phoneNumber: string): string | null {
    return this.authBridge.getSuiAddressForPhone(phoneNumber);
  }

  /**
   * Get user's account data
   */
  public getUserAccountData(phoneNumber: string) {
    return this.authBridge.getAccountDataForPhone(phoneNumber);
  }

  /**
   * Send authentication required message
   */
  public async sendAuthenticationRequired(phoneNumber: string): Promise<void> {
    await this.sendTextMessage(
      phoneNumber,
      `🔒 ${errorMessages.AUTHENTICATION_REQUIRED}\n\nType /auth to authenticate your account.`
    );
  }

  /**
   * Send error message to user
   */
  private async sendErrorMessage(phoneNumber: string, errorMessage: string): Promise<void> {
    await this.sendTextMessage(phoneNumber, `❌ ${errorMessage}`);
  }

  /**
   * Session management methods
   */
  public getSession(phoneNumber: string): WhatsAppUserSession | null {
    return this.sessions.get(phoneNumber) || null;
  }

  public createSession(phoneNumber: string): WhatsAppUserSession {
    const session: WhatsAppUserSession = {
      phoneNumber,
      isAuthenticated: false,
      lastActivity: new Date(),
    };
    
    this.sessions.set(phoneNumber, session);
    logger.info(`Created new session for ${phoneNumber}`);
    
    return session;
  }

  public updateSession(phoneNumber: string, updates: Partial<WhatsAppUserSession>): void {
    const session = this.sessions.get(phoneNumber);
    if (session) {
      Object.assign(session, updates, { lastActivity: new Date() });
      this.sessions.set(phoneNumber, session);
    }
  }

  public deleteSession(phoneNumber: string): void {
    this.sessions.delete(phoneNumber);
    logger.info(`Deleted session for ${phoneNumber}`);
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    const expiredSessions: string[] = [];

    for (const [phoneNumber, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > sessionConfig.sessionTimeout) {
        expiredSessions.push(phoneNumber);
      }
    }

    expiredSessions.forEach(phoneNumber => {
      this.deleteSession(phoneNumber);
    });

    if (expiredSessions.length > 0) {
      logger.info(`Cleaned up ${expiredSessions.length} expired sessions`);
    }
  }

  /**
   * Audit logging
   */
  private async logAuditEvent(
    phoneNumber: string,
    action: string,
    details: Record<string, unknown>,
    success: boolean = true,
    errorMessage?: string
  ): Promise<void> {
    const auditLog: WhatsAppAuditLog = {
      id: crypto.randomUUID(),
      userId: phoneNumber,
      phoneNumber,
      action,
      details,
      timestamp: new Date(),
      success,
      errorMessage,
    };

    this.auditLogs.push(auditLog);
    
    // Keep only last 1000 audit logs in memory
    if (this.auditLogs.length > 1000) {
      this.auditLogs = this.auditLogs.slice(-1000);
    }

    logger.info('Audit log created:', auditLog);
  }

  /**
   * Get audit logs for a specific user
   */
  public getAuditLogs(phoneNumber: string, limit: number = 50): WhatsAppAuditLog[] {
    return this.auditLogs
      .filter(log => log.phoneNumber === phoneNumber)
      .slice(-limit);
  }

  /**
   * Health check method
   */
  public async healthCheck(): Promise<boolean> {
    try {
      // Try to send a test message to verify API connectivity
      const testMessage = {
        messaging_product: 'whatsapp',
        to: whatsappConfig.phoneNumberId, // Send to self
        type: 'text',
        text: { body: 'Health check' },
      };

      const response = await axios.post(whatsappApiUrl, testMessage, {
        headers: {
          'Authorization': `Bearer ${whatsappConfig.accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      return response.status === 200;
    } catch (error) {
      logger.error('Health check failed:', error);
      return false;
    }
  }

  /**
   * Get service statistics
   */
  public getStats(): Record<string, unknown> {
    return {
      activeSessions: this.sessions.size,
      totalAuditLogs: this.auditLogs.length,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    };
  }
} 