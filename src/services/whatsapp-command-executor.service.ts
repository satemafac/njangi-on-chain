import { createLogger, format, transports } from 'winston';
import { 
  ParsedCommand, 
  CommandResult, 
  CreateCircleParams,
} from '../types/whatsapp-commands';
import { WhatsAppService } from './whatsapp.service';
import { whatsappAuth } from './whatsapp-stateless-auth.service';
import { conversationFlow } from './whatsapp-conversation-flow.service';
import { whatsappCircleManager } from './whatsapp-circle-manager.service';

// Create logger instance
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, stack }) => {
      return `${timestamp} [${level.toUpperCase()}] WhatsApp Command Executor: ${message}${stack ? `\n${stack}` : ''}`;
    })
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: '.taskmaster/logs/whatsapp-commands.log' })
  ]
});

/**
 * 🎯 WhatsApp Command Executor Service
 * 
 * Orchestrates the complete command processing pipeline:
 * - Authentication checks
 * - Conversation flow management  
 * - Command routing and execution
 * - Response handling
 */
export class WhatsAppCommandExecutorService {
  private static instance: WhatsAppCommandExecutorService;
  private whatsappService: WhatsAppService;

  private constructor() {
    this.whatsappService = WhatsAppService.getInstance();
  }

  public static getInstance(): WhatsAppCommandExecutorService {
    if (!WhatsAppCommandExecutorService.instance) {
      WhatsAppCommandExecutorService.instance = new WhatsAppCommandExecutorService();
    }
    return WhatsAppCommandExecutorService.instance;
  }

  /**
   * 🚀 MAIN ENTRY: Process WhatsApp message through complete pipeline
   */
  public async processMessage(phoneNumber: string, messageText: string): Promise<void> {
    try {
      logger.info(`Processing message from ${phoneNumber}: "${messageText}"`);

      // Check if user is in an active conversation flow
      const activeFlow = conversationFlow.getCurrentFlow(phoneNumber);
      if (activeFlow) {
        await this.handleActiveFlow(phoneNumber, messageText);
        return;
      }

      // Parse command from message
      const command = await this.parseCommand(messageText);
      if (!command.isValid) {
        await this.sendErrorResponse(phoneNumber, command.errors.join('\n'));
        return;
      }

      // Execute the command
      await this.executeCommand(phoneNumber, command);

    } catch (error) {
      logger.error(`Message processing failed for ${phoneNumber}:`, error);
      await this.sendErrorResponse(phoneNumber, 'An unexpected error occurred. Please try again.');
    }
  }

  /**
   * 🔄 ACTIVE FLOW: Handle ongoing conversation
   */
  private async handleActiveFlow(phoneNumber: string, input: string): Promise<void> {
    try {
      const result = conversationFlow.processInput(phoneNumber, input);

      if (result.isComplete && result.result) {
        // Flow completed successfully
        await this.handleCompletedFlow(phoneNumber, result.result);
      } else if (!result.success) {
        // Flow had an error
        await this.whatsappService.sendTextMessage(phoneNumber, `❌ ${result.message}`);
      } else if (result.nextPrompt) {
        // Flow continues, send next prompt
        await this.whatsappService.sendTextMessage(phoneNumber, result.nextPrompt);
      } else {
        // Flow continues, get next prompt manually
        const nextPrompt = conversationFlow.getNextPrompt(phoneNumber);
        await this.whatsappService.sendTextMessage(phoneNumber, nextPrompt);
      }

    } catch (error) {
      logger.error(`Active flow handling failed for ${phoneNumber}:`, error);
      conversationFlow.endFlow(phoneNumber);
      await this.sendErrorResponse(phoneNumber, 'Flow cancelled due to error. Please start over.');
    }
  }

