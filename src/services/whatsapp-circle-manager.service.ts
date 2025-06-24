import { createLogger, format, transports } from 'winston';
import { ZkLoginClient } from './zkLoginClient';
import { ZkLoginService, AccountData } from './zkLoginService';
import { whatsappAuth } from './whatsapp-stateless-auth.service';
import { WhatsAppService } from './whatsapp.service';
import { 
  CreateCircleParams,
  CommandResult 
} from '../types/whatsapp-commands';

// Interface definitions for blockchain data
interface CircleDetails {
  id: string;
  name: string;
  isAcceptingMembers: boolean;
  isActive: boolean;
  contributionAmount: number;
  currency: string;
  memberCount: number;
  maxMembers: number;
  currentCycle?: number;
}

interface UserCircle {
  id: string;
  name: string;
  isActive: boolean;
  isAdmin: boolean;
  contributionAmount: number;
  currency: string;
  memberCount: number;
  maxMembers: number;
  currentCycle?: number;
}

interface MemberStatus {
  hasDepositPaid: boolean;
  isActive: boolean;
  contributionsMade: number;
}

interface WalletBalance {
  sui: string;
  usdc: string;
}

interface BlockchainTransactionResult {
  digest: string;
}

interface BlockchainCircleData {
  name: string;
  contribution_amount: string;
  contribution_amount_local: number;
  contribution_amount_usd: number;
  security_deposit: string;
  security_deposit_local: number;
  security_deposit_usd: number;
  cycle_length: number;
  cycle_day: number;
  circle_type: number;
  max_members: number;
  rotation_style: number;
  penalty_rules: boolean[];
  goal_type: { some: undefined };
  target_amount: { some: undefined };
  target_date: { some: undefined };
  verification_required: boolean;
  currency_type: string;
}

// Create logger instance
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, stack }) => {
      return `${timestamp} [${level.toUpperCase()}] WhatsApp Circle Manager: ${message}${stack ? `\n${stack}` : ''}`;
    })
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: '.taskmaster/logs/whatsapp-circle-manager.log' })
  ]
});

/**
 * 🏛️ WhatsApp Circle Manager Service
 * 
 * Bridges WhatsApp commands to blockchain circle operations using existing zkLogin infrastructure.
 * Provides stateless, secure circle management through Enoki's managed service.
 */
export class WhatsAppCircleManagerService {
  private static instance: WhatsAppCircleManagerService;
  private zkLoginClient: ZkLoginClient;
  private zkLoginService: ZkLoginService;
  private whatsappService: WhatsAppService;

  private constructor() {
    this.zkLoginClient = ZkLoginClient.getInstance();
    this.zkLoginService = ZkLoginService.getInstance();
    this.whatsappService = WhatsAppService.getInstance();
  }

  public static getInstance(): WhatsAppCircleManagerService {
    if (!WhatsAppCircleManagerService.instance) {
      WhatsAppCircleManagerService.instance = new WhatsAppCircleManagerService();
    }
    return WhatsAppCircleManagerService.instance;
  }

