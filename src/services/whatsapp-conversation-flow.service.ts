import { createLogger, format, transports } from 'winston';
import {
  ConversationFlow,
  ConversationState,
  MultiStepCommand,
  CommandType,
} from '../types/whatsapp-commands';

// Configure logger
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.File({ filename: 'whatsapp-conversation-flow.log' }),
    new transports.Console()
  ],
});

/**
 * 🔄 WhatsApp Conversation Flow Service
 * 
 * Manages multi-step interactions in memory with auto-cleanup
 * Handles stateful conversations without database dependencies
 */
export class WhatsAppConversationFlowService {
  private static instance: WhatsAppConversationFlowService;
  
  // ✨ Pure in-memory conversation storage
  private activeFlows: Map<string, ConversationFlow> = new Map();
  
  // ⚙️ Configuration
  private readonly DEFAULT_TIMEOUT_MINUTES = 10;
  private readonly CLEANUP_INTERVAL = 2 * 60 * 1000; // 2 minutes
  private readonly MAX_RETRY_COUNT = 3;

  private constructor() {
    this.initializeService();
  }

  public static getInstance(): WhatsAppConversationFlowService {
    if (!WhatsAppConversationFlowService.instance) {
      WhatsAppConversationFlowService.instance = new WhatsAppConversationFlowService();
    }
    return WhatsAppConversationFlowService.instance;
  }

  private initializeService(): void {
    // 🧹 Auto-cleanup expired conversations
    setInterval(() => {
      this.cleanupExpiredFlows();
    }, this.CLEANUP_INTERVAL);

    logger.info('WhatsApp Conversation Flow Service initialized (stateless)');
  }

  /**
   * 🚀 START: Begin a new multi-step conversation
   */
  public startFlow(
    phoneNumber: string,
    commandType: CommandType,
    timeoutMinutes: number = this.DEFAULT_TIMEOUT_MINUTES
  ): string {
    // End any existing flow for this user
    this.endFlow(phoneNumber);

    const now = new Date();
    const flow: ConversationFlow = {
      phoneNumber,
      state: this.getInitialState(commandType),
      currentCommand: commandType,
      stepIndex: 0,
      collectedData: {},
      startedAt: now,
      lastActivity: now,
      expiresAt: new Date(now.getTime() + timeoutMinutes * 60 * 1000),
      retryCount: 0,
    };

    this.activeFlows.set(phoneNumber, flow);
    
    logger.info(`Started conversation flow for ${phoneNumber}: ${commandType}`);
    
    return this.getNextPrompt(phoneNumber);
  }

  /**
   * 📝 PROCESS: Handle user input in ongoing conversation
   */
  public processInput(phoneNumber: string, input: string): {
    success: boolean;
    message: string;
    isComplete: boolean;
    nextPrompt?: string;
    result?: Record<string, unknown>;
  } {
    const flow = this.activeFlows.get(phoneNumber);
    
    if (!flow) {
      return {
        success: false,
        message: 'No active conversation. Start with a command like /create',
        isComplete: true,
      };
    }

    // Check if flow has expired
    if (new Date() > flow.expiresAt) {
      this.endFlow(phoneNumber);
      return {
        success: false,
        message: '⏰ Conversation timed out. Please start over.',
        isComplete: true,
      };
    }

    try {
      return this.processFlowStep(flow, input);
    } catch (error) {
      logger.error(`Flow processing error for ${phoneNumber}:`, error);
      this.endFlow(phoneNumber);
      return {
        success: false,
        message: '❌ Something went wrong. Please start over.',
        isComplete: true,
      };
    }
  }

  /**
   * 🔍 CHECK: Get current flow status
   */
  public getCurrentFlow(phoneNumber: string): ConversationFlow | null {
    const flow = this.activeFlows.get(phoneNumber);
    
    if (!flow) {
      return null;
    }

    // Check expiration
    if (new Date() > flow.expiresAt) {
      this.endFlow(phoneNumber);
      return null;
    }

    return flow;
  }

  /**
   * ⏹️ END: Terminate conversation flow
   */
  public endFlow(phoneNumber: string): void {
    const flow = this.activeFlows.get(phoneNumber);
    if (flow) {
      logger.info(`Ended conversation flow for ${phoneNumber}: ${flow.currentCommand}`);
      this.activeFlows.delete(phoneNumber);
    }
  }

