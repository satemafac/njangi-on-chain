export type CommandType = 
  | 'auth' 
  | 'help' 
  | 'status' 
  | 'create' 
  | 'join' 
  | 'contribute' 
  | 'withdraw' 
  | 'circles' 
  | 'balance'
  | 'rotate'
  | 'leave'
  | 'invite'
  | 'settings'
  | 'yield'
  | 'history';

export interface ParsedCommand {
  type: CommandType;
  rawText: string;
  parameters: Record<string, unknown>;
  isValid: boolean;
  errors: string[];
  requiresAuth: boolean;
  requiresMultiStep: boolean;
}

// Command-specific parameter interfaces
export interface CreateCircleParams {
  circleType: 'rotational' | 'smart-goal';
  currency: string;
  name: string;
  contributionAmount: number;
  cycleLength: 'weekly' | 'bi-weekly' | 'monthly' | 'quarterly';
  cycleDay: string | number; // weekday name or day of month
  securityDeposit: number;
  maxMembers: number;
  penaltyRules: {
    latePayment: boolean;
    missedMeeting: boolean;
  };
  confirmation?: string;
}

export interface JoinCircleParams {
  circleId: string;
  inviteCode?: string;
}

export interface ContributeParams {
  amount: number;
  currency: string;
  circleId?: string; // Optional if user is in only one circle
}

export interface WithdrawParams {
  amount?: number; // Optional for full withdrawal
  currency?: string;
  circleId?: string;
}

export interface InviteParams {
  phoneNumber: string;
  circleId?: string;
  message?: string;
}

export interface StatusParams {
  circleId?: string; // Optional for specific circle status
  detailed?: boolean;
}

// Conversation flow types
export type ConversationState = 
  | 'idle'
  | 'awaiting_circle_name'
  | 'awaiting_circle_amount'
  | 'awaiting_circle_duration'
  | 'awaiting_contribution_amount'
  | 'awaiting_confirmation'
  | 'awaiting_circle_selection'
  | 'awaiting_invite_phone'
  | 'processing_transaction';

export interface ConversationFlow {
  phoneNumber: string;
  state: ConversationState;
  currentCommand: CommandType | null;
  stepIndex: number;
  collectedData: Record<string, unknown>;
  startedAt: Date;
  lastActivity: Date;
  expiresAt: Date;
  retryCount: number;
}

export interface ConversationStep {
  key: string;
  prompt: string | ((data: Record<string, unknown>) => string);
  validator: (input: string, data?: Record<string, unknown>) => { isValid: boolean; value?: unknown; error?: string };
  optional?: boolean;
  retryPrompt?: string;
}

// Multi-step command definitions
export interface MultiStepCommand {
  type: CommandType;
  steps: ConversationStep[];
  confirmationPrompt?: string;
  successMessage: (data: Record<string, unknown>) => string;
  timeoutMinutes: number;
}

// Command aliases and shortcuts
export interface CommandAlias {
  alias: string;
  command: CommandType;
  parameters?: Record<string, unknown>;
}

// Command validation rules
export interface CommandValidation {
  requiresAuth: boolean;
  requiresActiveCircle?: boolean;
  rateLimitWindow?: number; // seconds
  rateLimitCount?: number;
  minimumAmount?: number;
  maximumAmount?: number;
  allowedCurrencies?: string[];
}

// Command execution context
export interface CommandContext {
  phoneNumber: string;
  suiAddress?: string;
  isAuthenticated: boolean;
  activeCircles: string[];
  currentFlow?: ConversationFlow;
  command: ParsedCommand;
  timestamp: Date;
}

// Command execution result
export interface CommandResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  requiresFollowUp?: boolean;
  nextState?: ConversationState;
  transactionId?: string;
  error?: string;
}