  /**
   * 🎯 CREATE CIRCLE: Handle circle creation from WhatsApp
   */
  public async createCircle(
    phoneNumber: string, 
    circleData: CreateCircleParams
  ): Promise<CommandResult> {
    try {
      logger.info(`Creating circle "${circleData.name}" for user ${phoneNumber}`);

      // Check authentication using stateless auth service
      const isAuthenticated = whatsappAuth.isPhoneAuthenticated(phoneNumber);
      const suiAddress = whatsappAuth.getSuiAddressForPhone(phoneNumber);
      
      if (!isAuthenticated || !suiAddress) {
        return {
          success: false,
          message: `🔐 You need to authenticate first!\n\nSend /auth to link your Sui wallet.`,
          data: { requiresAuth: true }
        };
      }

      // Get fresh account data for transaction
      const accountData = await this.getFreshAccountData(suiAddress);
      if (!accountData) {
        return {
          success: false,
          message: `🔐 Authentication expired. Please send /auth to re-authenticate.`,
          data: { requiresAuth: true }
        };
      }

      // Convert WhatsApp circle data to blockchain format
      const blockchainCircleData = this.convertToBlockchainFormat(circleData);

      // Execute circle creation transaction
      const result = await this.zkLoginClient.sendTransaction(
        accountData,
        blockchainCircleData
      );

      logger.info(`Circle creation successful: ${result.digest}`);

      // Send success message with transaction details
      const successMessage = this.formatCircleCreationSuccess(circleData, result.digest);
      await this.whatsappService.sendTextMessage(phoneNumber, successMessage);

      return {
        success: true,
        message: successMessage,
        transactionId: result.digest
      };

    } catch (error) {
      logger.error(`Circle creation failed for ${phoneNumber}:`, error);
      
      if (error instanceof Error) {
        // Handle specific blockchain errors
        if (error.message.includes('proof verify failed') || error.message.includes('Session expired')) {
          return {
            success: false,
            message: `🔐 Your authentication session expired. Please send /auth to re-authenticate.`,
            data: { requiresAuth: true }
          };
        }

        if (error.message.includes('Insufficient')) {
          return {
            success: false,
            message: `💰 Insufficient SUI balance for transaction fees.\n\nPlease add SUI to your wallet and try again.`
          };
        }
      }

      return {
        success: false,
        message: `❌ Failed to create circle: ${error instanceof Error ? error.message : 'Unknown error'}\n\nPlease try again or contact support.`
      };
    }
  }

  /**
   * 👥 JOIN CIRCLE: Handle circle joining from WhatsApp
   */
  public async joinCircle(phoneNumber: string, circleId: string): Promise<CommandResult> {
    try {
      logger.info(`User ${phoneNumber} attempting to join circle ${circleId}`);

      // Check authentication
      const isAuthenticated = whatsappAuth.isPhoneAuthenticated(phoneNumber);
      const suiAddress = whatsappAuth.getSuiAddressForPhone(phoneNumber);
      
      if (!isAuthenticated || !suiAddress) {
        return {
          success: false,
          message: `🔐 You need to authenticate first!\n\nSend /auth to link your Sui wallet.`,
          data: { requiresAuth: true }
        };
      }

      // Validate circle exists and get details
      const circleDetails = await this.getCircleDetails(circleId);
      if (!circleDetails) {
        return {
          success: false,
          message: `❌ Circle not found.\n\nPlease check the circle ID and try again.`
        };
      }

      // Check if circle is accepting members
      if (!circleDetails.isAcceptingMembers) {
        return {
          success: false,
          message: `⏸️ Circle "${circleDetails.name}" is not currently accepting new members.`
        };
      }

      // For now, joining creates a join request (admin approval required)
      const joinMessage = `📝 **Join Request Submitted**\n\n` +
        `Circle: ${circleDetails.name}\n` +
        `Status: Pending admin approval\n\n` +
        `You'll be notified when the admin approves your request.`;

      await this.whatsappService.sendTextMessage(phoneNumber, joinMessage);

      // TODO: Implement actual join request creation via smart contract
      logger.info(`Join request created for ${phoneNumber} to circle ${circleId}`);

      return {
        success: true,
        message: joinMessage
      };

    } catch (error) {
      logger.error(`Circle join failed for ${phoneNumber}:`, error);
      
      return {
        success: false,
        message: `❌ Failed to join circle: ${error instanceof Error ? error.message : 'Unknown error'}\n\nPlease try again.`
      };
    }
  }