  /**
   * ✅ FLOW COMPLETION: Handle completed conversation flow
   */
  private async handleCompletedFlow(phoneNumber: string, flowResult: Record<string, unknown>): Promise<void> {
    try {
      // Determine flow type and handle accordingly
      const flow = conversationFlow.getCurrentFlow(phoneNumber);
      if (!flow?.currentCommand) {
        throw new Error('Invalid flow state');
      }

      logger.info(`Handling completed ${flow.currentCommand} flow for ${phoneNumber}`);

      let result: CommandResult;
      
      switch (flow.currentCommand) {
        case 'create':
          // Handle circle creation with blockchain integration
          const circleData = flowResult as unknown as CreateCircleParams;
          result = await whatsappCircleManager.createCircle(phoneNumber, circleData);
          break;

        default:
          result = {
            success: false,
            message: `Flow type "${flow.currentCommand}" not yet implemented.`
          };
      }

      // Clean up the flow
      conversationFlow.endFlow(phoneNumber);

      // Send result to user
      if (result.success) {
        await this.whatsappService.sendTextMessage(phoneNumber, result.message);
        
        // If there's transaction info, send additional details
        if (result.transactionId) {
          const txMessage = `\n🔗 **Transaction Details**\nID: ${result.transactionId}\n\nYou can view this transaction on the Sui Explorer.`;
          setTimeout(() => {
            this.whatsappService.sendTextMessage(phoneNumber, txMessage);
          }, 1000);
        }
      } else {
        await this.sendErrorResponse(phoneNumber, result.message);
      }

    } catch (error) {
      logger.error(`Flow completion failed for ${phoneNumber}:`, error);
      conversationFlow.endFlow(phoneNumber);
      await this.sendErrorResponse(phoneNumber, 'Operation failed. Please try again.');
    }
  }

  /**
   * ⚡ COMMAND EXECUTION: Route and execute parsed commands
   */
  private async executeCommand(phoneNumber: string, command: ParsedCommand): Promise<void> {
    try {
      let result: CommandResult;

      // Check authentication for protected commands
      if (command.requiresAuth && !whatsappAuth.isPhoneAuthenticated(phoneNumber)) {
        result = {
          success: false,
          message: '🔐 Authentication required! Send /auth to connect your wallet.'
        };
        await this.whatsappService.sendTextMessage(phoneNumber, result.message);
        return;
      }

      // Route to appropriate handler
      switch (command.type) {
        case 'auth':
          result = await this.handleAuthCommand(phoneNumber);
          break;

        case 'help':
          result = await this.handleHelpCommand();
          break;

        case 'status':
          result = await whatsappCircleManager.getStatus(phoneNumber);
          break;

        case 'circles':
          result = await whatsappCircleManager.listUserCircles(phoneNumber);
          break;

        case 'create':
          result = await this.handleCreateCommand(phoneNumber);
          break;

        case 'join':
          result = await this.handleJoinCommand(phoneNumber, command.parameters);
          break;

        case 'contribute':
          result = await this.handleContributeCommand(phoneNumber, command.parameters);
          break;

        case 'balance':
          result = await whatsappCircleManager.getStatus(phoneNumber); // Reuse status for balance
          break;

        default:
          result = {
            success: false,
            message: `❌ Command "${command.type}" not yet implemented.\n\nSend /help to see available commands.`
          };
      }

      // Send response
      await this.whatsappService.sendTextMessage(phoneNumber, result.message);

    } catch (error) {
      logger.error(`Command execution failed for ${phoneNumber}:`, error);
      await this.sendErrorResponse(phoneNumber, 'Command execution failed. Please try again.');
    }
  }

  // ===========================================
  // COMMAND HANDLERS
  // ===========================================

