import { createLogger, format, transports } from 'winston';
import {
  CommandType,
  ParsedCommand,
  JoinCircleParams,
  ContributeParams,
  WithdrawParams,
  InviteParams,
  StatusParams,
  COMMAND_PATTERNS,
  COMMAND_ALIASES,
  COMMAND_ERRORS,
} from '../types/whatsapp-commands';

// Configure logger
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.File({ filename: 'whatsapp-command-parser.log' }),
    new transports.Console()
  ],
});

/**
 * 🚀 WhatsApp Command Parser Service
 * 
 * Parses WhatsApp messages and extracts commands with parameters
 * Supports aliases, validation, and comprehensive error handling
 */
export class WhatsAppCommandParserService {
  private static instance: WhatsAppCommandParserService;

  // Supported currencies
  private readonly SUPPORTED_CURRENCIES = ['USDC', 'USDT', 'SUI'];
  private readonly DEFAULT_CURRENCY = 'USDC';

  private constructor() {
    logger.info('WhatsApp Command Parser Service initialized');
  }

  public static getInstance(): WhatsAppCommandParserService {
    if (!WhatsAppCommandParserService.instance) {
      WhatsAppCommandParserService.instance = new WhatsAppCommandParserService();
    }
    return WhatsAppCommandParserService.instance;
  }

  /**
   * 🎯 MAIN PARSER: Parse incoming WhatsApp message into structured command
   */
  public parseMessage(message: string): ParsedCommand {
    try {
      // Normalize message
      const normalizedMessage = this.normalizeMessage(message);
      
      // Check for aliases first
      const resolvedMessage = this.resolveAliases(normalizedMessage);
      
      // Parse command type and parameters
      const commandType = this.extractCommandType(resolvedMessage);
      
      if (!commandType) {
        return this.createInvalidCommand(message, [COMMAND_ERRORS.UNKNOWN_COMMAND]);
      }

      // Parse parameters based on command type
      const parseResult = this.parseCommandParameters(commandType, resolvedMessage);
      
      return {
        type: commandType,
        rawText: message,
        parameters: parseResult.parameters,
        isValid: parseResult.isValid,
        errors: parseResult.errors,
        requiresAuth: this.requiresAuthentication(commandType),
        requiresMultiStep: this.requiresMultiStep(commandType),
      };

    } catch (error) {
      logger.error('Command parsing error:', error);
      return this.createInvalidCommand(message, ['Failed to parse command']);
    }
  }

  /**
   * 🧹 NORMALIZE: Clean and standardize message input
   */
  private normalizeMessage(message: string): string {
    return message
      .trim()
      .replace(/\s+/g, ' ') // Multiple spaces -> single space
      .toLowerCase();
  }

  /**
   * 🔄 ALIASES: Resolve command aliases to full commands
   */
  private resolveAliases(message: string): string {
    const firstWord = message.split(' ')[0];
    const alias = COMMAND_ALIASES.find(a => a.alias.toLowerCase() === firstWord);
    
    if (alias) {
      return message.replace(firstWord, `/${alias.command}`);
    }
    
    return message;
  }

  /**
   * 🎯 EXTRACT: Determine command type from message
   */
  private extractCommandType(message: string): CommandType | null {
    // Check each pattern
    for (const [key, pattern] of Object.entries(COMMAND_PATTERNS)) {
      if (pattern.test(message)) {
        return key.toLowerCase() as CommandType;
      }
    }
    
    return null;
  }

  /**
   * 📊 PARSE PARAMETERS: Extract and validate command parameters
   */
  private parseCommandParameters(commandType: CommandType, message: string): {
    parameters: Record<string, unknown>;
    isValid: boolean;
    errors: string[];
  } {
    try {
      switch (commandType) {
        case 'auth':
        case 'help':
        case 'circles':
        case 'balance':
          return { parameters: {}, isValid: true, errors: [] };

        case 'create':
          return this.parseCreateCommand(message);

        case 'join':
          return this.parseJoinCommand(message);

        case 'contribute':
          return this.parseContributeCommand(message);

        case 'withdraw':
          return this.parseWithdrawCommand(message);

        case 'invite':
          return this.parseInviteCommand(message);

        case 'status':
          return this.parseStatusCommand(message);

        case 'leave':
        case 'rotate':
        case 'yield':
        case 'history':
        case 'settings':
          return this.parseCircleSpecificCommand(commandType, message);

        default:
          return { parameters: {}, isValid: false, errors: ['Unsupported command'] };
      }
    } catch (error) {
      logger.error(`Parameter parsing error for ${commandType}:`, error);
      return { parameters: {}, isValid: false, errors: ['Invalid command parameters'] };
    }
  }