  /**
   * 🎯 STEP PROCESSOR: Handle individual conversation step
   */
  private processFlowStep(flow: ConversationFlow, input: string): {
    success: boolean;
    message: string;
    isComplete: boolean;
    nextPrompt?: string;
    result?: Record<string, unknown>;
  } {
    const command = this.getMultiStepCommand(flow.currentCommand!);
    if (!command) {
      throw new Error(`Unknown multi-step command: ${flow.currentCommand}`);
    }

    const currentStep = command.steps[flow.stepIndex];
    if (!currentStep) {
      throw new Error(`Invalid step index: ${flow.stepIndex}`);
    }

    // Validate input with access to previous step data
    const validation = currentStep.validator(input.trim(), flow.collectedData);
    
    if (!validation.isValid) {
      flow.retryCount++;
      
      if (flow.retryCount >= this.MAX_RETRY_COUNT) {
        this.endFlow(flow.phoneNumber);
        return {
          success: false,
          message: '❌ Too many invalid attempts. Please start over with /create',
          isComplete: true,
        };
      }

      return {
        success: false,
        message: validation.error || currentStep.retryPrompt || 'Invalid input. Please try again.',
        isComplete: false,
        nextPrompt: typeof currentStep.prompt === 'function' ? currentStep.prompt(flow.collectedData) : currentStep.prompt,
      };
    }

    // Store validated data
    flow.collectedData[currentStep.key] = validation.value;
    flow.retryCount = 0; // Reset retry count on successful input
    flow.lastActivity = new Date();
    flow.stepIndex++;

    // Check if we're done with all steps
    if (flow.stepIndex >= command.steps.length) {
      const result = flow.collectedData;
      this.endFlow(flow.phoneNumber);
      
      return {
        success: true,
        message: command.successMessage(result),
        isComplete: true,
        result,
      };
    }

    // Move to next step
    const nextStep = command.steps[flow.stepIndex];
    flow.state = this.getStateForStep(flow.currentCommand!, flow.stepIndex);

    // Get next prompt (handle dynamic prompts)
    const nextPrompt = typeof nextStep.prompt === 'function' ? nextStep.prompt(flow.collectedData) : nextStep.prompt;

    return {
      success: true,
      message: '✅ Got it!',
      isComplete: false,
      nextPrompt,
    };
  }

  /**
   * 📋 COMMANDS: Define multi-step command flows
   */
  private getMultiStepCommand(commandType: CommandType): MultiStepCommand | null {
    switch (commandType) {
      case 'create':
        return this.getCreateCircleCommand();
      
      // Add more multi-step commands here
      default:
        return null;
    }
  }