  /**
   * 🔐 AUTH: Handle authentication command
   */
  private async handleAuthCommand(phoneNumber: string): Promise<CommandResult> {
    try {
      const authResult = await whatsappAuth.handleAuthenticationRequest(phoneNumber, 'Google');
      
      if (authResult.success) {
        if (authResult.isNewAuthentication && authResult.authUrl) {
          // New authentication required
          return {
            success: true,
            message: `🔐 **Authentication Required**\n\n` +
              `Please click the link below to connect your wallet:\n\n` +
              `👉 ${authResult.authUrl}\n\n` +
              `This link expires in 30 minutes. After authentication, you'll be able to create and manage circles!`
          };
        } else {
          // Already authenticated
          return {
            success: true,
            message: `✅ **Already Authenticated!**\n\n` +
              `Wallet: ${authResult.suiAddress?.slice(0, 6)}...${authResult.suiAddress?.slice(-4)}\n\n` +
              `You can now use all circle management features!\n\n` +
              `Send /help to see available commands.`
          };
        }
      } else {
        return {
          success: false,
          message: `❌ Authentication failed: ${authResult.error}`
        };
      }

    } catch (error) {
      logger.error(`Auth command failed for ${phoneNumber}:`, error);
      return {
        success: false,
        message: '❌ Authentication system error. Please try again.'
      };
    }
  }

  /**
   * ❓ HELP: Generate comprehensive help message
   */
  private async handleHelpCommand(): Promise<CommandResult> {
    const helpMessage = `📋 **Njangi WhatsApp Commands**\n\n` +
      `**🔐 Authentication:**\n` +
      `/auth - Connect your wallet\n\n` +
      `**👥 Circle Management:**\n` +
      `/create - Create a new circle\n` +
      `/join [circle-id] - Join a circle\n` +
      `/circles - List your circles\n` +
      `/status - View account status\n\n` +
      `**💰 Financial:**\n` +
      `/contribute [amount] [currency] - Add funds\n` +
      `/balance - Check balances\n\n` +
      `**ℹ️ Information:**\n` +
      `/help - Show this help\n\n` +
      `**💡 Examples:**\n` +
      `• \`/contribute 100 USD\`\n` +
      `• \`/join CIRCLE123\`\n` +
      `• \`/create\` (starts guided setup)\n\n` +
      `**🚀 Getting Started:**\n` +
      `1. Send \`/auth\` to connect wallet\n` +
      `2. Send \`/create\` to make a new circle\n` +
      `3. Invite friends to join!\n\n` +
      `Need help? Just ask! 🤝`;

    return {
      success: true,
      message: helpMessage
    };
  }

  /**
   * 🎯 CREATE: Start circle creation flow
   */
  private async handleCreateCommand(phoneNumber: string): Promise<CommandResult> {
    try {
      conversationFlow.startFlow(phoneNumber, 'create');
      const prompt = conversationFlow.getNextPrompt(phoneNumber);
      
      return {
        success: true,
        message: prompt
      };

    } catch (error) {
      logger.error(`Create command failed for ${phoneNumber}:`, error);
      return {
        success: false,
        message: '❌ Failed to start circle creation. Please try again.'
      };
    }
  }

  /**
   * 👥 JOIN: Handle circle joining
   */
  private async handleJoinCommand(phoneNumber: string, parameters: Record<string, unknown>): Promise<CommandResult> {
    try {
      const circleId = parameters.circleId as string;
      
      if (!circleId) {
        return {
          success: false,
          message: '❌ Please provide a circle ID.\n\nExample: `/join CIRCLE123`'
        };
      }

      return await whatsappCircleManager.joinCircle(phoneNumber, circleId);

    } catch (error) {
      logger.error(`Join command failed for ${phoneNumber}:`, error);
      return {
        success: false,
        message: '❌ Failed to join circle. Please try again.'
      };
    }
  }

  /**
   * 💰 CONTRIBUTE: Handle contributions
   */
  private async handleContributeCommand(phoneNumber: string, parameters: Record<string, unknown>): Promise<CommandResult> {
    try {
      const amount = parameters.amount as number;
      const currency = (parameters.currency as string) || 'USD';
      const circleId = parameters.circleId as string;
      
      if (!amount || amount <= 0) {
        return {
          success: false,
          message: '❌ Please provide a valid amount.\n\nExample: `/contribute 100 USD`'
        };
      }

      return await whatsappCircleManager.contributeToCircle(phoneNumber, amount, currency, circleId);

    } catch (error) {
      logger.error(`Contribute command failed for ${phoneNumber}:`, error);
      return {
        success: false,
        message: '❌ Failed to process contribution. Please try again.'
      };
    }
  }