// Built-in command patterns
export const COMMAND_PATTERNS = {
  // Basic commands
  AUTH: /^\/auth$/i,
  HELP: /^\/help$/i,
  STATUS: /^\/status$/i,
  CIRCLES: /^\/circles$/i,
  BALANCE: /^\/balance$/i,
  
  // Circle management
  CREATE: /^\/create(?:\s+(.+))?$/i,
  JOIN: /^\/join\s+([a-zA-Z0-9\-]+)(?:\s+(.+))?$/i,
  LEAVE: /^\/leave(?:\s+([a-zA-Z0-9\-]+))?$/i,
  
  // Financial operations
  CONTRIBUTE: /^\/contribute\s+(\d+(?:\.\d+)?)\s*([A-Z]+)?(?:\s+to\s+([a-zA-Z0-9\-]+))?$/i,
  WITHDRAW: /^\/withdraw(?:\s+(\d+(?:\.\d+)?)\s*([A-Z]+)?)?(?:\s+from\s+([a-zA-Z0-9\-]+))?$/i,
  
  // Social features
  INVITE: /^\/invite\s+(\+?[\d\s\-\(\)]+)(?:\s+to\s+([a-zA-Z0-9\-]+))?$/i,
  
  // Advanced features
  YIELD: /^\/yield(?:\s+([a-zA-Z0-9\-]+))?$/i,
  HISTORY: /^\/history(?:\s+([a-zA-Z0-9\-]+))?(?:\s+(\d+))?$/i,
  ROTATE: /^\/rotate(?:\s+([a-zA-Z0-9\-]+))?$/i,
  SETTINGS: /^\/settings(?:\s+([a-zA-Z0-9\-]+))?$/i,
} as const;

// Command aliases for user convenience
export const COMMAND_ALIASES: CommandAlias[] = [
  { alias: '/c', command: 'contribute' },
  { alias: '/w', command: 'withdraw' },
  { alias: '/j', command: 'join' },
  { alias: '/s', command: 'status' },
  { alias: '/h', command: 'help' },
  { alias: '/b', command: 'balance' },
  { alias: '/i', command: 'invite' },
  { alias: '/new', command: 'create' },
  { alias: '/add', command: 'contribute' },
  { alias: '/pay', command: 'contribute' },
  { alias: '/send', command: 'contribute' },
  { alias: '/quit', command: 'leave' },
  { alias: '/exit', command: 'leave' },
];

// Error messages
export const COMMAND_ERRORS = {
  UNKNOWN_COMMAND: 'Unknown command. Type /help for available commands.',
  AUTHENTICATION_REQUIRED: 'Please authenticate first by typing /auth',
  INVALID_AMOUNT: 'Please enter a valid amount (e.g., 100, 50.5)',
  INVALID_CURRENCY: 'Supported currencies: USDC, USDT, SUI',
  INVALID_PHONE: 'Please enter a valid phone number (e.g., +1234567890)',
  INVALID_CIRCLE_ID: 'Please enter a valid circle ID',
  CIRCLE_NOT_FOUND: 'Circle not found or you don\'t have access',
  INSUFFICIENT_BALANCE: 'Insufficient balance for this operation',
  RATE_LIMIT_EXCEEDED: 'Too many requests. Please wait before trying again.',
  CONVERSATION_TIMEOUT: 'Operation timed out. Please start over.',
  TRANSACTION_FAILED: 'Transaction failed. Please try again.',
  VALIDATION_FAILED: 'Invalid input. Please check your command and try again.',
} as const;

// Success messages
export const COMMAND_SUCCESS = {
  AUTHENTICATED: '✅ Successfully authenticated! You can now use all circle features.',
  CIRCLE_CREATED: '🎉 Circle created successfully!',
  CIRCLE_JOINED: '✅ Successfully joined circle!',
  CONTRIBUTION_SENT: '💰 Contribution sent successfully!',
  WITHDRAWAL_COMPLETE: '✅ Withdrawal completed!',
  INVITATION_SENT: '📤 Invitation sent successfully!',
  SETTINGS_UPDATED: '⚙️ Settings updated!',
} as const; 