  /**
   * 🎨 CREATE CIRCLE: Multi-step flow for circle creation (Enhanced to match web version)
   */
  private getCreateCircleCommand(): MultiStepCommand {
    return {
      type: 'create',
      timeoutMinutes: 20, // Extended for more complex flow
      steps: [
        // Step 1: Circle Type Selection
        {
          key: 'circleType',
          prompt: `🎯 **Choose Circle Type**

🔄 **Rotational Circle**
Members contribute regularly and take turns receiving the full pot

🎪 **Smart Goal Circle** (Coming Soon)
Members save towards a shared goal with automatic distribution

Type "rotational" or "1" to create a rotational circle.`,
          validator: (input: string) => {
            const trimmed = input.trim().toLowerCase();
            if (['rotational', '1', 'rotation', 'rotate'].includes(trimmed)) {
              return { isValid: true, value: 'rotational' };
            }
            if (['smart', 'goal', '2', 'smart-goal'].includes(trimmed)) {
              return { isValid: false, error: '🚧 Smart Goal Circles are coming soon! Please choose "rotational" for now.' };
            }
            return { isValid: false, error: '❌ Please type "rotational" or "1".' };
          },
          retryPrompt: 'Please type "rotational" or "1":',
        },

        // Step 2: Currency Selection
        {
          key: 'currency',
          prompt: `💱 **Choose Your Currency**

**Western Currencies:**
🇺🇸 USD - US Dollar
🇪🇺 EUR - Euro  
🇬🇧 GBP - British Pound
🇨🇦 CAD - Canadian Dollar

**African Currencies:**
🇳🇬 NGN - Nigerian Naira
🇿🇦 ZAR - South African Rand
🇬🇭 GHS - Ghanaian Cedi
🇰🇪 KES - Kenyan Shilling
🇪🇬 EGP - Egyptian Pound
🇲🇦 MAD - Moroccan Dirham
🇨🇫 XAF - Central African CFA Franc

💡 All amounts will be pegged to your selected currency for stability.

Type the currency code (e.g., "USD", "NGN", "EUR"):`,
          validator: (input: string) => {
            const currency = input.trim().toUpperCase();
            const supportedCurrencies = ['USD', 'EUR', 'GBP', 'CAD', 'NGN', 'ZAR', 'GHS', 'KES', 'EGP', 'MAD', 'XAF'];
            
            if (!supportedCurrencies.includes(currency)) {
              return { 
                isValid: false, 
                error: `❌ Unsupported currency. Please choose from: ${supportedCurrencies.join(', ')}` 
              };
            }
            return { isValid: true, value: currency };
          },
          retryPrompt: 'Please enter a valid currency code (USD, EUR, NGN, etc.):',
        },

        // Step 3: Circle Name
        {
          key: 'name',
          prompt: '📝 **Circle Name**\n\nWhat would you like to name your circle?\n\nExample: "Family Savings Circle 2024"',
          validator: (input: string) => {
            const trimmed = input.trim();
            if (trimmed.length < 3) {
              return { isValid: false, error: '❌ Circle name must be at least 3 characters long.' };
            }
            if (trimmed.length > 50) {
              return { isValid: false, error: '❌ Circle name must be less than 50 characters.' };
            }
            return { isValid: true, value: trimmed };
          },
          retryPrompt: 'Please enter a circle name (3-50 characters):',
        },

        // Step 4: Contribution Amount
        {
          key: 'contributionAmount',
          prompt: (data: Record<string, unknown>) => {
            const currency = data.currency as string;
            
            return `💰 **Contribution Amount**

Each member will contribute this amount per cycle.

💡 Amount will be stored in ${currency} and converted to SUI automatically.

Enter the amount in ${currency} (e.g., "100"):`;
          },
          validator: (input: string, data?: Record<string, unknown>) => {
            const amount = parseFloat(input.trim());
            if (isNaN(amount) || amount <= 0) {
              return { isValid: false, error: '❌ Please enter a valid amount greater than 0.' };
            }
            
            // Currency-specific limits
            const currency = data?.currency as string || 'USD';
            const maxLimits: Record<string, number> = {
              USD: 1000, EUR: 1000, GBP: 800, CAD: 1300,
              NGN: 500000, ZAR: 15000, GHS: 12500, KES: 125000,
              EGP: 25000, MAD: 10000, XAF: 600000
            };
            
            const maxLimit = maxLimits[currency] || 1000;
            if (amount > maxLimit) {
              return { isValid: false, error: `❌ Maximum amount for ${currency} is ${maxLimit}.` };
            }
            
            return { isValid: true, value: amount };
          },
          retryPrompt: 'Please enter a valid contribution amount:',
        },

        // Step 5: Cycle Length
        {
          key: 'cycleLength',
          prompt: `📅 **Cycle Length**

How often should contributions be made?

1️⃣ **Weekly** - Every 7 days
2️⃣ **Bi-weekly** - Every 14 days  
3️⃣ **Monthly** - Every 30 days
4️⃣ **Quarterly** - Every 90 days

Type the number (1-4) or name (e.g., "weekly", "monthly"):`,
          validator: (input: string) => {
            const trimmed = input.trim().toLowerCase();
            
            if (['1', 'weekly', 'week'].includes(trimmed)) {
              return { isValid: true, value: 'weekly' };
            }
            if (['2', 'bi-weekly', 'biweekly', 'bi weekly'].includes(trimmed)) {
              return { isValid: true, value: 'bi-weekly' };
            }
            if (['3', 'monthly', 'month'].includes(trimmed)) {
              return { isValid: true, value: 'monthly' };
            }
            if (['4', 'quarterly', 'quarter'].includes(trimmed)) {
              return { isValid: true, value: 'quarterly' };
            }
            
            return { isValid: false, error: '❌ Please choose 1-4 or type the cycle name.' };
          },
          retryPrompt: 'Please enter 1 (weekly), 2 (bi-weekly), 3 (monthly), or 4 (quarterly):',
        },

        // Step 6: Cycle Day
        {
          key: 'cycleDay',
          prompt: (data: Record<string, unknown>) => {
            const cycleLength = data.cycleLength as string;
            
            if (cycleLength === 'weekly' || cycleLength === 'bi-weekly') {
              return `📅 **Day of Week**

Which day should contributions be due?

1️⃣ Monday    2️⃣ Tuesday   3️⃣ Wednesday
4️⃣ Thursday  5️⃣ Friday    6️⃣ Saturday  7️⃣ Sunday

Type the number (1-7) or day name:`;
            } else {
              return `📅 **Day of Month**

Which day of the month should contributions be due?

Enter a number from 1-28 (e.g., "1" for 1st, "15" for 15th):

💡 Limited to 1-28 to ensure consistency across all months.`;
            }
          },
          validator: (input: string, data?: Record<string, unknown>) => {
            const cycleLength = data?.cycleLength as string || 'monthly';
            const trimmed = input.trim().toLowerCase();
            
            if (cycleLength === 'weekly' || cycleLength === 'bi-weekly') {
              // Weekday validation
              const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
              const dayIndex = weekdays.indexOf(trimmed);
              
              if (dayIndex !== -1) {
                return { isValid: true, value: trimmed };
              }
              
              const num = parseInt(trimmed);
              if (num >= 1 && num <= 7) {
                return { isValid: true, value: weekdays[num - 1] };
              }
              
              return { isValid: false, error: '❌ Please enter 1-7 or a day name (Monday-Sunday).' };
            } else {
              // Month day validation
              const day = parseInt(trimmed);
              if (isNaN(day) || day < 1 || day > 28) {
                return { isValid: false, error: '❌ Please enter a day from 1-28.' };
              }
              return { isValid: true, value: day };
            }
          },
          retryPrompt: 'Please enter a valid day:',
        },

        // Step 7: Security Deposit
        {
          key: 'securityDeposit',
          prompt: (data: Record<string, unknown>) => {
            const currency = data.currency as string;
            const contributionAmount = data.contributionAmount as number;
            const recommendedDeposit = Math.ceil(contributionAmount * 0.5);
            
            return `🔐 **Security Deposit**

One-time refundable deposit to ensure member commitment.

💡 Recommended: ${currency} ${recommendedDeposit} (50% of contribution)
💡 Refunded when leaving circle in good standing

Enter security deposit amount in ${currency}:`;
          },
          validator: (input: string, data?: Record<string, unknown>) => {
            const amount = parseFloat(input.trim());
            const contributionAmount = data?.contributionAmount as number || 0;
            
            if (isNaN(amount) || amount <= 0) {
              return { isValid: false, error: '❌ Please enter a valid amount greater than 0.' };
            }
            
            if (amount < contributionAmount * 0.2) {
              return { isValid: false, error: `❌ Security deposit should be at least 20% of contribution (${(contributionAmount * 0.2).toFixed(2)}).` };
            }
            
            return { isValid: true, value: amount };
          },
          retryPrompt: 'Please enter a valid security deposit amount:',
        },

        // Step 8: Number of Members
        {
          key: 'maxMembers',
          prompt: `👥 **Maximum Members**

How many people can join this circle?

💡 Minimum: 3 members (including you)
💡 Maximum: 20 members
💡 Recommended: 5-12 members for best experience

Enter the maximum number of members:`,
          validator: (input: string) => {
            const members = parseInt(input.trim());
            if (isNaN(members) || members < 3) {
              return { isValid: false, error: '❌ Minimum 3 members required.' };
            }
            if (members > 20) {
              return { isValid: false, error: '❌ Maximum 20 members allowed.' };
            }
            return { isValid: true, value: members };
          },
          retryPrompt: 'Enter max members (3-20):',
        },

        // Step 9: Penalty Rules
        {
          key: 'penaltyRules',
          prompt: `⚖️ **Penalty Rules**

Enable automatic penalties for group discipline?

1️⃣ **No penalties** - Just friendly reminders
2️⃣ **Late payment** - Fee for delayed contributions  
3️⃣ **Both late payment & missed meetings** - Strict rules

💡 Penalties are deducted from security deposit

Type 1, 2, or 3:`,
          validator: (input: string) => {
            const choice = input.trim();
            
            if (choice === '1') {
              return { isValid: true, value: { latePayment: false, missedMeeting: false } };
            }
            if (choice === '2') {
              return { isValid: true, value: { latePayment: true, missedMeeting: false } };
            }
            if (choice === '3') {
              return { isValid: true, value: { latePayment: true, missedMeeting: true } };
            }
            
            return { isValid: false, error: '❌ Please choose 1, 2, or 3.' };
          },
          retryPrompt: 'Please enter 1 (no penalties), 2 (late payment), or 3 (both):',
        },

        // Step 10: Final Confirmation
        {
          key: 'confirmation',
          prompt: (data: Record<string, unknown>) => {
            const currency = data.currency as string;
            const currencySymbols: Record<string, string> = {
              USD: '$', EUR: '€', GBP: '£', CAD: 'CA$',
              NGN: '₦', ZAR: 'R', GHS: '₵', KES: 'KSh', 
              EGP: 'E£', MAD: 'DH', XAF: 'FCFA'
            };
            const symbol = currencySymbols[currency] || currency;
            
            return `📋 **Review Your Circle**

**"${data.name}"** - ${data.circleType} Circle

💰 Contribution: ${symbol}${data.contributionAmount} per ${data.cycleLength}
🔐 Security Deposit: ${symbol}${data.securityDeposit}
📅 Cycle: Every ${data.cycleLength} on ${data.cycleDay}
👥 Max Members: ${data.maxMembers}
⚖️ Penalties: ${JSON.stringify(data.penaltyRules)}

Type "confirm" to create your circle or "cancel" to abort:`;
          },
          validator: (input: string) => {
            const trimmed = input.trim().toLowerCase();
            
            if (['confirm', 'yes', 'y', 'create'].includes(trimmed)) {
              return { isValid: true, value: 'confirmed' };
            }
            if (['cancel', 'no', 'n', 'abort'].includes(trimmed)) {
              return { isValid: false, error: '❌ Circle creation cancelled. Type /create to start over.' };
            }
            
            return { isValid: false, error: '❌ Please type "confirm" to proceed or "cancel" to abort.' };
          },
          retryPrompt: 'Please type "confirm" or "cancel":',
        },
      ],
      successMessage: (data: Record<string, unknown>) => {
        const currency = data.currency as string;
        const currencySymbols: Record<string, string> = {
          USD: '$', EUR: '€', GBP: '£', CAD: 'CA$',
          NGN: '₦', ZAR: 'R', GHS: '₵', KES: 'KSh', 
          EGP: 'E£', MAD: 'DH', XAF: 'FCFA'
        };
        const symbol = currencySymbols[currency] || currency;
        
        return `
🎉 **Circle Created Successfully!**

**"${data.name}"** is ready for members!

📋 **Summary:**
• Contribution: ${symbol}${data.contributionAmount} per ${data.cycleLength}
• Security Deposit: ${symbol}${data.securityDeposit}
• Currency: ${currency} (pegged for stability)
• Max Members: ${data.maxMembers}

🚀 **Next Steps:**
1. Invite members: \`/invite [phone-number]\`
2. Check status: \`/circles\`
3. Start contributing: \`/contribute ${data.contributionAmount} ${currency}\`

📱 Share your circle ID with friends to get started!
        `.trim();
      },
    };
  }

