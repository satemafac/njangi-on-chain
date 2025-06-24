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
  errorMessages
} from '../config/whatsapp.config';
import { WhatsAppAuthBridgeService } from './whatsapp-auth-bridge.service';
import { WhatsAppCommandParserService } from './whatsapp-command-parser.service';
import { WhatsAppConversationFlowService } from './whatsapp-conversation-flow.service';
import { ParsedCommand } from '../types/whatsapp-commands';

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
  private commandParser: WhatsAppCommandParserService;
  private conversationFlow: WhatsAppConversationFlowService;

  private constructor() {
    this.authBridge = WhatsAppAuthBridgeService.getInstance();
    this.commandParser = WhatsAppCommandParserService.getInstance();
    this.conversationFlow = WhatsAppConversationFlowService.getInstance();
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

      // Check if user is in an active conversation flow
      const activeFlow = this.conversationFlow.getCurrentFlow(phoneNumber);
      
      if (activeFlow) {
        // Handle ongoing conversation
        await this.handleConversationInput(phoneNumber, messageText);
      } else {
        // Parse new command
        await this.handleNewCommand(phoneNumber, messageText);
      }

    } catch (error) {
      logger.error(`Error processing message from ${phoneNumber}:`, error);
      await this.sendErrorMessage(phoneNumber, errorMessages.NETWORK_ERROR);
    }
  }

  /**
   * Handle input during active conversation flow
   */
  private async handleConversationInput(phoneNumber: string, input: string): Promise<void> {
    const result = this.conversationFlow.processInput(phoneNumber, input);
    
    if (result.isComplete) {
      // Conversation finished
      if (result.success && result.result) {
        // Execute the completed command
        await this.executeCompletedCommand(phoneNumber, result.result);
      } else {
        // Conversation failed or cancelled
        await this.sendTextMessage(phoneNumber, result.message);
      }
    } else {
      // Continue conversation
      let response = result.message;
      if (result.nextPrompt) {
        response += '\n\n' + result.nextPrompt;
      }
      await this.sendTextMessage(phoneNumber, response);
    }
  }

  /**
   * Handle new command from user
   */
  private async handleNewCommand(phoneNumber: string, messageText: string): Promise<void> {
    const parsedCommand = this.commandParser.parseMessage(messageText);
    
    logger.info(`Parsed command for ${phoneNumber}:`, parsedCommand);

    // Handle invalid commands
    if (!parsedCommand.isValid) {
      if (parsedCommand.type === 'help') {
        await this.sendHelpMessage(phoneNumber);
      } else {
        await this.sendTextMessage(
          phoneNumber, 
          `❌ ${parsedCommand.errors.join(', ')}\n\nType /help to see available commands.`
        );
      }
      return;
    }

    // Check authentication requirement
    if (parsedCommand.requiresAuth && !this.isUserAuthenticated(phoneNumber)) {
      await this.sendAuthenticationRequired(phoneNumber);
      return;
    }

    // Handle multi-step commands
    if (parsedCommand.requiresMultiStep) {
      const prompt = this.conversationFlow.startFlow(phoneNumber, parsedCommand.type);
      await this.sendTextMessage(phoneNumber, prompt);
      return;
    }

    // Handle single-step commands
    await this.executeSingleStepCommand(phoneNumber, parsedCommand);
  }

  /**
   * Execute single-step commands immediately
   */
  private async executeSingleStepCommand(phoneNumber: string, parsedCommand: ParsedCommand): Promise<void> {
    switch (parsedCommand.type) {
      case 'help':
        await this.sendHelpMessage(phoneNumber);
        break;

      case 'auth':
        await this.handleAuthenticationCommand(phoneNumber);
        break;

      case 'status':
        await this.handleStatusCommand(phoneNumber);
        break;

      case 'circles':
        await this.handleCirclesCommand(phoneNumber);
        break;

      case 'balance':
        await this.handleBalanceCommand(phoneNumber);
        break;

      case 'join':
        await this.handleJoinCommand(phoneNumber, parsedCommand.parameters);
        break;

      case 'contribute':
        await this.handleContributeCommand(phoneNumber, parsedCommand.parameters);
        break;

      default:
        await this.sendTextMessage(
          phoneNumber, 
          `🚧 The "${parsedCommand.type}" command is coming soon!\n\nType /help to see available commands.`
        );
    }
  }

  /**
   * Execute completed multi-step commands
   */
  private async executeCompletedCommand(phoneNumber: string, commandData: Record<string, unknown>): Promise<void> {
    // This would integrate with your circle creation logic
    await this.sendTextMessage(
      phoneNumber,
      `🎉 Circle creation completed!\n\n📋 **Summary:**\n• Type: ${commandData.circleType}\n• Currency: ${commandData.currency}\n• Name: ${commandData.name}\n• Contribution: ${commandData.contributionAmount} ${commandData.currency}\n• Cycle: ${commandData.cycleLength}\n\n🔗 Circle will be created on the blockchain. You'll receive a confirmation shortly.`
    );
  }

  /**
   * Send help message
   */
  private async sendHelpMessage(phoneNumber: string): Promise<void> {
    const helpText = this.commandParser.generateHelpMessage();
    await this.sendTextMessage(phoneNumber, helpText);
  }

  /**
   * Handle status command
   */
  private async handleStatusCommand(phoneNumber: string): Promise<void> {
    if (!this.isUserAuthenticated(phoneNumber)) {
      await this.sendAuthenticationRequired(phoneNumber);
      return;
    }

    const userAddress = this.getUserSuiAddress(phoneNumber);
    await this.sendTextMessage(
      phoneNumber,
      `📊 **Your Status**\n\n🏦 Sui Address: ${userAddress}\n📱 Phone: ${phoneNumber}\n\n💡 Type /circles to see your circles or /balance to check balances.`
    );
  }

  /**
   * Handle circles command
   */
  private async handleCirclesCommand(phoneNumber: string): Promise<void> {
    await this.sendTextMessage(
      phoneNumber,
      `🔄 **Your Circles**\n\n🚧 Circle listing is coming soon!\n\nFor now, you can:\n• /create - Start a new circle\n• /join [circle-id] - Join an existing circle`
    );
  }

  /**
   * Handle balance command
   */
  private async handleBalanceCommand(phoneNumber: string): Promise<void> {
    await this.sendTextMessage(
      phoneNumber,
      `💰 **Your Balance**\n\n🚧 Balance checking is coming soon!\n\nThis will show your:\n• Wallet balances\n• Circle contributions\n• Pending payouts`
    );
  }

  /**
   * Handle join command
   */
  private async handleJoinCommand(phoneNumber: string, parameters: Record<string, unknown>): Promise<void> {
    const circleId = parameters.circleId;
    await this.sendTextMessage(
      phoneNumber,
      `🤝 **Join Circle**\n\n🚧 Circle joining is coming soon!\n\nYou want to join circle: ${circleId}\n\nThis will check circle availability and start the joining process.`
    );
  }

  /**
   * Handle contribute command
   */
  private async handleContributeCommand(phoneNumber: string, parameters: Record<string, unknown>): Promise<void> {
    const { amount, currency, circleId } = parameters;
    await this.sendTextMessage(
      phoneNumber,
      `💰 **Make Contribution**\n\n🚧 Contributions are coming soon!\n\nYou want to contribute:\n• Amount: ${amount} ${currency}\n• Circle: ${circleId || 'default'}\n\nThis will process your contribution to the circle.`
    );
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