  /**
   * 💰 CONTRIBUTE: Handle contribution from WhatsApp
   */
  public async contributeToCircle(
    phoneNumber: string, 
    amount: number, 
    currency: string, 
    circleId?: string
  ): Promise<CommandResult> {
    try {
      logger.info(`User ${phoneNumber} contributing ${amount} ${currency} to circle ${circleId || 'default'}`);

      // Check authentication
      const isAuthenticated = whatsappAuth.isPhoneAuthenticated(phoneNumber);
      const suiAddress = whatsappAuth.getSuiAddressForPhone(phoneNumber);
      
      if (!isAuthenticated || !suiAddress) {
        return {
          success: false,
          message: `🔐 You need to authenticate first!\n\nSend /auth to link your Sui wallet.`,
          data: { requiresAuth: true }
        };
      }

      // Get user's active circles if no specific circle provided
      let targetCircleId = circleId;
      if (!targetCircleId) {
        const userCircles = await this.getUserCircles(suiAddress);
        if (userCircles.length === 0) {
          return {
            success: false,
            message: `❌ You're not a member of any circles.\n\nJoin a circle first with /join [circle-id]`
          };
        }
        
        if (userCircles.length === 1) {
          targetCircleId = userCircles[0].id;
        } else {
          // Multiple circles - ask user to specify
          const circleList = userCircles.map((c, i) => 
            `${i + 1}. ${c.name} (${c.id.slice(0, 8)}...)`
          ).join('\n');
          
          return {
            success: false,
            message: `🔍 You're a member of multiple circles. Please specify which one:\n\n${circleList}\n\nUse: /contribute ${amount} ${currency} [circle-id]`
          };
        }
      }

      // Get circle details and validate contribution
      const circleDetails = await this.getCircleDetails(targetCircleId!);
      if (!circleDetails) {
        return {
          success: false,
          message: `❌ Circle not found.\n\nPlease check the circle ID.`
        };
      }

      // Convert amount to appropriate blockchain units
      const contributionAmount = this.convertToBlockchainAmount(amount, currency);

      // Get fresh account data
      const accountData = await this.getFreshAccountData(suiAddress);
      if (!accountData) {
        return {
          success: false,
          message: `🔐 Authentication expired. Please send /auth to re-authenticate.`,
          data: { requiresAuth: true }
        };
      }

      // Determine if this is a security deposit or regular contribution
      const memberStatus = await this.getMemberStatus(suiAddress, targetCircleId!);
      
      let result;
      if (!memberStatus.hasDepositPaid) {
        // This is a security deposit
        result = await this.executeSecurityDeposit(accountData, targetCircleId!, contributionAmount);
      } else {
        // This is a regular contribution
        result = await this.executeContribution(accountData, targetCircleId!, contributionAmount);
      }

      logger.info(`Contribution successful: ${result.digest}`);

      const successMessage = this.formatContributionSuccess(
        circleDetails.name,
        amount,
        currency,
        memberStatus.hasDepositPaid ? 'contribution' : 'security deposit',
        result.digest
      );

      await this.whatsappService.sendTextMessage(phoneNumber, successMessage);

      return {
        success: true,
        message: successMessage,
        transactionId: result.digest
      };

    } catch (error) {
      logger.error(`Contribution failed for ${phoneNumber}:`, error);
      
      if (error instanceof Error) {
        if (error.message.includes('Insufficient')) {
          return {
            success: false,
            message: `💰 Insufficient ${currency} balance.\n\nPlease add funds to your wallet and try again.`
          };
        }

        if (error.message.includes('proof verify failed')) {
          return {
            success: false,
            message: `🔐 Authentication expired. Please send /auth to re-authenticate.`,
            data: { requiresAuth: true }
          };
        }
      }

      return {
        success: false,
        message: `❌ Contribution failed: ${error instanceof Error ? error.message : 'Unknown error'}\n\nPlease try again.`
      };
    }
  }