  /**
   * 🎨 CREATE: Parse circle creation command
   */
  private parseCreateCommand(message: string): {
    parameters: Record<string, unknown>;
    isValid: boolean;
    errors: string[];
  } {
    const match = COMMAND_PATTERNS.CREATE.exec(message);
    
    // If no parameters provided, it's a multi-step command
    if (!match || !match[1]) {
      return {
        parameters: {},
        isValid: true,
        errors: [],
      };
    }

    // Try to parse inline parameters
    const params = match[1].trim();
    
    // Simple parsing for now - can be enhanced for complex inline syntax
    return {
      parameters: { name: params },
      isValid: true,
      errors: [],
    };
  }

  /**
   * 🤝 JOIN: Parse circle join command
   */
  private parseJoinCommand(message: string): {
    parameters: Record<string, unknown>;
    isValid: boolean;
    errors: string[];
  } {
    const match = COMMAND_PATTERNS.JOIN.exec(message);
    
    if (!match || !match[1]) {
      return {
        parameters: {},
        isValid: false,
        errors: [COMMAND_ERRORS.INVALID_CIRCLE_ID],
      };
    }

    const params: JoinCircleParams = {
      circleId: match[1].trim(),
    };

    if (match[2]) {
      params.inviteCode = match[2].trim();
    }

    return {
      parameters: params as unknown as Record<string, unknown>,
      isValid: true,
      errors: [],
    };
  }

  /**
   * 💰 CONTRIBUTE: Parse contribution command
   */
  private parseContributeCommand(message: string): {
    parameters: Record<string, unknown>;
    isValid: boolean;
    errors: string[];
  } {
    const match = COMMAND_PATTERNS.CONTRIBUTE.exec(message);
    
    if (!match || !match[1]) {
      return {
        parameters: {},
        isValid: false,
        errors: [COMMAND_ERRORS.INVALID_AMOUNT],
      };
    }

    const amount = parseFloat(match[1]);
    if (isNaN(amount) || amount <= 0) {
      return {
        parameters: {},
        isValid: false,
        errors: [COMMAND_ERRORS.INVALID_AMOUNT],
      };
    }

    const currency = match[2]?.toUpperCase() || this.DEFAULT_CURRENCY;
    if (!this.SUPPORTED_CURRENCIES.includes(currency)) {
      return {
        parameters: {},
        isValid: false,
        errors: [COMMAND_ERRORS.INVALID_CURRENCY],
      };
    }

    const params: ContributeParams = {
      amount,
      currency,
    };

    if (match[3]) {
      params.circleId = match[3].trim();
    }

    return {
      parameters: params as unknown as Record<string, unknown>,
      isValid: true,
      errors: [],
    };
  }

  /**
   * 💸 WITHDRAW: Parse withdrawal command
   */
  private parseWithdrawCommand(message: string): {
    parameters: Record<string, unknown>;
    isValid: boolean;
    errors: string[];
  } {
    const match = COMMAND_PATTERNS.WITHDRAW.exec(message);
    
    const params: WithdrawParams = {};

    if (match && match[1]) {
      const amount = parseFloat(match[1]);
      if (isNaN(amount) || amount <= 0) {
        return {
          parameters: {},
          isValid: false,
          errors: [COMMAND_ERRORS.INVALID_AMOUNT],
        };
      }
      params.amount = amount;
    }

    if (match && match[2]) {
      const currency = match[2].toUpperCase();
      if (!this.SUPPORTED_CURRENCIES.includes(currency)) {
        return {
          parameters: {},
          isValid: false,
          errors: [COMMAND_ERRORS.INVALID_CURRENCY],
        };
      }
      params.currency = currency;
    }

    if (match && match[3]) {
      params.circleId = match[3].trim();
    }

    return {
      parameters: params as unknown as Record<string, unknown>,
      isValid: true,
      errors: [],
    };
  }

  /**
   * 📱 INVITE: Parse invitation command
   */
  private parseInviteCommand(message: string): {
    parameters: Record<string, unknown>;
    isValid: boolean;
    errors: string[];
  } {
    const match = COMMAND_PATTERNS.INVITE.exec(message);
    
    if (!match || !match[1]) {
      return {
        parameters: {},
        isValid: false,
        errors: [COMMAND_ERRORS.INVALID_PHONE],
      };
    }

    const phoneNumber = this.normalizePhoneNumber(match[1]);
    if (!this.isValidPhoneNumber(phoneNumber)) {
      return {
        parameters: {},
        isValid: false,
        errors: [COMMAND_ERRORS.INVALID_PHONE],
      };
    }

    const params: InviteParams = {
      phoneNumber,
    };

    if (match[2]) {
      params.circleId = match[2].trim();
    }

    return {
      parameters: params as unknown as Record<string, unknown>,
      isValid: true,
      errors: [],
    };
  }

