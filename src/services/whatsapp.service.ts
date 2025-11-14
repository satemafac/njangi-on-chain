import { createLogger, format, transports } from 'winston';

/**
 * ⚠️ DEPRECATED SERVICE - DO NOT USE
 * 
 * This service is deprecated and kept only for backwards compatibility.
 * All WhatsApp functionality has been moved to the bot backend:
 * - whatsapp-bot-backend/src/services/circle-link-listener.service.ts
 * - whatsapp-bot-backend/src/services/whatsapp-sender.service.ts
 * - whatsapp-bot-backend/src/services/whatsapp-notification-handler.service.ts
 * - whatsapp-bot-backend/src/pages/api/whatsapp/webhook.ts
 */

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

  private constructor() {
    logger.warn('⚠️ DEPRECATED: WhatsAppService initialized - use bot backend instead');
  }

  public static getInstance(): WhatsAppService {
    if (!WhatsAppService.instance) {
      WhatsAppService.instance = new WhatsAppService();
    }
    return WhatsAppService.instance;
  }

  // Stub methods for backwards compatibility
  public verifyWebhookSignature(payload: string, signature: string): boolean {
    return false;
  }

  public async handleWebhookMessage(payload: any): Promise<void> {
    logger.warn('handleWebhookMessage is deprecated - use bot backend');
  }

  public getSession(phoneNumber: string): any {
    return null;
  }

  public createSession(phoneNumber: string): any {
    return null;
  }

  public async sendTextMessage(phoneNumber: string, message: string): Promise<void> {
    logger.warn('sendTextMessage is deprecated - use bot backend');
  }

  public async sendWelcomeMessage(phoneNumber: string): Promise<void> {
    logger.warn('sendWelcomeMessage is deprecated - use bot backend');
  }

  public async sendErrorMessage(phoneNumber: string, errorMessage: string): Promise<void> {
    logger.warn('sendErrorMessage is deprecated - use bot backend');
  }

  public async sendHelpMessage(phoneNumber: string): Promise<void> {
    logger.warn('sendHelpMessage is deprecated - use bot backend');
  }

  public isUserAuthenticated(phoneNumber: string): boolean {
    return false;
  }

  public async sendAuthenticationRequired(phoneNumber: string): Promise<void> {
    logger.warn('sendAuthenticationRequired is deprecated - use bot backend');
  }

  private cleanupExpiredSessions(): void {
    // No-op
  }

  private isGreeting(message: string): boolean {
    return false;
  }

  public async healthCheck(): Promise<boolean> {
    logger.warn('healthCheck is deprecated - use bot backend');
    return false;
  }
}

export const whatsappService = WhatsAppService.getInstance();