  /**
   * 📋 LIST CIRCLES: Get user's circles from WhatsApp
   */
  public async listUserCircles(phoneNumber: string): Promise<CommandResult> {
    try {
      logger.info(`Listing circles for user ${phoneNumber}`);

      // Check authentication
      const isAuthenticated = whatsappAuth.isPhoneAuthenticated(phoneNumber);
      const suiAddress = whatsappAuth.getSuiAddressForPhone(phoneNumber);
      
      if (!isAuthenticated || !suiAddress) {
        return {
          success: false,
          message: `🔐 You need to authenticate first!\n\nSend /auth to link your Sui wallet.`,
          data: { requiresAuth: true }
        };
      }

      const userCircles = await this.getUserCircles(suiAddress);

      if (userCircles.length === 0) {
        return {
          success: true,
          message: `📭 You're not a member of any circles yet.\n\n` +
            `Create one with /create or join an existing circle with /join [circle-id]`
        };
      }

      const circlesList = userCircles.map((circle, index) => {
        const statusEmoji = circle.isActive ? '🟢' : '🟡';
        const roleEmoji = circle.isAdmin ? '👑' : '👤';
        
        return `${index + 1}. ${statusEmoji} **${circle.name}**\n` +
          `   ${roleEmoji} ${circle.isAdmin ? 'Admin' : 'Member'} | ${circle.memberCount}/${circle.maxMembers} members\n` +
          `   💰 ${circle.contributionAmount} ${circle.currency} per cycle\n` +
          `   🆔 ${circle.id.slice(0, 8)}...${circle.id.slice(-4)}`;
      }).join('\n\n');

      const message = `📋 **Your Circles**\n\n${circlesList}\n\n` +
        `Use /contribute to add funds or /status for detailed information.`;

      return {
        success: true,
        message
      };

    } catch (error) {
      logger.error(`List circles failed for ${phoneNumber}:`, error);
      
      return {
        success: false,
        message: `❌ Failed to retrieve circles: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * 📊 STATUS: Get detailed status information
   */
  public async getStatus(phoneNumber: string): Promise<CommandResult> {
    try {
      logger.info(`Getting status for user ${phoneNumber}`);

      // Check authentication
      const isAuthenticated = whatsappAuth.isPhoneAuthenticated(phoneNumber);
      const suiAddress = whatsappAuth.getSuiAddressForPhone(phoneNumber);
      
      if (!isAuthenticated || !suiAddress) {
        return {
          success: false,
          message: `🔐 You need to authenticate first!\n\nSend /auth to link your Sui wallet.`,
          data: { requiresAuth: true }
        };
      }

      // Get wallet balance
      const walletBalance = await this.getWalletBalance(suiAddress);
      
      // Get user circles with detailed status
      const userCircles = await this.getUserCircles(suiAddress);
      
      let statusMessage = `📊 **Account Status**\n\n`;
      statusMessage += `🏠 Wallet: ${suiAddress.slice(0, 6)}...${suiAddress.slice(-4)}\n`;
      statusMessage += `💰 Balance: ${walletBalance.sui} SUI\n`;
      if (parseFloat(walletBalance.usdc) > 0) {
        statusMessage += `💵 USDC: ${walletBalance.usdc}\n`;
      }
      statusMessage += `👥 Circles: ${userCircles.length}\n\n`;

      if (userCircles.length > 0) {
        statusMessage += `**Circle Details:**\n\n`;
        
        for (const circle of userCircles) {
          const memberStatus = await this.getMemberStatus(suiAddress, circle.id);
          const statusEmoji = circle.isActive ? '🟢' : '🟡';
          const roleEmoji = circle.isAdmin ? '👑' : '👤';
          
          statusMessage += `${statusEmoji} **${circle.name}**\n`;
          statusMessage += `${roleEmoji} ${circle.isAdmin ? 'Admin' : 'Member'}\n`;
          statusMessage += `💰 Contribution: ${circle.contributionAmount} ${circle.currency}\n`;
          statusMessage += `🔐 Security Deposit: ${memberStatus.hasDepositPaid ? '✅ Paid' : '❌ Pending'}\n`;
          statusMessage += `🔄 Cycle: ${circle.currentCycle || 1}\n`;
          statusMessage += `👥 Members: ${circle.memberCount}/${circle.maxMembers}\n\n`;
        }
      }

      statusMessage += `📱 Send /help for available commands.`;

      return {
        success: true,
        message: statusMessage
      };

    } catch (error) {
      logger.error(`Status failed for ${phoneNumber}:`, error);
      
      return {
        success: false,
        message: `❌ Failed to get status: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  // ===========================================
  // PRIVATE HELPER METHODS
  // ===========================================

  /**
   * Get fresh account data for blockchain operations
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async getFreshAccountData(_suiAddress: string): Promise<AccountData | null> {
    try {
      // This would integrate with the existing zkLogin flow
      logger.warn('getFreshAccountData not yet implemented - requires Enoki integration');
      return null;
    } catch (error) {
      logger.error('Failed to get fresh account data:', error);
      return null;
    }
  }

  /**
   * Convert WhatsApp circle data to blockchain transaction format
   */
  private convertToBlockchainFormat(circleData: CreateCircleParams): BlockchainCircleData {
    return {
      name: circleData.name,
      contribution_amount: this.convertCurrencyToSUI(circleData.contributionAmount, circleData.currency),
      contribution_amount_local: Math.floor(circleData.contributionAmount * 100),
      contribution_amount_usd: Math.floor(circleData.contributionAmount * 100),
      security_deposit: this.convertCurrencyToSUI(circleData.securityDeposit, circleData.currency),
      security_deposit_local: Math.floor(circleData.securityDeposit * 100),
      security_deposit_usd: Math.floor(circleData.securityDeposit * 100),
      cycle_length: this.convertCycleLengthToDays(circleData.cycleLength),
      cycle_day: this.convertCycleDayToNumber(circleData.cycleDay, circleData.cycleLength),
      circle_type: circleData.circleType === 'rotational' ? 0 : 1,
      max_members: circleData.maxMembers,
      rotation_style: 0,
      penalty_rules: [
        circleData.penaltyRules.latePayment,
        circleData.penaltyRules.missedMeeting
      ],
      goal_type: { some: undefined },
      target_amount: { some: undefined },
      target_date: { some: undefined },
      verification_required: false,
      currency_type: circleData.currency
    };
  }

  /**
   * Convert currency amount to SUI
   */
  private convertCurrencyToSUI(amount: number, currency: string): string {
    const exchangeRates: Record<string, number> = {
      USD: 2.5, EUR: 2.3, GBP: 2.0, CAD: 3.3,
      NGN: 0.002, ZAR: 0.14, GHS: 0.08, KES: 0.0077,
      EGP: 0.051, MAD: 0.25, XAF: 0.0016
    };

    const suiAmount = amount / (exchangeRates[currency] || 2.5);
    return Math.floor(suiAmount * 1e9).toString(); // Convert to MIST
  }

  /**
   * Convert cycle length to days
   */
  private convertCycleLengthToDays(cycleLength: string): number {
    const cycleDays: Record<string, number> = {
      'weekly': 7, 'bi-weekly': 14, 'monthly': 30, 'quarterly': 90
    };
    return cycleDays[cycleLength] || 30;
  }

  /**
   * Convert cycle day to number
   */
  private convertCycleDayToNumber(cycleDay: string | number, cycleLength: string): number {
    if (typeof cycleDay === 'number') return cycleDay;
    
    if (cycleLength === 'weekly' || cycleLength === 'bi-weekly') {
      const dayNumbers: Record<string, number> = {
        'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4,
        'friday': 5, 'saturday': 6, 'sunday': 0
      };
      return dayNumbers[cycleDay.toLowerCase()] || 1;
    }
    
    return parseInt(cycleDay) || 1;
  }

  /**
   * Convert amount to blockchain units
   */
  private convertToBlockchainAmount(amount: number, currency: string): string {
    if (currency === 'SUI') {
      return Math.floor(amount * 1e9).toString(); // Convert to MIST
    }
    
    // For other currencies, convert via exchange rate to SUI
    return this.convertCurrencyToSUI(amount, currency);
  }

  /**
   * Get circle details from blockchain
   */
  private async getCircleDetails(circleId: string): Promise<CircleDetails | null> {
    try {
      // This would query the blockchain for circle details
      logger.warn('getCircleDetails not yet implemented - requires blockchain query');
      return {
        id: circleId,
        name: 'Sample Circle',
        isAcceptingMembers: true,
        isActive: true,
        contributionAmount: 100,
        currency: 'USD',
        memberCount: 5,
        maxMembers: 10
      };
    } catch (error) {
      logger.error('Failed to get circle details:', error);
      return null;
    }
  }

  /**
   * Get user's circles from blockchain
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async getUserCircles(_suiAddress: string): Promise<UserCircle[]> {
    try {
      // This would query the blockchain for user's circles
      logger.warn('getUserCircles not yet implemented - requires blockchain query');
      return [];
    } catch (error) {
      logger.error('Failed to get user circles:', error);
      return [];
    }
  }

  /**
   * Get member status in a circle
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async getMemberStatus(_suiAddress: string, _circleId: string): Promise<MemberStatus> {
    try {
      // This would query the blockchain for member status
      logger.warn('getMemberStatus not yet implemented - requires blockchain query');
      return {
        hasDepositPaid: false,
        isActive: true,
        contributionsMade: 0
      };
    } catch (error) {
      logger.error('Failed to get member status:', error);
      return { hasDepositPaid: false, isActive: false, contributionsMade: 0 };
    }
  }

  /**
   * Get wallet balance
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async getWalletBalance(_suiAddress: string): Promise<WalletBalance> {
    try {
      // This would query the blockchain for wallet balance
      logger.warn('getWalletBalance not yet implemented - requires blockchain query');
      return {
        sui: '0.00',
        usdc: '0.00'
      };
    } catch (error) {
      logger.error('Failed to get wallet balance:', error);
      return { sui: '0.00', usdc: '0.00' };
    }
  }

  /**
   * Execute security deposit transaction
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async executeSecurityDeposit(_accountData: AccountData, _circleId: string, _amount: string): Promise<BlockchainTransactionResult> {
    try {
      // This would use the existing paySecurityDeposit method from zkLoginClient
      logger.warn('executeSecurityDeposit not yet implemented - requires zkLoginClient integration');
      return { digest: 'mock-transaction-hash' };
    } catch (error) {
      logger.error('Security deposit execution failed:', error);
      throw error;
    }
  }

  /**
   * Execute regular contribution transaction
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async executeContribution(_accountData: AccountData, _circleId: string, _amount: string): Promise<BlockchainTransactionResult> {
    try {
      // This would use the existing contribution methods from zkLoginClient
      logger.warn('executeContribution not yet implemented - requires zkLoginClient integration');
      return { digest: 'mock-transaction-hash' };
    } catch (error) {
      logger.error('Contribution execution failed:', error);
      throw error;
    }
  }

  /**
   * Format circle creation success message
   */
  private formatCircleCreationSuccess(circleData: CreateCircleParams, transactionHash: string): string {
    return `🎉 **Circle Created Successfully!**\n\n` +
      `📋 **"${circleData.name}"**\n` +
      `💰 Contribution: ${circleData.contributionAmount} ${circleData.currency}\n` +
      `🔐 Security Deposit: ${circleData.securityDeposit} ${circleData.currency}\n` +
      `👥 Max Members: ${circleData.maxMembers}\n` +
      `🔄 Cycle: ${circleData.cycleLength}\n\n` +
      `📊 **Next Steps:**\n` +
      `• Invite members to join\n` +
      `• Wait for security deposits\n` +
      `• Activate the circle\n\n` +
      `🔗 Transaction: ${transactionHash.slice(0, 8)}...${transactionHash.slice(-8)}`;
  }

  /**
   * Format contribution success message
   */
  private formatContributionSuccess(
    circleName: string,
    amount: number,
    currency: string,
    type: string,
    transactionHash: string
  ): string {
    const typeEmoji = type === 'security deposit' ? '🔐' : '💰';
    const typeText = type === 'security deposit' ? 'Security Deposit' : 'Contribution';
    
    return `✅ **${typeText} Successful!**\n\n` +
      `📋 Circle: ${circleName}\n` +
      `${typeEmoji} Amount: ${amount} ${currency}\n` +
      `⏰ Processed: ${new Date().toLocaleString()}\n\n` +
      `🔗 Transaction: ${transactionHash.slice(0, 8)}...${transactionHash.slice(-8)}\n\n` +
      `Send /status to view your updated circle information.`;
  }
}

// Export singleton instance
export const whatsappCircleManager = WhatsAppCircleManagerService.getInstance(); 