  /**
   * 📊 STATUS: Parse status command
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private parseStatusCommand(_message: string): {
    parameters: Record<string, unknown>;
    isValid: boolean;
    errors: string[];
  } {
    // Simple status command for now
    const params: StatusParams = {};
    
    // Can be enhanced to parse specific circle ID or detailed flag
    return {
      parameters: params as unknown as Record<string, unknown>,
      isValid: true,
      errors: [],
    };
  }

  /**
   * 🔧 CIRCLE SPECIFIC: Parse commands that operate on specific circles
   */
  private parseCircleSpecificCommand(commandType: CommandType, message: string): {
    parameters: Record<string, unknown>;
    isValid: boolean;
    errors: string[];
  } {
    // Extract circle ID if provided
    const parts = message.split(' ');
    const params: Record<string, unknown> = {};
    
    if (parts.length > 1) {
      params.circleId = parts[1];
    }

    return {
      parameters: params,
      isValid: true,
      errors: [],
    };
  }

  /**
   * 📞 PHONE: Normalize phone number format
   */
  private normalizePhoneNumber(phone: string): string {
    // Remove all non-digit characters except +
    let normalized = phone.replace(/[^\d+]/g, '');
    
    // Ensure it starts with +
    if (!normalized.startsWith('+')) {
      normalized = '+' + normalized;
    }
    
    return normalized;
  }

  /**
   * ✅ VALIDATION: Check if phone number is valid
   */
  private isValidPhoneNumber(phone: string): boolean {
    // Basic validation: + followed by 7-15 digits
    return /^\+\d{7,15}$/.test(phone);
  }

  /**
   * 🔐 AUTH CHECK: Determine if command requires authentication
   */
  private requiresAuthentication(commandType: CommandType): boolean {
    const noAuthRequired = ['auth', 'help'];
    return !noAuthRequired.includes(commandType);
  }

  /**
   * 📋 MULTI-STEP: Determine if command requires multi-step interaction
   */
  private requiresMultiStep(commandType: CommandType): boolean {
    const multiStepCommands = ['create'];
    return multiStepCommands.includes(commandType);
  }

  /**
   * ❌ INVALID: Create invalid command result
   */
  private createInvalidCommand(message: string, errors: string[]): ParsedCommand {
    return {
      type: 'help', // Default to help for unknown commands
      rawText: message,
      parameters: {},
      isValid: false,
      errors,
      requiresAuth: false,
      requiresMultiStep: false,
    };
  }

  /**
   * 📝 HELP: Generate help message for available commands
   */
  public generateHelpMessage(): string {
    return `
🤖 **Njangi Circle Commands**

**Authentication:**
• \`/auth\` - Link your WhatsApp to Sui wallet

**Circle Management:**
• \`/create\` - Start new circle
• \`/join [circle-id]\` - Join existing circle
• \`/circles\` - List your circles
• \`/leave [circle-id]\` - Leave a circle

**Financial Operations:**
• \`/contribute [amount] [currency]\` - Add money to circle
• \`/withdraw [amount] [currency]\` - Withdraw your funds
• \`/balance\` - Check your balance

**Information:**
• \`/status\` - Check circle status
• \`/history\` - View transaction history
• \`/yield\` - Check DeFi yields

**Social:**
• \`/invite [phone-number]\` - Invite someone to circle

**Shortcuts:**
• \`/c\` = contribute, \`/w\` = withdraw, \`/j\` = join
• \`/s\` = status, \`/b\` = balance, \`/h\` = help

**Examples:**
• \`/contribute 100 USDC\`
• \`/join ABC123\`
• \`/invite +1234567890\`

Type any command to get started! 🚀
    `.trim();
  }

  /**
   * 📊 STATS: Get parser statistics
   */
  public getStats(): Record<string, unknown> {
    return {
      supportedCommands: Object.keys(COMMAND_PATTERNS).length,
      supportedAliases: COMMAND_ALIASES.length,
      supportedCurrencies: this.SUPPORTED_CURRENCIES,
      defaultCurrency: this.DEFAULT_CURRENCY,
    };
  }
}

// Export singleton instance
export const commandParser = WhatsAppCommandParserService.getInstance(); 