  /**
   * 🔄 STATE MANAGEMENT: Get initial state for command
   */
  private getInitialState(commandType: CommandType): ConversationState {
    switch (commandType) {
      case 'create':
        return 'awaiting_circle_name';
      default:
        return 'idle';
    }
  }

  /**
   * 📍 STATE TRANSITIONS: Get state for specific step
   */
  private getStateForStep(commandType: CommandType, stepIndex: number): ConversationState {
    if (commandType === 'create') {
      const states: ConversationState[] = [
        'awaiting_circle_name',
        'awaiting_circle_amount',
        'awaiting_circle_duration',
        'awaiting_confirmation',
      ];
      return states[stepIndex] || 'awaiting_confirmation';
    }
    
    return 'idle';
  }

  /**
   * 📢 PROMPT: Get next prompt for user
   */
  public getNextPrompt(phoneNumber: string): string {
    const flow = this.activeFlows.get(phoneNumber);
    if (!flow || !flow.currentCommand) {
      return 'No active conversation found. Type /help for available commands.';
    }

    const command = this.getMultiStepCommand(flow.currentCommand);
    if (!command) {
      return 'Invalid conversation state. Type /help for available commands.';
    }

    const currentStep = command.steps[flow.stepIndex];
    if (!currentStep) {
      return 'Conversation completed. Type /help for available commands.';
    }

    // Handle dynamic prompts
    if (typeof currentStep.prompt === 'function') {
      return currentStep.prompt(flow.collectedData);
    }
    
    return currentStep.prompt;
  }

  /**
   * 🧹 CLEANUP: Remove expired conversations
   */
  private cleanupExpiredFlows(): void {
    const now = new Date();
    let cleanedCount = 0;

    for (const [phoneNumber, flow] of this.activeFlows.entries()) {
      if (now > flow.expiresAt) {
        this.activeFlows.delete(phoneNumber);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} expired conversation flows`);
    }
  }

  /**
   * 📊 STATS: Get service statistics
   */
  public getStats(): {
    activeFlows: number;
    flowsByCommand: Record<string, number>;
    memoryUsage: string;
  } {
    const flowsByCommand: Record<string, number> = {};
    
    for (const flow of this.activeFlows.values()) {
      const command = flow.currentCommand || 'unknown';
      flowsByCommand[command] = (flowsByCommand[command] || 0) + 1;
    }

    return {
      activeFlows: this.activeFlows.size,
      flowsByCommand,
      memoryUsage: 'In-memory only',
    };
  }
}

// Export singleton instance
export const conversationFlow = WhatsAppConversationFlowService.getInstance(); 