  // ===========================================
  // UTILITY METHODS
  // ===========================================

  /**
   * Parse incoming message into structured command
   */
  private async parseCommand(messageText: string): Promise<ParsedCommand> {
    // This would use the command parser service
    // For now, implement basic command recognition
    const trimmed = messageText.trim();
    
    if (trimmed.startsWith('/auth')) {
      return {
        type: 'auth',
        rawText: trimmed,
        parameters: {},
        isValid: true,
        errors: [],
        requiresAuth: false,
        requiresMultiStep: false
      };
    }
    
    if (trimmed.startsWith('/help')) {
      return {
        type: 'help',
        rawText: trimmed,
        parameters: {},
        isValid: true,
        errors: [],
        requiresAuth: false,
        requiresMultiStep: false
      };
    }
    
    if (trimmed.startsWith('/status')) {
      return {
        type: 'status',
        rawText: trimmed,
        parameters: {},
        isValid: true,
        errors: [],
        requiresAuth: true,
        requiresMultiStep: false
      };
    }
    
    if (trimmed.startsWith('/circles')) {
      return {
        type: 'circles',
        rawText: trimmed,
        parameters: {},
        isValid: true,
        errors: [],
        requiresAuth: true,
        requiresMultiStep: false
      };
    }
    
    if (trimmed.startsWith('/create')) {
      return {
        type: 'create',
        rawText: trimmed,
        parameters: {},
        isValid: true,
        errors: [],
        requiresAuth: true,
        requiresMultiStep: true
      };
    }
    
    if (trimmed.startsWith('/balance')) {
      return {
        type: 'balance',
        rawText: trimmed,
        parameters: {},
        isValid: true,
        errors: [],
        requiresAuth: true,
        requiresMultiStep: false
      };
    }

    // Handle join command with circle ID
    const joinMatch = trimmed.match(/^\/join\s+([A-Za-z0-9\-_]+)/i);
    if (joinMatch) {
      return {
        type: 'join',
        rawText: trimmed,
        parameters: { circleId: joinMatch[1] },
        isValid: true,
        errors: [],
        requiresAuth: true,
        requiresMultiStep: false
      };
    }

    // Handle contribute command with amount and currency
    const contributeMatch = trimmed.match(/^\/contribute\s+(\d+(?:\.\d+)?)\s*([A-Z]{3})?/i);
    if (contributeMatch) {
      return {
        type: 'contribute',
        rawText: trimmed,
        parameters: { 
          amount: parseFloat(contributeMatch[1]),
          currency: contributeMatch[2] || 'USD'
        },
        isValid: true,
        errors: [],
        requiresAuth: true,
        requiresMultiStep: false
      };
    }

    // Unknown command
    return {
      type: 'help',
      rawText: trimmed,
      parameters: {},
      isValid: false,
      errors: ['Unknown command. Send /help for available commands.'],
      requiresAuth: false,
      requiresMultiStep: false
    };
  }

  /**
   * Send error response to user
   */
  private async sendErrorResponse(phoneNumber: string, errorMessage: string): Promise<void> {
    await this.whatsappService.sendTextMessage(phoneNumber, `❌ ${errorMessage}`);
  }

  /**
   * Get service statistics
   */
  public getStats(): Record<string, unknown> {
    return {
      initialized: true,
      integrations: ['whatsappService', 'whatsappAuth', 'conversationFlow', 'whatsappCircleManager'],
      phase: '34.4-blockchain-integration'
    };
  }
}

// Export singleton instance
export const whatsappCommandExecutor = WhatsAppCommandExecutorService.getInstance(); 